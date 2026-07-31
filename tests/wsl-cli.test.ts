import { describe, expect, it, vi } from "vitest";
import { validateWslLaunch, windowsPathToWsl } from "../src/main/wsl-cli";
import { resolveDriverSpawn } from "../src/adapters/shared/platform-spawn";

describe("WSL CLI bridge boundaries", () => {
  it("translates drive-letter workspaces without shell text", () => {
    expect(windowsPathToWsl("C:\\Work\\baby-menu")).toBe("/mnt/c/Work/baby-menu");
    const launch = resolveDriverSpawn("claude", ["--json"], {
      platform: "win32",
      cwd: "C:\\Work\\baby-menu",
      env: { BABY_MENU_CLI_MODE: "wsl", BABY_MENU_WSL_DISTRIBUTION: "Ubuntu" },
    });
    expect(launch).toMatchObject({ command: "wsl.exe", args: ["--distribution", "Ubuntu", "--cd", "/mnt/c/Work/baby-menu", "--exec", "claude", "--json"] });
    expect(launch.args.join(" ")).not.toContain("|");
  });

  it("rejects UNC paths instead of guessing a WSL mapping", () => {
    expect(windowsPathToWsl("\\\\server\\share\\workspace")).toBeNull();
  });

  it("validates workspace access before probing the provider", () => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: "Ubuntu\n" })
      .mockReturnValueOnce({ status: 1, stdout: "" });

    expect(validateWslLaunch("Ubuntu", "codex", "C:\\Work\\baby-menu", run)).toContain("cannot access this workspace");
    expect(run).toHaveBeenNthCalledWith(2, ["--distribution", "Ubuntu", "--cd", "/mnt/c/Work/baby-menu", "--exec", "true"]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("probes the provider from the validated workspace", () => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: "Ubuntu\n" })
      .mockReturnValueOnce({ status: 0, stdout: "" })
      .mockReturnValueOnce({ status: 0, stdout: "/usr/bin/claude\n" });

    expect(validateWslLaunch("Ubuntu", "claude", "D:\\workspace", run)).toBeNull();
    expect(run).toHaveBeenNthCalledWith(3, ["--distribution", "Ubuntu", "--cd", "/mnt/d/workspace", "--exec", "which", "claude"]);
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
