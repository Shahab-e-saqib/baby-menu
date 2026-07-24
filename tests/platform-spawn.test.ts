import { describe, expect, it } from "vitest";
import { resolveDriverCommand, driverSpawnOptions } from "../src/adapters/shared/platform-spawn";

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

describe("driverSpawnOptions", () => {
  it("returns no shell on POSIX", () => {
    expect(driverSpawnOptions("claude", { platform: "darwin" })).toEqual({});
    expect(driverSpawnOptions("claude", { platform: "linux" })).toEqual({});
  });

  it("sets shell:true for a resolved .cmd shim on Windows", () => {
    const exists = fakeExists(new Set(["C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd"]));
    expect(driverSpawnOptions("claude", { platform: "win32", env: WIN_ENV, existsSync: exists })).toEqual({ shell: true });
  });

  it("sets shell:true for a .bat shim on Windows", () => {
    const exists = fakeExists(new Set(["C:\\bin\\agent.bat"]));
    expect(driverSpawnOptions("C:\\bin\\agent.bat", { platform: "win32", env: WIN_ENV, existsSync: exists })).toEqual({
      shell: true,
    });
  });

  it("does not set shell for a native .exe on Windows", () => {
    const exists = fakeExists(new Set(["C:\\Program Files\\App\\app.exe"]));
    expect(driverSpawnOptions("C:\\Program Files\\App\\app.exe", { platform: "win32", env: WIN_ENV, existsSync: exists })).toEqual(
      {},
    );
  });

  it("does not set shell when a bare command cannot be resolved (defer to spawn ENOENT)", () => {
    const exists = fakeExists(new Set());
    expect(driverSpawnOptions("claude", { platform: "win32", env: WIN_ENV, existsSync: exists })).toEqual({});
  });
});
