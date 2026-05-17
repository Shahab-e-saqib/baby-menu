import type { ReactNode } from "react";

export type RecipeMetadata = {
  id: string;
  title: string;
  fileName: string;
  path: string;
};

export type GitSessionSnapshot = {
  startedClean: boolean;
  canSave: boolean;
  canRollback: boolean;
  head: string | null;
  message?: string;
};

export type GitActionResult = {
  ok: boolean;
  reason?: string;
  commit?: string;
};

export type AgentChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};

export type AgentChatResult = {
  assistantText: string;
  session?: GitSessionSnapshot;
};

export type AgentRuntimeStatus = {
  text: string;
  eventType: "text_delta";
};

export type BabyMenuCapabilityDescriptor = {
  id: string;
  extensionId: string;
  action: string;
};

export type BabyMenuWidgetModuleDescriptor = {
  id: string;
  extensionId: string;
  moduleUrl: string;
};

export type BabyMenuWidget = {
  id: string;
  title: string;
  refreshIntervalMs?: number;
  render: () => ReactNode;
};

export type RefreshableBabyMenuWidget = BabyMenuWidget & {
  refresh?: () => void | Promise<void>;
};

export type BabyMenuApi = {
  recipes: {
    list: () => Promise<RecipeMetadata[]>;
  };
  git: {
    save: (message?: string) => Promise<GitActionResult>;
    rollback: () => Promise<GitActionResult>;
  };
  agent: {
    send: (prompt: string) => Promise<AgentChatResult>;
    onStatus: (listener: (status: AgentRuntimeStatus) => void) => () => void;
  };
  capabilities: {
    list: () => Promise<BabyMenuCapabilityDescriptor[]>;
    invoke: <T = unknown>(extensionId: string, action: string, input?: unknown) => Promise<T>;
  };
  widgets: {
    list: () => Promise<BabyMenuWidgetModuleDescriptor[]>;
  };
  popover: {
    setContentHeight: (height: number) => Promise<{ ok: boolean }>;
  };
};

declare global {
  interface Window {
    babyMenu?: BabyMenuApi;
  }
}
