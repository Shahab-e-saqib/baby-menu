import { spawnSync } from "node:child_process";
export type WslProvider = "claude" | "codex";
export type WslProbe = { ok: true; distributions: string[] } | { ok: false; reason: "unavailable" | "invalid" };
type WslRunResult = { status: number | null; stdout?: string | null; error?: Error };
type WslRunner = (args: string[]) => WslRunResult;

export function windowsPathToWsl(path: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    const drive = path[0]!.toLowerCase();
    const rest = path.slice(3).replaceAll("\\", "/");
    return `/mnt/${drive}/${rest}`;
  }
  if (/^\\\\|^\/\//.test(path)) return null;
  return path.startsWith("/") ? path : null;
}

function runWsl(args: string[]): WslRunResult {
  return spawnSync("wsl.exe", args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
}

export function listWslDistributions(run: WslRunner = runWsl): WslProbe {
  const result = run(["--list", "--quiet"]);
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { ok: false, reason: "unavailable" };
  if (result.status !== 0) return { ok: false, reason: "invalid" };
  const distributions = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\*\s*/, "").trim())
    .filter(Boolean);
  return distributions.length ? { ok: true, distributions } : { ok: false, reason: "invalid" };
}

export function validateWslLaunch(distribution: string, provider: WslProvider, cwd: string, run: WslRunner = runWsl): string | null {
  const linuxCwd = windowsPathToWsl(cwd);
  if (!linuxCwd) return "The selected WSL mode cannot represent this workspace path. Switch to Native mode for this workspace.";
  const probe = listWslDistributions(run);
  if (!probe.ok) return "WSL is unavailable. Install or enable WSL, then restart Baby Menu.";
  if (!probe.distributions.includes(distribution)) return `The selected WSL distribution is unavailable. Select an installed distribution, then restart Baby Menu.`;
  const workspace = run(["--distribution", distribution, "--cd", linuxCwd, "--exec", "true"]);
  if (workspace.status !== 0) return "The selected WSL distribution cannot access this workspace. Switch to Native mode or enable the workspace mount in WSL.";
  const providerProbe = run(["--distribution", distribution, "--cd", linuxCwd, "--exec", "which", provider]);
  if (providerProbe.status !== 0) return `${provider === "claude" ? "Claude Code" : "Codex"} CLI was not found inside the selected WSL distribution. Install it there, then restart Baby Menu.`;
  return null;
}

export function wslSpawnEnvironment(distribution: string): Record<string, string> {
  return { BABY_MENU_CLI_MODE: "wsl", BABY_MENU_WSL_DISTRIBUTION: distribution };
}
