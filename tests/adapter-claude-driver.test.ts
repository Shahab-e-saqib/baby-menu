import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { describe, expect, it, afterEach, vi } from "vitest";
import { ClaudeDriver } from "../src/adapters/claude/driver";
import type * as schema from "@agentclientprotocol/sdk";

const FAKE = join(
  __dirname,
  "fixtures",
  "fake-clis",
  process.platform === "win32" ? "fake-claude.cmd" : "fake-claude.mjs",
);

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename === basename(path) && existsSync(path)) {
        watcher.close();
        resolve();
      }
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
  });
}

async function slowCancelGate(): Promise<{ prompt: string; terminated: Promise<void>; release: () => Promise<void> }> {
  // The fake CLI reports SIGTERM through one file and waits on the other before
  // exiting, which lets the tests assert ordering without wall-clock races.
  const dir = await mkdtemp(join(tmpdir(), "claude-driver-"));
  const sentinel = join(dir, "release-exit");
  const terminated = join(dir, "observed-sigterm");
  return { prompt: `SLOW_CANCEL:${sentinel}:${terminated}`, terminated: waitForFile(terminated), release: () => writeFile(sentinel, "") };
}

async function stdinFailureGate(): Promise<{
  value: string;
  ready: Promise<void>;
  terminated: Promise<void>;
  release: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "claude-stdin-failure-"));
  const readyFile = join(dir, "stdin-closed");
  const terminatedFile = join(dir, "observed-sigterm");
  const releaseFile = join(dir, "release-exit");
  return {
    value: JSON.stringify({ readyFile, terminatedFile, releaseFile }),
    ready: waitForFile(readyFile),
    terminated: waitForFile(terminatedFile),
    release: () => writeFile(releaseFile, ""),
  };
}

