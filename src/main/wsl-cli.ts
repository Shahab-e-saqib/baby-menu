import { spawn } from "node:child_process";
export type WslProvider = "claude" | "codex";
export type WslProbe = { ok: true; distributions: string[] } | { ok: false; reason: "unavailable" | "invalid" };
type WslRunResult = { status: number | null; stdout: Buffer; error?: Error };
type WslRunner = (args: string[]) => Promise<WslRunResult>;

const WSL_PROBE_TIMEOUT_MS = 10_000;
const WSL_STDOUT_LIMIT = 64 * 1024;

export function windowsPathToWsl(path: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    const drive = path[0]!.toLowerCase();
    const rest = path.slice(3).replaceAll("\\", "/");
    return `/mnt/${drive}/${rest}`;
  }
  if (/^\\\\|^\/\//.test(path)) return null;
  return path.startsWith("/") ? path : null;
}

function runWsl(args: string[]): Promise<WslRunResult> {
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let stdoutLength = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (result: WslRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutLength >= WSL_STDOUT_LIMIT) return;
      const remaining = WSL_STDOUT_LIMIT - stdoutLength;
      const bounded = chunk.subarray(0, remaining);
      chunks.push(bounded);
      stdoutLength += bounded.length;
    });
    child.on("error", (error) => finish({ status: null, stdout: Buffer.concat(chunks), error }));
    child.on("close", (status) => finish({ status, stdout: Buffer.concat(chunks) }));
    timeout = setTimeout(() => {
      child.kill();
      finish({ status: null, stdout: Buffer.concat(chunks) });
    }, WSL_PROBE_TIMEOUT_MS);
  });
}

export function decodeWslListOutput(stdout: Buffer): string {
  const pairs = Math.floor(stdout.length / 2);
  let zeroHighBytes = 0;
  for (let index = 1; index < stdout.length; index += 2) {
    if (stdout[index] === 0) zeroHighBytes += 1;
  }
  const utf16 = (stdout[0] === 0xff && stdout[1] === 0xfe) || (pairs > 0 && zeroHighBytes / pairs > 0.3);
  return stdout.toString(utf16 ? "utf16le" : "utf8").replace(/^\uFEFF/, "").replaceAll("\0", "");
}

export async function listWslDistributions(run: WslRunner = runWsl): Promise<WslProbe> {
  const result = await run(["--list", "--quiet"]);
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { ok: false, reason: "unavailable" };
  if (result.status !== 0) return { ok: false, reason: "invalid" };
  const distributions = decodeWslListOutput(result.stdout)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\*\s*/, "").trim())
    .filter(Boolean);
  return distributions.length ? { ok: true, distributions } : { ok: false, reason: "invalid" };
}

export async function validateWslLaunch(distribution: string, provider: WslProvider, cwd: string, run: WslRunner = runWsl): Promise<string | null> {
  const linuxCwd = windowsPathToWsl(cwd);
  if (!linuxCwd) return "The selected WSL mode cannot represent this workspace path. Switch to Native mode for this workspace.";
  const probe = await listWslDistributions(run);
  if (!probe.ok) return "WSL is unavailable. Install or enable WSL, then restart Baby Menu.";
  if (!probe.distributions.includes(distribution)) return `The selected WSL distribution is unavailable. Select an installed distribution, then restart Baby Menu.`;
  const workspace = await run(["--distribution", distribution, "--cd", linuxCwd, "--exec", "true"]);
  if (workspace.status !== 0) return "The selected WSL distribution cannot access this workspace. Switch to Native mode or enable the workspace mount in WSL.";
  const providerProbe = await run(["--distribution", distribution, "--cd", linuxCwd, "--exec", "which", provider]);
  if (providerProbe.status !== 0) return `${provider === "claude" ? "Claude Code" : "Codex"} CLI was not found inside the selected WSL distribution. Install it there, then restart Baby Menu.`;
  return null;
}

export function wslSpawnEnvironment(distribution: string): Record<string, string> {
  return { BABY_MENU_CLI_MODE: "wsl", BABY_MENU_WSL_DISTRIBUTION: distribution };
}
