import { describe, expect, it, vi } from "vitest";
import type { AcpRuntimeEvent, AcpRuntimeTurn } from "acpx/runtime";
import {
  AgentTimeoutError,
  agentRuntimeStatusForEvent,
  buildBabyMenuAgentPrompt,
  collectAgentTurnOutput,
  getAgentRuntimeCwd,
  resolveAgentTimeoutMs,
  resolveDefaultAgentName,
  withAgentTimeout,
} from "../src/main/agent-runtime";

function available(commands: string[]) {
  const commandSet = new Set(commands);
  return (command: string) => commandSet.has(command);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function fakeTurn({
  events,
  cancel = vi.fn(async () => undefined),
  closeStream = vi.fn(async () => undefined),
}: {
  events: AsyncIterable<AcpRuntimeEvent>;
  cancel?: AcpRuntimeTurn["cancel"];
  closeStream?: AcpRuntimeTurn["closeStream"];
}): AcpRuntimeTurn {
  return {
    requestId: "test-turn",
    events,
    result: Promise.resolve({ status: "completed" }),
    cancel,
    closeStream,
  };
}

describe("agent runtime defaults", () => {
  it("honors BABY_MENU_AGENT before auto-detecting local agents", () => {
    expect(
      resolveDefaultAgentName({
        env: { BABY_MENU_AGENT: "mock-target" },
        commandExists: available(["codex", "claude"]),
      }),
    ).toBe("mock-target");
  });

  it("prefers Claude before Codex for the default ACP path", () => {
    expect(
      resolveDefaultAgentName({
        env: {},
        commandExists: available(["codex", "claude", "npx"]),
      }),
    ).toBe("claude");
  });

  it("uses Pi when Claude is unavailable and npx is available", () => {
    expect(
      resolveDefaultAgentName({
        env: {},
        commandExists: available(["codex", "npx"]),
      }),
    ).toBe("pi");
  });

  it("uses Codex when it is the only preferred local agent available", () => {
    expect(
      resolveDefaultAgentName({
        env: {},
        commandExists: available(["codex"]),
      }),
    ).toBe("codex");
  });

  it("falls back to Claude instead of OpenCode when no preferred CLI is detected", () => {
    expect(
      resolveDefaultAgentName({
        env: {},
        commandExists: available([]),
      }),
    ).toBe("claude");
  });

  it("uses a bounded default request timeout", () => {
    expect(resolveAgentTimeoutMs({})).toBe(300_000);
  });

  it("launches embedded agents from the tracked extension workspace by default", () => {
    expect(getAgentRuntimeCwd("/repo")).toBe("/repo/extensions");
  });

  it("launches embedded agents from extensions-dev when dev mode provides one", () => {
    expect(getAgentRuntimeCwd("/repo", { BABY_MENU_EXTENSIONS_DIR: "/repo/extensions-dev" })).toBe(
      "/repo/extensions-dev",
    );
  });

  it("resolves relative dev extension workspaces inside the repo", () => {
    expect(getAgentRuntimeCwd("/repo", { BABY_MENU_EXTENSIONS_DIR: "extensions-dev" })).toBe(
      "/repo/extensions-dev",
    );
  });

  it("allows BABY_MENU_AGENT_TIMEOUT_MS to override the request timeout", () => {
    expect(resolveAgentTimeoutMs({ BABY_MENU_AGENT_TIMEOUT_MS: "45000" })).toBe(45_000);
  });

  it("rejects and runs cleanup when an agent operation times out", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const pending = new Promise<string>(() => undefined);

    const timed = withAgentTimeout(pending, {
      timeoutMs: 25,
      phase: "starting agent session",
      onTimeout: cleanup,
    });
    const assertion = expect(timed).rejects.toThrow("Agent request timed out after 25ms while starting agent session");

    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    expect(cleanup).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("keeps waiting while an ACP turn emits activity before the idle timeout", async () => {
    vi.useFakeTimers();

    async function* events(): AsyncIterable<AcpRuntimeEvent> {
      yield { type: "tool_call", text: "shell: git status" };
      await wait(40);
      yield { type: "text_delta", stream: "thought", text: "thinking" };
      await wait(40);
      yield { type: "text_delta", stream: "output", text: "done" };
    }

    const collected = collectAgentTurnOutput(fakeTurn({ events: events() }), { idleTimeoutMs: 50 });

    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(40);

    await expect(collected).resolves.toBe("done");
    vi.useRealTimers();
  });

  it("cancels the ACP turn when it produces no activity before the idle timeout", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => undefined);
    const closeStream = vi.fn(async () => undefined);

    async function* events(): AsyncIterable<AcpRuntimeEvent> {
      await wait(1_000);
      yield { type: "text_delta", stream: "output", text: "too late" };
    }

    const collected = collectAgentTurnOutput(fakeTurn({ events: events(), cancel, closeStream }), {
      idleTimeoutMs: 25,
    });
    const assertion = expect(collected).rejects.toThrow(AgentTimeoutError);

    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    expect(cancel).toHaveBeenCalledWith({ reason: "timeout" });
    expect(closeStream).toHaveBeenCalledWith({ reason: "timeout" });
    vi.useRealTimers();
  });

  it("only turns assistant output text into user-facing status text", () => {
    expect(
      agentRuntimeStatusForEvent({
        type: "tool_call",
        text: "shell command",
        title: "checking GitHub",
      } as AcpRuntimeEvent),
    ).toBeNull();
    expect(
      agentRuntimeStatusForEvent({ type: "status", text: "usage updated: 100 tokens" } as AcpRuntimeEvent),
    ).toBeNull();
    expect(
      agentRuntimeStatusForEvent({ type: "text_delta", stream: "thought", text: "thinking" } as AcpRuntimeEvent),
    ).toBeNull();
    expect(
      agentRuntimeStatusForEvent({ type: "text_delta", stream: "output", text: "final answer" } as AcpRuntimeEvent),
    ).toEqual({ text: "final answer", eventType: "text_delta" });
  });

  it("does not publish partial streamed assistant chunks as status", async () => {
    const statuses: string[] = [];

    async function* events(): AsyncIterable<AcpRuntimeEvent> {
      yield { type: "text_delta", stream: "output", text: "Built the" };
      yield { type: "text_delta", stream: "output", text: " widget." };
    }

    const collected = collectAgentTurnOutput(fakeTurn({ events: events() }), {
      idleTimeoutMs: 50,
      onStatus: (status) => {
        statuses.push(status.text);
      },
    });

    await expect(collected).resolves.toBe("Built the widget.");
    expect(statuses).toEqual(["Built the widget."]);
  });

  it("tells agents to keep new widget capabilities hot reloadable", () => {
    const prompt = buildBabyMenuAgentPrompt("Build a Codex quota widget");

    expect(prompt).toContain("Build a Codex quota widget");
    expect(prompt).toContain("self-contained extensions");
    expect(prompt).toContain("current extension workspace");
    expect(prompt).toContain("Do not modify files outside your current extension workspace");
    expect(prompt).toContain("stable window.babyMenu bridge");
    expect(prompt).toContain("window.babyMenu.capabilities.invoke");
    expect(prompt).toContain("server.ts");
    expect(prompt).toContain("Do not add new preload methods");
    expect(prompt).toContain("server action");
  });
});
