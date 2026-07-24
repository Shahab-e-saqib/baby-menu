export const ADAPTER_LAUNCHER_PID_ENV = "BABY_MENU_ADAPTER_LAUNCHER_PID";
export const ADAPTER_LAUNCHER_WATCH_INTERVAL_MS = 250;

type WatchdogTimer = {
  unref?: () => unknown;
};

export type LauncherWatchdogOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isProcessAlive?: (pid: number) => boolean;
  schedule?: (callback: () => void, intervalMs: number) => WatchdogTimer;
  cancel?: (timer: WatchdogTimer) => void;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startAdapterLauncherWatchdog(
  onLauncherExit: () => void,
  options: LauncherWatchdogOptions = {},
): () => void {
  if ((options.platform ?? process.platform) !== "win32") return () => undefined;

  const rawPid = (options.env ?? process.env)[ADAPTER_LAUNCHER_PID_ENV];
  const launcherPid = Number(rawPid);
  if (!Number.isInteger(launcherPid) || launcherPid <= 0 || launcherPid === process.pid) {
    return () => undefined;
  }

  const alive = options.isProcessAlive ?? isProcessAlive;
  const schedule =
    options.schedule ??
    ((callback: () => void, intervalMs: number) =>
      setInterval(callback, intervalMs));
  const cancel =
    options.cancel ??
    ((timer: WatchdogTimer) =>
      clearInterval(timer as ReturnType<typeof setInterval>));
  let stopped = false;
  let notified = false;
  let timer: WatchdogTimer | null = null;

  const check = () => {
    if (stopped || notified || alive(launcherPid)) return;
    notified = true;
    if (timer) cancel(timer);
    onLauncherExit();
  };

  timer = schedule(check, ADAPTER_LAUNCHER_WATCH_INTERVAL_MS);
  timer.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer) cancel(timer);
  };
}
