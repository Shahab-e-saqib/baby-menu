import { isAbsolute, join } from "node:path";

export const EXTENSIONS_DIR_ENV = "BABY_MENU_EXTENSIONS_DIR";

/**
 * True for a Win32 UNC path (`\\\\server\\share\\...` or `//server/share/...`),
 * excluding the verbatim `\\\\?\\` namespace. Used to detect launches from a
 * network share (e.g. a WSL `\\\\wsl.localhost\\...` path), where Chromium's
 * GPU subprocess cannot start and cmd.exe cannot hold a current directory.
 */
export function isUncPath(path: string): boolean {
  return /^[\\/][\\/][^?\\/]/.test(path);
}

/**
 * True when the running process is on Windows and was launched from a UNC path
 * (executable or current directory). This is the narrow condition under which
 * the packaged app must fall back to software rendering / in-process GPU: the
 * sandboxed GPU child cannot launch from a network share, which otherwise
 * crashes the app at startup (gpu_data_manager_impl_private.cc:417). Native
 * local-drive installs keep full GPU acceleration and the GPU sandbox.
 */
export function isUncWindowsLaunch(
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  cwd: string = process.cwd(),
): boolean {
  return platform === "win32" && (isUncPath(execPath) || isUncPath(cwd));
}

export function getRepoRoot(): string {
  return process.cwd();
}

export function getRecipesDir(rootDir = getRepoRoot()): string {
  return join(getExtensionsDir(rootDir), "recipes");
}

export function getAgentStateDir(rootDir = getRepoRoot()): string {
  return join(rootDir, ".cache", "baby-menu", "acp-sessions");
}

export function getExtensionsDir(
  rootDir = getRepoRoot(),
  env: Partial<Pick<NodeJS.ProcessEnv, typeof EXTENSIONS_DIR_ENV>> = process.env,
): string {
  const configured = env[EXTENSIONS_DIR_ENV];
  if (!configured) return join(rootDir, "extensions");
  return isAbsolute(configured) ? configured : join(rootDir, configured);
}

export function getDevExtensionSnapshotDir(rootDir = getRepoRoot()): string {
  return join(rootDir, ".cache", "baby-menu", "dev-extension-snapshots");
}
