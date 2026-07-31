// Windows-aware spawning for the bundled adapter drivers.
//
// The claude/codex drivers spawn the real CLI by bare name (`claude`/`codex`).
// On Windows an npm global install is almost always a `claude.cmd`/`codex.cmd`
// shim, and Node cannot launch a `.cmd`/`.bat` without a shell (since
// CVE-2024-27980, Node rejects `.bat`/`.cmd` spawns without `shell: true`).
// acpx already handles this for ITS spawns. These helpers give the drivers the
// same PATHEXT-aware resolution, then invoke cmd.exe directly with independently
// quoted arguments instead of interpolating a resolved shim path into raw shell
// command text.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { win32 as win32Path } from "node:path";

/**
 * True for a Win32 UNC path (`\\\\server\\share\\...` or `//server/share/...`),
 * excluding the verbatim `\\\\?\\` namespace. Mirrors src/shared/paths.ts; kept
 * local so the adapter bundle stays self-contained.
 */
function isUncPath(path: string): boolean {
  return /^[\\/][\\/][^?\\/]/.test(path);
}

export type ResolveCommandOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Working directory the driver will spawn into; used to neutralize UNC cwds. */
  cwd?: string;
  /** Injectable for tests; defaults to os.tmpdir. */
  tmpdir?: () => string;
  /** Injectable for tests; defaults to fs.existsSync. */
  existsSync?: (path: string) => boolean;
};

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const matchedKey = Object.keys(env).find((entry) => entry.toUpperCase() === key.toUpperCase());
  return matchedKey ? env[matchedKey] : undefined;
}

function pathextCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const extensions =
    (readEnvValue(env, "PATHEXT") ?? DEFAULT_PATHEXT)
      .split(";")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
  return win32Path.extname(command).length > 0 ? [command] : extensions.map((extension) => `${command}${extension}`);
}

/**
 * Resolves a bare command to a launchable path on Windows using PATHEXT, mirroring
 * acpx's `resolveWindowsCommand`. On POSIX the command is returned unchanged
 * (spawn resolves it via the inherited PATH). Returns the original command when
 * nothing is found so spawn surfaces the real ENOENT instead of a silent skip.
 */
export function resolveDriverCommand(command: string, options: ResolveCommandOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return command;

  const env = options.env ?? process.env;
  const exists = options.existsSync ?? existsSync;
  // Resolution is FOR Windows, so use the win32 path module (backslash joins,
  // drive-letter isAbsolute) regardless of the host running this code. This
  // also keeps the unit tests deterministic on a non-Windows CI host.
  const win = win32Path;
  const candidates =
    win.extname(command).length > 0 ? [command] : pathextCandidates(command, env);

  if (win.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return candidates.find((candidate) => exists(candidate)) ?? command;
  }

  const pathValue = readEnvValue(env, "PATH");
  if (!pathValue) return command;
  for (const directory of pathValue.split(";")) {
    const trimmed = directory.trim();
    if (trimmed.length === 0) continue;
    for (const candidate of candidates) {
      const resolved = win.join(trimmed, candidate);
      if (exists(resolved)) return resolved;
    }
  }
  return command;
}

export type DriverSpawnOptionsResult = {
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
  /** Override cwd for the spawn (used to keep cmd.exe off a UNC cwd). */
  cwd?: string;
};

export type DriverSpawnSpec = {
  command: string;
  args: string[];
  options: DriverSpawnOptionsResult;
  env?: NodeJS.ProcessEnv;
};

export const WINDOWS_BATCH_EXECUTABLE_ENV = "BABY_MENU_DRIVER_BATCH_EXECUTABLE";
const WINDOWS_CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export function quoteWindowsBatchExecutable(command: string): string {
  return `"${command}"`;
}

