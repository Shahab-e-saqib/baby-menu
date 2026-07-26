import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  quoteWindowsBatchArgument,
  quoteWindowsBatchExecutable,
  resolveDriverCommand,
  resolveDriverSpawn,
  WINDOWS_BATCH_EXECUTABLE_ENV,
} from "../src/adapters/shared/platform-spawn";

// A fake Windows filesystem: only the listed absolute paths "exist".
function fakeExists(existing: Set<string>) {
  return (path: string) => existing.has(path);
}

const WIN_ENV = {
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  PATH: "C:\\Windows\\System32;C:\\Program Files\\nodejs;C:\\Users\\dev\\AppData\\Roaming\\npm",
};

describe("resolveDriverCommand", () => {
  it("returns the command unchanged on POSIX (spawn resolves PATH)", () => {
    expect(resolveDriverCommand("claude", { platform: "darwin", env: { PATH: "/usr/bin" } })).toBe("claude");
    expect(resolveDriverCommand("claude", { platform: "linux", env: { PATH: "/usr/bin" } })).toBe("claude");
  });

  it("resolves a bare command to its .cmd shim on Windows via PATHEXT", () => {
    const exists = fakeExists(new Set(["C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd"]));
    expect(resolveDriverCommand("claude", { platform: "win32", env: WIN_ENV, existsSync: exists })).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
    );
  });

  it("prefers an earlier PATHEXT extension when multiple exist", () => {
    const exists = fakeExists(
      new Set(["C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.exe", "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd"]),
    );
    // .COM;.EXE;.BAT;.CMD -> .exe wins over .cmd in the same directory.
    expect(resolveDriverCommand("claude", { platform: "win32", env: WIN_ENV, existsSync: exists })).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.exe",
    );
  });

  it("searches each PATH directory in order", () => {
    const exists = fakeExists(new Set(["C:\\Program Files\\nodejs\\codex.cmd"]));
    expect(resolveDriverCommand("codex", { platform: "win32", env: WIN_ENV, existsSync: exists })).toBe(
      "C:\\Program Files\\nodejs\\codex.cmd",
    );
  });

  it("resolves an absolute command directly using PATHEXT when it has no extension", () => {
    const exists = fakeExists(new Set(["C:\\tools\\codex.exe"]));
    expect(resolveDriverCommand("C:\\tools\\codex", { platform: "win32", env: WIN_ENV, existsSync: exists })).toBe(
      "C:\\tools\\codex.exe",
    );
  });

  it("keeps an absolute command with an extension as-is when it exists", () => {
    const exists = fakeExists(new Set(["C:\\Program Files\\App\\app.exe"]));
    expect(resolveDriverCommand("C:\\Program Files\\App\\app.exe", { platform: "win32", env: WIN_ENV, existsSync: exists })).toBe(
      "C:\\Program Files\\App\\app.exe",
    );
  });

  it("returns the original command when nothing resolves so spawn surfaces ENOENT", () => {
    const exists = fakeExists(new Set());
    expect(resolveDriverCommand("claude", { platform: "win32", env: WIN_ENV, existsSync: exists })).toBe("claude");
  });

  it("handles non-ASCII directory names", () => {
    const env = { PATHEXT: ".CMD;.EXE", PATH: "C:\\Users\\José\\bin" };
    const exists = fakeExists(new Set(["C:\\Users\\José\\bin\\claude.cmd"]));
    expect(resolveDriverCommand("claude", { platform: "win32", env, existsSync: exists })).toBe(
      "C:\\Users\\José\\bin\\claude.cmd",
    );
  });
});

describe("resolveDriverSpawn", () => {
  it("preserves the POSIX command, arguments, and direct-spawn options", () => {
    expect(resolveDriverSpawn("/usr/local/bin/claude", ["--model", "opus"], { platform: "darwin" })).toEqual({
      command: "/usr/local/bin/claude",
      args: ["--model", "opus"],
      options: {},
    });
  });

  it("gives a resolved batch invocation its own cmd.exe quoting boundary", () => {
    const command = "C:\\Users\\First Last\\%Tools% & More\\claude.cmd";
    const env = {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".CMD;.EXE",
      PATH: "C:\\Users\\First Last\\%Tools% & More",
    };
    const exists = fakeExists(new Set([command]));

    expect(resolveDriverSpawn("claude", ["--model", "opus"], { platform: "win32", env, existsSync: exists })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `""%${WINDOWS_BATCH_EXECUTABLE_ENV}%" ^"--model^" ^"opus^""`,
      ],
      options: { windowsHide: true, windowsVerbatimArguments: true },
      env: { [WINDOWS_BATCH_EXECUTABLE_ENV]: command },
    });
  });

  it("encodes hostile batch arguments inside their cmd.exe token", () => {
    const hostileModel = "x & echo injected > file &";
    const launch = resolveDriverSpawn("C:\\bin\\codex.cmd", ["exec", "--model", hostileModel], {
      platform: "win32",
      env: {},
      existsSync: fakeExists(new Set(["C:\\bin\\codex.cmd"])),
    });

    expect(quoteWindowsBatchArgument(hostileModel)).toBe(
      '^"x^ ^&^ echo^ injected^ ^>^ file^ ^&^"',
    );
    expect(launch.args).toEqual([
      "/d",
      "/s",
      "/c",
      `""%${WINDOWS_BATCH_EXECUTABLE_ENV}%" ^"exec^" ^"--model^" ^"x^ ^&^ echo^ injected^ ^>^ file^ ^&^""`,
    ]);
    expect(launch.args[3]).not.toContain(hostileModel);
  });

  it("quotes explicit batch paths and leaves native executables direct", () => {
    expect(quoteWindowsBatchExecutable("C:\\Program Files\\agent.bat")).toBe(
      '"C:\\Program Files\\agent.bat"',
    );
    expect(
      resolveDriverSpawn("C:\\Program Files\\agent.exe", ["--model", "opus"], {
        platform: "win32",
        existsSync: fakeExists(new Set(["C:\\Program Files\\agent.exe"])),
      }),
    ).toEqual({
      command: "C:\\Program Files\\agent.exe",
      args: ["--model", "opus"],
      options: {},
    });
  });

  it.skipIf(process.platform !== "win32")(
    "passes a hostile batch argument verbatim without executing it",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "baby-menu-batch-"));
      const commandDir = join(root, "First Last", "%Tools% & More");
      const command = join(commandDir, "agent.cmd");
      const script = join(commandDir, "agent.mjs");
      const injected = join(root, "injected.txt");
      const hostileModel = `x & echo injected > "${injected}" &`;
      await mkdir(commandDir, { recursive: true });
      await writeFile(command, '@echo off\r\nnode "%~dp0agent.mjs" %*\r\n');
      await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");

      try {
        const expectedArgs = ["exec", "--model", hostileModel];
        const launch = resolveDriverSpawn(command, expectedArgs, { platform: "win32" });
        const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(launch.command, launch.args, {
            env: { ...process.env, ...launch.env },
            stdio: ["ignore", "pipe", "pipe"],
            ...launch.options,
          });
          let stdout = "";
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.once("error", reject);
          child.once("close", (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`batch fixture exited ${code ?? "unknown"}`));
          });
        });
        expect(JSON.parse(output)).toEqual(expectedArgs);
        expect(existsSync(injected)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
