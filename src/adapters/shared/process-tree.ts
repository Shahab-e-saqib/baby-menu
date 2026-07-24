// Bounded, platform-aware child-process termination for the bundled adapter drivers.
//
// The drivers cancel a running CLI turn with SIGTERM, then SIGKILL after a grace
// period. That works on POSIX, where the signal reaches the process and the
// adapter CLIs install handlers. On Windows:
//   - Node's `child.kill("SIGTERM")` maps to TerminateProcess on the IMMEDIATE
//     child only; it is not graceful and it does not reach descendants.
//   - npm `claude.cmd`/`codex.cmd` shims spawn the real CLI (and its tool
//     children) as descendants, so killing the shim leaves the agent alive.
//
// `taskkill /T /F /PID <pid>` is the bounded, injection-safe tree kill: `/T`
// terminates the whole process tree under the pid, `/F` forces it (console CLIs
// have no graceful WM_CLOSE path), and the pid is always a number emitted by
// `String(child.pid)` so no untrusted text reaches the shell. `shell: false`
// (the spawn default) keeps taskkill.exe launched directly, not via cmd.exe.

import { spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";

export type TerminationStrategy = "posix-signals" | "windows-taskkill";

/** The slowest acceptable grace between a soft and a hard termination, in ms. */
export const TERMINATION_GRACE_MS = 1000;
export const TASKKILL_TIMEOUT_MS = 5000;
export const TASKKILL_MAX_ATTEMPTS = 2;

export function selectTerminationStrategy(platform: NodeJS.Platform = process.platform): TerminationStrategy {
  return platform === "win32" ? "windows-taskkill" : "posix-signals";
}

/** Minimal child handle the terminator needs (works for real and fake children). */
export type TerminableChild = Pick<ChildProcess, "pid" | "kill">;

export type ChildTerminator = {
  /** Request termination. On POSIX sends SIGTERM; on Windows runs a bounded tree kill. */
  terminate(): void;
  /** Force termination after the grace period (POSIX SIGKILL; Windows repeats the tree kill). */
  force(): void;
};

export type TaskkillResult = Pick<SpawnSyncReturns<unknown>, "status">;

export type CreateTerminatorOptions = {
  strategy?: TerminationStrategy;
  /**
   * Runs `taskkill` with the given args. Injectable so tests can capture the args
   * without a real Windows host. Defaults to `spawnSync("taskkill", args,
   * { windowsHide: true, shell: false, timeout: TASKKILL_TIMEOUT_MS })`.
   */
  runTaskkill?: (args: string[]) => TaskkillResult;
};

/** Builds the `taskkill` argv for a bounded, injection-safe process-tree kill. */
export function taskkillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

/**
 * Creates a platform-aware terminator for a single child. POSIX behavior is
 * byte-for-byte the historical `child.kill("SIGTERM")` then `child.kill("SIGKILL")`,
 * so existing driver cancellation/disposal tests are unchanged. Windows routes
 * through `taskkill /T /F /PID <pid>` so the whole CLI tree is torn down.
 */
export function createChildTerminator(child: TerminableChild, options: CreateTerminatorOptions = {}): ChildTerminator {
  const strategy = options.strategy ?? selectTerminationStrategy();

  if (strategy === "windows-taskkill") {
    const runTaskkill =
      options.runTaskkill ??
      ((args: string[]) =>
        spawnSync("taskkill", args, {
          windowsHide: true,
          shell: false,
          timeout: TASKKILL_TIMEOUT_MS,
        }) as TaskkillResult);
    let taskkillAttempts = 0;
    const killTree = (): boolean => {
      if (child.pid == null) return true;
      taskkillAttempts += 1;
      return runTaskkill(taskkillArgs(child.pid)).status === 0;
    };
    const terminate = (): void => {
      if (taskkillAttempts < TASKKILL_MAX_ATTEMPTS) {
        killTree();
      }
    };
    const force = (): void => {
      while (taskkillAttempts < TASKKILL_MAX_ATTEMPTS) {
        if (killTree()) return;
      }
      if (child.pid != null) {
        child.kill("SIGKILL");
      }
    };
    return {
      // Console CLI trees have no graceful-shutdown path on Windows, so the soft
      // and hard attempts are the same bounded `/T /F` kill. force() still runs
      // after the grace period as a safety net in case the first attempt raced
      // a late-spawned descendant.
      terminate,
      force,
    };
  }

  return {
    terminate: () => {
      child.kill("SIGTERM");
    },
    force: () => {
      child.kill("SIGKILL");
    },
  };
}
