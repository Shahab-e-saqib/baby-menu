import { delimiter } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

type MergeShellPathOptions = {
  /** Current PATH value to merge into. Defaults to process.env.PATH. */
  currentPath?: string;
  /** Home directory used for `~/.local/bin`. Defaults to os.homedir(). */
  homeDir?: string;
  /** Extra PATH captured from a login shell (macOS/Linux only). */
  shellPath?: string;
  /** Platform to merge for; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** PATH delimiter (`:` POSIX / `;` Windows). Defaults to path.delimiter. */
  pathDelimiter?: string;
};

// GUI-launched apps on macOS receive a minimal PATH (often just /usr/bin:/bin),
// so the bundled agent CLIs (Homebrew, ~/.local/bin, asdf, etc.) are invisible.
// These common Unix directories are appended so a tray-launched app still finds
// `claude`/`codex`. They must never be merged on Windows: Windows uses `;`, a
// different set of directories, and a trailing `:`-delimited segment silently
// corrupts the final real PATH entry (see tests/shell-path.test.ts).
const COMMON_GUI_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * Builds a PATH that lets a GUI-launched app find the bundled agent CLIs.
 *
 * POSIX (darwin/linux): appends the common Unix GUI directories, the user's
 * `~/.local/bin`, and any PATH captured from a login shell, then de-duplicates
 * while preserving order. This is the historical behavior.
 *
 * Windows: the inherited PATH is returned unchanged. A GUI-launched Win32 app
 * already inherits the merged system+user PATH from the registry, and merging
 * Unix directories or a Unix delimiter would corrupt the final usable entry.
 * If a future packaged GUI launch proves a user/machine PATH merge is needed,
 * add it here as a Windows-specific branch that reads the registry - never as a
 * Unix-style append.
 */
export function mergeShellPath(options: MergeShellPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const pathDelimiter = options.pathDelimiter ?? delimiter;
  const currentPath = options.currentPath ?? process.env.PATH ?? "";

  if (platform === "win32") {
    return currentPath;
  }

  const homeDir = options.homeDir ?? homedir();
  const segments = [
    ...splitPath(currentPath, pathDelimiter),
    ...COMMON_GUI_PATHS,
    `${homeDir}/.local/bin`,
    ...splitPath(options.shellPath ?? "", pathDelimiter),
  ];

  return [...new Set(segments.map((segment) => segment.trim()).filter(Boolean))].join(pathDelimiter);
}

function splitPath(value: string, pathDelimiter: string): string[] {
  return value.length === 0 ? [] : value.split(pathDelimiter);
}

/**
 * Reads $PATH from a login zsh so a GUI launch picks up PATH additions the user
 * made in their shell profile (Homebrew, asdf, Volta, etc.). Unix-only: there is
 * no equivalent single-shell probe on Windows, and the inherited PATH is already
 * complete there.
 */
export function readLoginShellPath(): string | undefined {
  if (process.platform === "win32") return undefined;
  const result = spawnSync("/bin/zsh", ["-lc", "print -r -- $PATH"], {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

/**
 * Expands process.env.PATH for a GUI launch in place and returns the new value.
 * No-op on Windows (the inherited PATH is already complete); merges common Unix
 * directories plus the login-shell PATH on macOS/Linux.
 */
export function expandProcessPathForGuiLaunch(): string {
  process.env.PATH = mergeShellPath({ currentPath: process.env.PATH, shellPath: readLoginShellPath() });
  return process.env.PATH;
}
