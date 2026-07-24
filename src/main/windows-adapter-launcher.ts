import { spawn, type SpawnOptions } from "node:child_process";
import {
  WINDOWS_ADAPTER_LAUNCHER_SEPARATOR,
  WINDOWS_ADAPTER_LAUNCHER_SWITCH,
} from "./launch-command";

export type WindowsAdapterLaunchRequest = {
  adapterPath: string;
  env: NodeJS.ProcessEnv;
};

type LauncherChild = {
  once(event: "error", listener: (error: Error) => void): LauncherChild;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): LauncherChild;
};

type SpawnLauncher = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => LauncherChild;

export function parseWindowsAdapterLaunchRequest(
  argv: readonly string[] = process.argv,
  platform: NodeJS.Platform = process.platform,
): WindowsAdapterLaunchRequest | null {
  if (platform !== "win32") return null;
  const launcherIndex = argv.indexOf(WINDOWS_ADAPTER_LAUNCHER_SWITCH);
  if (launcherIndex < 0) return null;

  const launcherArgs = argv.slice(launcherIndex + 1);
  const separatorIndex = launcherArgs.indexOf(WINDOWS_ADAPTER_LAUNCHER_SEPARATOR);
  if (separatorIndex < 0 || separatorIndex !== launcherArgs.length - 2) {
    throw new Error("Invalid Windows adapter launcher arguments.");
  }

  const env: NodeJS.ProcessEnv = {};
  for (const entry of launcherArgs.slice(0, separatorIndex)) {
    const equalsIndex = entry.indexOf("=");
    const key = entry.slice(0, equalsIndex);
    if (equalsIndex < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error("Invalid Windows adapter launcher environment.");
    }
    env[key] = entry.slice(equalsIndex + 1);
  }

  const adapterPath = launcherArgs[separatorIndex + 1];
  if (!adapterPath) throw new Error("Missing Windows adapter path.");
  return { adapterPath, env };
}

export async function runWindowsAdapterLauncher(
  request: WindowsAdapterLaunchRequest,
  options: {
    executable?: string;
    baseEnv?: NodeJS.ProcessEnv;
    spawnProcess?: SpawnLauncher;
  } = {},
): Promise<number> {
  const executable = options.executable ?? process.execPath;
  const spawnProcess = options.spawnProcess ?? spawn;
  const child = spawnProcess(executable, [request.adapterPath], {
    env: { ...(options.baseEnv ?? process.env), ...request.env },
    stdio: "inherit",
    windowsHide: true,
  });

  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
