import { useEffect, useState } from "react";
import type { GitSessionSnapshot } from "../../shared/contracts";

const unavailableText = "open baby_menu from the tray to talk to the agent";

export type AgentRun = {
  id: string;
  title: string;
  startedAt: number;
  statusText?: string;
};

export type AgentSessionNotice =
  | {
      kind: "pending";
      summary: string;
      hint: string;
      canKeep: boolean;
      canUndo: boolean;
    }
  | {
      kind: "blocked" | "saved" | "error";
      summary: string;
      hint?: string;
    };

export function useAgentRuntime() {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [pendingChange, setPendingChange] = useState<AgentSessionNotice | null>(null);
  const [notice, setNotice] = useState<AgentSessionNotice | null>(null);

  useEffect(() => {
    return window.babyMenu?.agent.onStatus((status) => {
      setRun((current) => (current ? { ...current, statusText: status.text } : current));
    });
  }, []);

  async function send(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed || run) return;

    if (pendingChange?.kind === "pending") {
      setNotice({
        kind: "blocked",
        summary: "Finish this change first",
        hint: "keep or undo before asking again",
      });
      return;
    }

    const startedAt = Date.now();
    setNotice(null);
    setRun({
      id: crypto.randomUUID(),
      title: trimmed,
      startedAt,
      statusText: "Working...",
    });

    try {
      if (!window.babyMenu) throw new Error(unavailableText);
      const result = await window.babyMenu.agent.send(trimmed);
      const nextChange = sessionNoticeForResult(result.assistantText, trimmed, result.session);
      setPendingChange(nextChange.kind === "pending" ? nextChange : null);
      setNotice(nextChange.kind === "pending" ? null : nextChange);
    } catch {
      setPendingChange(null);
      setNotice({
        kind: "error",
        summary: "Agent unavailable",
        hint: unavailableText,
      });
    } finally {
      setRun(null);
    }
  }

  async function keep() {
    if (!window.babyMenu || pendingChange?.kind !== "pending") return;

    const result = await window.babyMenu.git.save();
    if (!result.ok) {
      setNotice({ kind: "error", summary: "Could not keep this change" });
      return;
    }

    setPendingChange(null);
    setNotice({ kind: "saved", summary: keptSummary(pendingChange.summary) });
  }

  async function undo() {
    if (!window.babyMenu || pendingChange?.kind !== "pending") return;

    const result = await window.babyMenu.git.rollback();
    if (!result.ok) {
      setNotice({ kind: "error", summary: "Could not undo this change" });
      return;
    }

    setPendingChange(null);
    setNotice({ kind: "saved", summary: "Undone" });
  }

  function dismissNotice() {
    setNotice(null);
  }

  return {
    run,
    session: notice ?? pendingChange,
    send,
    keep,
    undo,
    dismissNotice,
  };
}

function sessionNoticeForResult(
  assistantText: string,
  prompt: string,
  snapshot: GitSessionSnapshot | undefined,
): AgentSessionNotice {
  if (snapshot?.canSave || snapshot?.canRollback) {
    return {
      kind: "pending",
      summary: summarizeAgentResult(assistantText, prompt),
      hint: "keep it, or undo",
      canKeep: snapshot.canSave,
      canUndo: snapshot.canRollback,
    };
  }

  return {
    kind: "blocked",
    summary: "Finish this change first",
    hint: "keep or undo before asking again",
  };
}

function summarizeAgentResult(assistantText: string, prompt: string): string {
  const firstLine = assistantText
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (firstLine && firstLine.length <= 80 && !containsInfrastructureCopy(firstLine)) {
    return firstLine.replace(/[.!]$/, "");
  }

  return summarizePrompt(prompt);
}

function containsInfrastructureCopy(text: string): boolean {
  return /\b(git|commit|rollback|save|files?|repo|working tree|stash|head|sha)\b|\b(src|extensions|recipes)\//i.test(
    text,
  );
}

function summarizePrompt(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes("cpu")) return "Added a CPU temperature widget";
  if (lower.includes("battery")) return "Added a battery widget";
  if (lower.includes("weather")) return "Added a weather widget";
  if (lower.includes("calendar")) return "Added a calendar widget";
  if (lower.includes("memory") || lower.includes("ram")) return "Added a memory widget";
  return "Added a new widget";
}

function keptSummary(summary: string): string {
  return `Kept · ${summary.replace(/^Added\s+/i, "")}`;
}
