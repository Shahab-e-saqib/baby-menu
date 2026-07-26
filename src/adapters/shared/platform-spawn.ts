// Windows-aware spawning for the bundled adapter drivers.
//
// The claude/codex drivers spawn the real CLI by bare name (`claude`/`codex`).
// On Windows an npm global install is almost always a `claude.cmd`/`codex.cmd`
// shim, and Node cannot launch a `.cmd`/`.bat` without a shell (since
// CVE-2024-27980, Node rejects `.bat`/`.cmd` spawns without `shell: true`).
// acpx already handles this for ITS spawns; these helpers give the drivers the
// same PATHEXT-aware resolution and `.cmd` shell selection.
import { existsSync } from "node:fs";
import { win32 as win32Path } from "node:path";

export type ResolveCommandOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
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
  return `"${escaped}"`.replace(WINDOWS_CMD_META_CHARS, "^$1");
}

export function resolveDriverSpawn(
  command: string,
  args: readonly string[],
  options: ResolveCommandOptions = {},
): DriverSpawnSpec {
  const platform = options.platform ?? process.platform;
  const resolved = resolveDriverCommand(command, options);
  if (platform !== "win32") return { command: resolved, args: [...args], options: {} };
  const ext = win32Path.extname(resolved).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const env = options.env ?? process.env;
    const shellCommand = [
      quoteWindowsBatchExecutable(`%${WINDOWS_BATCH_EXECUTABLE_ENV}%`),
      ...args.map(quoteWindowsBatchArgument),
    ].join(" ");
    return {
      command: readEnvValue(env, "COMSPEC") ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${shellCommand}"`],
      options: { windowsHide: true, windowsVerbatimArguments: true },
      env: { [WINDOWS_BATCH_EXECUTABLE_ENV]: resolved },
    };
  }
  return { command: resolved, args: [...args], options: {} };
}