describe("ClaudeDriver (against a fake claude CLI)", () => {
  let driver: ClaudeDriver | null = null;
  afterEach(async () => {
    await driver?.dispose();
    driver = null;
  });

  function makeDriver(): ClaudeDriver {
    driver = new ClaudeDriver({ command: FAKE });
    return driver;
  }

  it("streams an assistant chunk and resolves end_turn", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const updates: schema.SessionUpdate[] = [];
    const stop = await d.prompt("hello", (u) => updates.push(u), new AbortController().signal);
    expect(stop).toBe("end_turn");
    expect(updates.find((u) => u.sessionUpdate === "agent_message_chunk")).toMatchObject({
      content: { type: "text", text: "echo:hello" },
    });
  });

  it("delivers shell metacharacter prompts verbatim over stdin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-stdin-"));
    const argsFile = join(dir, "args.json");
    const injectedFile = join(dir, "injected");
    const text = `literal & | %\n"quoted"\n& echo injected > "${injectedFile}" &`;
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    try {
      const d = makeDriver();
      await d.start(tmpdir());
      const updates: schema.SessionUpdate[] = [];
      await d.prompt(text, (update) => updates.push(update), new AbortController().signal);

      expect(updates.find((update) => update.sessionUpdate === "agent_message_chunk")).toMatchObject({
        content: { type: "text", text: `echo:${text}` },
      });
      expect(JSON.parse(await readFile(argsFile, "utf8")) as string[]).not.toContain(text);
      expect(existsSync(injectedFile)).toBe(false);
    } finally {
      delete process.env.FAKE_CLAUDE_ARGS_FILE;
    }
  });

  it("resumes the session on the second prompt (carries memory)", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const s = new AbortController().signal;
    await d.prompt("first", () => {}, s);
    const updates: schema.SessionUpdate[] = [];
    await d.prompt("second", (u) => updates.push(u), s);
    // The fake replies "resumed:..." only when invoked via `--resume <id>`,
    // proving the driver captured session_id and threaded it through.
    expect(updates.find((u) => u.sessionUpdate === "agent_message_chunk")).toMatchObject({
      content: { type: "text", text: "resumed:second" },
    });
  });

  it("rejects a terminal provider authentication failure with safe guidance", async () => {
    const d = makeDriver();
    await d.start(tmpdir());

    await expect(d.prompt("PROVIDER_AUTH_ERROR", () => {}, new AbortController().signal)).rejects.toMatchObject({
      name: "AdapterTurnError",
      code: "AUTHENTICATION_FAILED",
      message: "Claude is not authenticated. Run `claude` and complete sign-in, then try again.",
    });
  });

  it("never forwards provider stderr through adapter debug logging", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    process.env.BABY_MENU_ADAPTER_DEBUG = "1";
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(d.prompt("EXIT_NONZERO", () => {}, new AbortController().signal)).rejects.toMatchObject({
        code: "CLI_EXIT_FAILED",
      });
      expect(write.mock.calls.flat().join(" ")).not.toContain("private detail");
    } finally {
      write.mockRestore();
      delete process.env.BABY_MENU_ADAPTER_DEBUG;
    }
  });

  it("surfaces a tool_call and tool_call_update", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const updates: schema.SessionUpdate[] = [];
    await d.prompt("please RUN_TOOL now", (u) => updates.push(u), new AbortController().signal);
    expect(updates.some((u) => u.sessionUpdate === "tool_call")).toBe(true);
    expect(updates.some((u) => u.sessionUpdate === "tool_call_update")).toBe(true);
  });

  it("resolves cancelled when the signal aborts before spawning", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const ac = new AbortController();
    ac.abort();
    expect(await d.prompt("hi", () => {}, ac.signal)).toBe("cancelled");
  });

  it.skipIf(process.platform === "win32")("retains and terminates the child after stdin fails", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const gate = await stdinFailureGate();
    process.env.FAKE_CLAUDE_STDIN_FAILURE_GATE = gate.value;
    try {
      let settled = false;
      const outcome = d.prompt("x".repeat(4 * 1024 * 1024), () => {}, new AbortController().signal).then(
        (result) => {
          settled = true;
          return result;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await gate.ready;
      await gate.terminated;
      expect(settled).toBe(false);
      await expect(d.prompt("second", () => {}, new AbortController().signal)).rejects.toThrow(
        "a prompt is already in progress",
      );
      await gate.release();
      expect(await outcome).toMatchObject({
        code: "CLI_START_FAILED",
        message: "Claude CLI could not receive the prompt.",
      });
    } finally {
      delete process.env.FAKE_CLAUDE_STDIN_FAILURE_GATE;
      await gate.release();
    }
  });

  it("waits for the child process to exit before resolving cancellation", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const gate = await slowCancelGate();
    const ac = new AbortController();
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const prompt = d.prompt(
      gate.prompt,
      (u) => {
        if (u.sessionUpdate === "agent_message_chunk") ready();
      },
      ac.signal,
    );
    await readyPromise;
    let released = false;
    let settled = false;
    const settlement = prompt.then((result) => {
      settled = true;
      return { result, released };
    });
    ac.abort();
    await gate.terminated;
    await Promise.resolve();
    expect(settled).toBe(false);

    released = true;
    await gate.release();
    expect(await settlement).toEqual({ result: "cancelled", released: true });
  });

  it("waits for the child process to exit before resolving disposal", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const gate = await slowCancelGate();
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const prompt = d.prompt(
      gate.prompt,
      (u) => {
        if (u.sessionUpdate === "agent_message_chunk") ready();
      },
      new AbortController().signal,
    );
    await readyPromise;

    const disposal = d.dispose();
    let released = false;
    let disposed = false;
    const settlement = disposal.then(() => {
      disposed = true;
      return { released };
    });
    await gate.terminated;
    await Promise.resolve();
    expect(disposed).toBe(false);

    released = true;
    await gate.release();
    expect(await settlement).toEqual({ released: true });
    expect(disposed).toBe(true);
    expect(await prompt).toBe("cancelled");
  });

  it("force-kills a child that outlives the termination grace period", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const prompt = d.prompt(
      "SLOW_FORCE_KILL",
      (u) => {
        if (u.sessionUpdate === "agent_message_chunk") ready();
      },
      new AbortController().signal,
    );
    await readyPromise;

    // The child swallows SIGTERM, so disposal can only resolve once the driver's
    // SIGKILL after TERMINATION_GRACE_MS terminates it. Awaiting disposal is a
    // deterministic proof of force-kill: if it never fired, this would hang and
    // fail via the test timeout instead of flaking on a race window.
    await d.dispose();
    expect(await prompt).toBe("cancelled");
  });
});
