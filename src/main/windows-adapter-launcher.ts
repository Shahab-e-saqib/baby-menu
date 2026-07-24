import { spawn, type SpawnOptions } from "node:child_process";
import {
  createChildTerminator,
  TERMINATION_GRACE_MS,
  type ChildTerminator,
  type TerminableChild,
} from "../adapters/shared/process-tree";
import { ADAPTER_LAUNCHER_PID_ENV } from "../adapters/shared/launcher-lifecycle";
import {
  WINDOWS_ADAPTER_LAUNCHER_SEPARATOR,
  WINDOWS_ADAPTER_LAUNCHER_SWITCH,
} from "./launch-command";

export type WindowsAdapterLaunchRequest = {
  adapterPath: string;
  env: NodeJS.ProcessEnv;
};

type LauncherChild = TerminableChild & {
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

type LauncherLifecycle = {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
};

type ScheduleForce = (callback: () => void) => () => void;

function scheduleForce(callback: () => void): () => void {
  const timer = setTimeout(callback, TERMINATION_GRACE_MS);
  timer.unref();
  return () => clearTimeout(timer);
}

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
    launcherPid?: number;
    lifecycle?: LauncherLifecycle;
    createTerminator?: (child: TerminableChild) => ChildTerminator;
    scheduleForce?: ScheduleForce;
  } = {},
): Promise<number> {
  const executable = options.executable ?? process.execPath;
  const spawnProcess: SpawnLauncher =
    options.spawnProcess ??
    ((command, args, spawnOptions) =>
      spawn(command, args, spawnOptions) as LauncherChild);
  const launcherPid = options.launcherPid ?? process.pid;
  const child = spawnProcess(executable, [request.adapterPath], {
    env: {
      ...(options.baseEnv ?? process.env),
      ...request.env,
      [ADAPTER_LAUNCHER_PID_ENV]: String(launcherPid),
    },
    stdio: "inherit",
    windowsHide: true,
  });
  const terminator =
    options.createTerminator?.(child) ??
    createChildTerminator(child, { strategy: "windows-taskkill" });
  const lifecycle =
    options.lifecycle ??
    (process as unknown as LauncherLifecycle);
  const scheduleTerminationForce = options.scheduleForce ?? scheduleForce;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let settled = false;
  let terminating = false;
  let cancelForce: (() => void) | null = null;

  const onSignal = () => {
    if (settled || terminating) return;
    terminating = true;
    terminator.terminate();
    cancelForce = scheduleTerminationForce(() => terminator.force());
  };
  const onExit = () => {
    if (!settled) terminator.force();
  };
  const cleanup = () => {
    cancelForce?.();
    for (const signal of signals) lifecycle.off(signal, onSignal);
    lifecycle.off("exit", onExit);
  };

  for (const signal of signals) lifecycle.once(signal, onSignal);
  lifecycle.once("exit", onExit);

  return new Promise<number>((resolve, reject) => {
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminator.force();
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code ?? 1);
    });
  });
}
