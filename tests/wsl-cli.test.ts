import { describe, expect, it, vi } from "vitest";
import { decodeWslListOutput, listWslDistributions, validateWslLaunch, windowsPathToWsl } from "../src/main/wsl-cli";
import { resolveDriverSpawn } from "../src/adapters/shared/platform-spawn";

describe("WSL CLI bridge boundaries", () => {
  it("translates drive-letter workspaces without shell text", () => {
    expect(windowsPathToWsl("C:\\Work\\baby-menu")).toBe("/mnt/c/Work/baby-menu");
    const launch = resolveDriverSpawn("claude", ["--json"], {
      platform: "win32",
      cwd: "C:\\Work\\baby-menu",
      env: { BABY_MENU_CLI_MODE: "wsl", BABY_MENU_WSL_DISTRIBUTION: "Ubuntu" },
    });
    expect(launch).toMatchObject({
      command: "wsl.exe",
      args: ["--distribution", "Ubuntu", "--cd", "/mnt/c/Work/baby-menu", "--exec", "/bin/bash", "-lic", 'exec "$0" "$@"', "claude", "--json"],
    });
    expect(launch.args.join(" ")).not.toContain("|");
  });

  it("rejects UNC paths instead of guessing a WSL mapping", () => {
    expect(windowsPathToWsl("\\\\server\\share\\workspace")).toBeNull();
  });

  it("decodes the UTF-16LE distribution inventory emitted by wsl.exe", async () => {
    const stdout = Buffer.from("\uFEFFUbuntu\r\nDebian\r\n", "utf16le");
    expect(decodeWslListOutput(stdout)).toBe("Ubuntu\r\nDebian\r\n");
    await expect(listWslDistributions(async () => ({ status: 0, stdout }))).resolves.toEqual({
      ok: true,
      distributions: ["Ubuntu", "Debian"],
    });
  });

  it("validates workspace access before probing the provider", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ status: 0, stdout: Buffer.from("Ubuntu\n") })
      .mockResolvedValueOnce({ status: 1, stdout: Buffer.alloc(0) });

    await expect(validateWslLaunch("Ubuntu", "codex", "C:\\Work\\baby-menu", run)).resolves.toContain("cannot access this workspace");
    expect(run).toHaveBeenNthCalledWith(2, ["--distribution", "Ubuntu", "--cd", "/mnt/c/Work/baby-menu", "--exec", "true"]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("probes the provider from the validated workspace", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ status: 0, stdout: Buffer.from("Ubuntu\n") })
      .mockResolvedValueOnce({ status: 0, stdout: Buffer.alloc(0) })
      .mockResolvedValueOnce({ status: 0, stdout: Buffer.from("/usr/bin/claude\n") });

    await expect(validateWslLaunch("Ubuntu", "claude", "D:\\workspace", run)).resolves.toBeNull();
    expect(run).toHaveBeenNthCalledWith(3, [
      "--distribution",
      "Ubuntu",
      "--cd",
      "/mnt/d/workspace",
      "--exec",
      "/bin/bash",
      "-lic",
      'command -v "$0" >/dev/null 2>&1',
      "claude",
    ]);
  });

  it("uses a login-shell PATH without interpolating provider text", () => {
    const launch = resolveDriverSpawn("codex", ["--model", "login-only"], {
      platform: "win32",
      cwd: "C:\\workspace",
      env: { BABY_MENU_CLI_MODE: "wsl", BABY_MENU_WSL_DISTRIBUTION: "Ubuntu" },
    });
    expect(launch.args).toContain("/bin/bash");
    expect(launch.args).toContain('exec "$0" "$@"');
    expect(launch.args).toContain("codex");
    expect(launch.args.join(" ")).not.toContain("login-only".replace("login-only", ";"));
  });

  it("keeps hostile distribution names as an argument boundary", () => {
    const launch = resolveDriverSpawn("codex", [], {
      platform: "win32",
      cwd: "D:\\workspace",
      env: { BABY_MENU_CLI_MODE: "wsl", BABY_MENU_WSL_DISTRIBUTION: "Ubuntu; echo bad" },
    });
    expect(launch.args).toContain("Ubuntu; echo bad");
    expect(launch.command).toBe("wsl.exe");
  });
});