export function quoteWindowsBatchArgument(argument: string): string {
  let escaped = "";
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      escaped += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    escaped += `${"\\".repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  escaped += "\\".repeat(backslashes * 2);
  const quoted = `"${escaped}"`.replace(WINDOWS_CMD_META_CHARS, "^$1");
  return quoted.replace(WINDOWS_CMD_META_CHARS, "^$1");
}

function quoteWindowsCommandArgument(argument: string): string {
  const quoted = `"${argument}"`;
  return quoted.replace(WINDOWS_CMD_META_CHARS, "^$1");
}

function isSafeWindowsLaunchDirectory(path: string | undefined): path is string {
  return typeof path === "string" && path.length > 0 && win32Path.isAbsolute(path) && !isUncPath(path);
}

function windowsCmdLaunchDirectory(env: NodeJS.ProcessEnv, getTmpdir: () => string): string {
  const candidates = [
    readEnvValue(env, "TEMP"),
    readEnvValue(env, "TMP"),
    getTmpdir(),
    readEnvValue(env, "SYSTEMROOT"),
  ];
  const launchDirectory = candidates.find(isSafeWindowsLaunchDirectory);
  if (!launchDirectory) throw new Error("Cannot launch a Windows batch driver without a safe local directory");
  return launchDirectory;
}

export function resolveDriverSpawn(
  command: string,
  args: readonly string[],
  options: ResolveCommandOptions = {},
): DriverSpawnSpec {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const wslDistribution = env.BABY_MENU_CLI_MODE === "wsl" ? env.BABY_MENU_WSL_DISTRIBUTION?.trim() : undefined;
  if (platform === "win32" && wslDistribution) {
    // Structured wsl.exe arguments keep the distribution, cwd, provider, and
    // provider arguments out of shell text. The host validates all three before
    // the adapter reaches this path.
    const linuxCwd = options.cwd && /^[A-Za-z]:[\\/]/.test(options.cwd)
      ? `/mnt/${options.cwd[0]!.toLowerCase()}/${options.cwd.slice(3).replaceAll("\\", "/")}`
      : options.cwd && /^\//.test(options.cwd) ? options.cwd : undefined;
    if (!linuxCwd) throw new Error("The workspace path cannot be represented inside WSL.");
    return {
      command: "wsl.exe",
      // Direct wsl.exe --exec does not source the distro's login PATH. Use a
      // fixed bash wrapper with positional boundaries so user/provider text is
      // never interpolated into shell code; $0 is the fixed provider command
      // and $@ carries the already-separated provider arguments.
      args: [
        "--distribution",
        wslDistribution,
        "--cd",
        linuxCwd,
        "--exec",
        "/bin/bash",
        "-lic",
        'exec "$0" "$@"',
        command,
        ...args,
      ],
      options: { windowsHide: true },
    };
  }
  const resolved = resolveDriverCommand(command, options);
  if (platform !== "win32") return { command: resolved, args: [...args], options: {} };
  const ext = win32Path.extname(resolved).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const env = options.env ?? process.env;
    const agentCommand = [
      quoteWindowsBatchExecutable(`%${WINDOWS_BATCH_EXECUTABLE_ENV}%`),
      ...args.map(quoteWindowsBatchArgument),
    ].join(" ");
    const spawnOptions: DriverSpawnOptionsResult = { windowsHide: true, windowsVerbatimArguments: true };
    let shellCommand = agentCommand;
    // cmd.exe cannot hold a UNC current directory: it prints "UNC paths are not
    // supported" and silently falls back to C:\Windows, so the agent would run
    // in the wrong directory. When the workspace cwd is UNC (e.g. a WSL
    // \\wsl.localhost\... path), map it to a temporary drive with `pushd` so the
    // agent still runs in the intended workspace, and launch cmd.exe from a
    // non-UNC directory (the OS temp) so it never warns or falls back. pushd
    // failure ("&&") prevents the agent from running in the wrong directory.
    if (typeof options.cwd === "string" && isUncPath(options.cwd)) {
      shellCommand = `pushd ${quoteWindowsCommandArgument(options.cwd)} >nul 2>&1 && ${agentCommand}`;
      spawnOptions.cwd = windowsCmdLaunchDirectory(env, options.tmpdir ?? tmpdir);
    }
    return {
      command: readEnvValue(env, "COMSPEC") ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${shellCommand}"`],
      options: spawnOptions,
      env: { [WINDOWS_BATCH_EXECUTABLE_ENV]: resolved },
    };
  }
  return { command: resolved, args: [...args], options: {} };
}
