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
  /** Set to true so Node launches a .cmd/.bat shim through cmd.exe on Windows. */
  shell?: boolean;
};

/**
 * Returns the spawn options needed to launch `command` on the current platform.
 * `.cmd`/`.bat` shims require `shell: true` on Windows; everything else (native
 * `.exe`, the bundled Electron, and all POSIX commands) spawns directly so the
 * process-tree terminator and signal handling stay exact.
 */
export function driverSpawnOptions(
  command: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; existsSync?: (path: string) => boolean } = {},
): DriverSpawnOptionsResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return {};
  const resolved = resolveDriverCommand(command, options);
  const ext = win32Path.extname(resolved).toLowerCase();
  return ext === ".cmd" || ext === ".bat" ? { shell: true } : {};
}
