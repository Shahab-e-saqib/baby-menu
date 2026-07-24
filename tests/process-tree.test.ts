import { describe, expect, it, vi } from "vitest";
import {
  createChildTerminator,
  selectTerminationStrategy,
  TASKKILL_MAX_ATTEMPTS,
  TASKKILL_TIMEOUT_MS,
  taskkillArgs,
  type TerminableChild,
} from "../src/adapters/shared/process-tree";

// A minimal stand-in for a Node ChildProcess: records the signals it received.
function fakeChild(pid?: number) {
  const kills: string[] = [];
  const child: TerminableChild = {
    pid,
    kill: (signal?: NodeJS.Signals | number) => {
      kills.push(signal === undefined ? "<none>" : String(signal));
      return true;
    },
  };
  return { child, kills };
}

describe("selectTerminationStrategy", () => {
  it("uses posix signals on darwin/linux", () => {
    expect(selectTerminationStrategy("darwin")).toBe("posix-signals");
    expect(selectTerminationStrategy("linux")).toBe("posix-signals");
  });

  it("uses taskkill on win32", () => {
    expect(selectTerminationStrategy("win32")).toBe("windows-taskkill");
  });
});

describe("taskkillArgs", () => {
  it("builds a bounded, numeric-PID tree kill (no untrusted text reaches a shell)", () => {
    expect(taskkillArgs(4242)).toEqual(["/PID", "4242", "/T", "/F"]);
  });

  it("never interpolates the pid into a string (always a separate numeric arg)", () => {
    // The pid comes from child.pid (a number), so String() of it is always a
    // bare integer token - there is no shell into which untrusted text could be
    // injected even if a future caller passed something odd.
    expect(taskkillArgs(0)).toEqual(["/PID", "0", "/T", "/F"]);
  });
});

describe("createChildTerminator (posix-signals)", () => {
  it("sends SIGTERM on terminate and SIGKILL on force, byte-for-byte the historical behavior", () => {
    const { child, kills } = fakeChild(111);
    const terminator = createChildTerminator(child, { strategy: "posix-signals" });
    terminator.terminate();
    terminator.force();
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("uses an explicit posix strategy independent of the test host", () => {
    const { child, kills } = fakeChild(222);
    const terminator = createChildTerminator(child, { strategy: "posix-signals" });
    terminator.terminate();
    expect(kills).toEqual(["SIGTERM"]);
  });
});

describe("createChildTerminator (windows-taskkill)", () => {
  it("bounds each taskkill attempt", () => {
    expect(TASKKILL_TIMEOUT_MS).toBe(5000);
    expect(TASKKILL_MAX_ATTEMPTS).toBe(2);
  });

  it("runs taskkill /T /F with the numeric pid on terminate (injection-free)", () => {
    const { child } = fakeChild(909);
    const runTaskkill = vi.fn<(args: string[]) => { status: number | null }>(() => ({ status: 0 }));
    const terminator = createChildTerminator(child, { strategy: "windows-taskkill", runTaskkill });
    terminator.terminate();
    expect(runTaskkill).toHaveBeenCalledTimes(1);
    expect(runTaskkill).toHaveBeenCalledWith(["/PID", "909", "/T", "/F"]);
  });

  it("force repeats the bounded tree kill (no graceful path for console CLI trees)", () => {
    const { child } = fakeChild(909);
    const runTaskkill = vi.fn<(args: string[]) => { status: number | null }>(() => ({ status: 0 }));
    const terminator = createChildTerminator(child, { strategy: "windows-taskkill", runTaskkill });
    terminator.terminate();
    terminator.force();
    expect(runTaskkill).toHaveBeenCalledTimes(2);
    // Every invocation uses the same safe numeric args.
    for (const [args] of runTaskkill.mock.calls) {
      expect(args).toEqual(["/PID", "909", "/T", "/F"]);
    }
  });

  it("is a no-op when the child has no pid yet (spawn not complete)", () => {
    const { child } = fakeChild(undefined);
    const runTaskkill = vi.fn<(args: string[]) => { status: number | null }>(() => ({ status: 0 }));
    const terminator = createChildTerminator(child, { strategy: "windows-taskkill", runTaskkill });
    terminator.terminate();
    terminator.force();
    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("preserves the immediate child when the first taskkill fails so force can retry the tree", () => {
    const { child, kills } = fakeChild(909);
    const statuses: Array<number | null> = [1, 0];
    const runTaskkill = vi.fn<(args: string[]) => { status: number | null }>(() => ({
      status: statuses.shift() ?? null,
    }));
    const terminator = createChildTerminator(child, { strategy: "windows-taskkill", runTaskkill });

    terminator.terminate();
    expect(kills).toEqual([]);

    terminator.force();
    expect(runTaskkill).toHaveBeenCalledTimes(2);
    expect(kills).toEqual([]);
  });

  it.each([
    ["failed", 1],
    ["timed out", null],
  ] as const)("force-kills the immediate child after bounded taskkill attempts %s", (_label, status) => {
    const { child, kills } = fakeChild(909);
    const runTaskkill = vi.fn<(args: string[]) => { status: number | null }>(() => ({ status }));
    const terminator = createChildTerminator(child, { strategy: "windows-taskkill", runTaskkill });

    terminator.terminate();
    expect(kills).toEqual([]);
    terminator.force();

    expect(runTaskkill).toHaveBeenCalledTimes(TASKKILL_MAX_ATTEMPTS);
    expect(kills).toEqual(["SIGKILL"]);
  });
});
