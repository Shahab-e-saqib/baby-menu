import type { Rectangle } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trayInstance = {
  tray: {},
  getBounds: vi.fn(),
};

type TrayOptions = {
  onOpen?: (bounds: Rectangle) => void;
  onQuit?: () => void;
};

const createBabyMenuTray = vi.fn(
  (_onClick: (bounds: Rectangle) => void, _options: TrayOptions) => trayInstance,
);

const electronApp = {
  commandLine: { appendSwitch: vi.fn() },
  disableHardwareAcceleration: vi.fn(),
  dock: { hide: vi.fn() },
  getAppPath: vi.fn(() => "/repo"),
  getPath: vi.fn((name: string): string => {
    if (name === "home") return "/home/test-user";
    if (name === "exe") return "C:\\Program Files\\Baby Menu\\Baby Menu.exe";
    return "/tmp";
  }),
  getVersion: vi.fn(() => "0.0.0-test"),
  getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
  setLoginItemSettings: vi.fn(),
  setActivationPolicy: vi.fn(),
  focus: vi.fn(),
  isPackaged: false,
  on: vi.fn(),
  whenReady: vi.fn(async () => undefined),
  quit: vi.fn(),
  exit: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
  setAppUserModelId: vi.fn(),
};

const browserWindowInstance = {
  isDestroyed: vi.fn(() => false),
  isVisible: vi.fn(() => false),
  setBounds: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  hide: vi.fn(),
  on: vi.fn(),
  loadFile: vi.fn(async () => undefined),
  loadURL: vi.fn(async () => undefined),
  webContents: { send: vi.fn() },
};

const preferencesHarness = vi.hoisted(() => {
  let current: {
    openAtLogin: boolean;
    agentName?: string;
    agentModes?: Record<string, "native" | "wsl">;
    wslDistribution?: string;
  } = { openAtLogin: false };
  const service = {
    apply: vi.fn(async () => current),
    get: vi.fn(async () => current),
    setOpenAtLogin: vi.fn(async (openAtLogin: boolean) => (current = { ...current, openAtLogin })),
    setAgent: vi.fn(async (agentName: string) => (current = { ...current, agentName })),
    setAgentMode: vi.fn(async (agentName: string, mode: "native" | "wsl") =>
      (current = { ...current, agentModes: { ...current.agentModes, [agentName]: mode } })),
    setWslDistribution: vi.fn(async (wslDistribution: string) => (current = { ...current, wslDistribution })),
  };
  return {
    service,
    reset() {
      current = { openAtLogin: false };
    },
  };
});

const listWslDistributions = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, distributions: ["Ubuntu"] })));
const registerIpcHandlers = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: electronApp,
  BrowserWindow: vi.fn(function MockBrowserWindow() { return browserWindowInstance; }),
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  screen: { getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })) },
  shell: { openExternal: vi.fn(async () => undefined) },
}));

vi.mock("../src/main/ipc", () => ({ registerIpcHandlers }));
vi.mock("../src/main/telemetry", () => {
  const client = { track: vi.fn(), pageview: vi.fn(), close: vi.fn(async () => undefined) };
  return { initDefaultTelemetry: vi.fn(() => client), getDefaultTelemetry: vi.fn(() => client) };
});
vi.mock("../src/main/agent-runtime", () => ({
  BabyMenuAgentRuntime: vi.fn(function BabyMenuAgentRuntimeMock() {
    return {
      currentAgent: "claude",
      agentSwitchDisabledReason: undefined,
      setAgent: vi.fn(async () => undefined),
      setExecutionMode: vi.fn(async () => undefined),
      setRegistryOverrides: vi.fn(),
    };
  }),
  commandExists: vi.fn(() => false),
}));
vi.mock("../src/main/preferences", () => ({
  createPreferencesService: vi.fn(() => preferencesHarness.service),
}));
vi.mock("../src/main/wsl-cli", () => ({ listWslDistributions }));
vi.mock("../src/main/extension-seeder", () => ({
  seedExtensionWorkspace: vi.fn(async () => undefined),
}));
vi.mock("../src/main/server-action-registry", () => ({
  createServerActionRegistry: vi.fn(() => ({})),
  createBackgroundTaskSource: vi.fn(() => ({ list: vi.fn(async () => []) })),
}));
vi.mock("../src/main/background-task-scheduler", () => ({
  createBackgroundTaskScheduler: vi.fn(() => ({
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
  })),
}));
vi.mock("../src/main/extension-database", () => ({
  createExtensionDatabase: vi.fn(() => ({
    query: vi.fn(() => []),
    get: vi.fn(),
    run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
    exec: vi.fn(),
    transaction: vi.fn((fn: () => unknown) => fn()),
    close: vi.fn(),
  })),
}));
vi.mock("../src/main/notifier", () => ({ createNotifier: vi.fn(() => vi.fn()) }));
vi.mock("../src/main/update-checker", () => ({
  createUpdateChecker: vi.fn(() => ({ getStatus: vi.fn(), openReleasePage: vi.fn() })),
}));
vi.mock("../src/main/widget-module-registry", () => ({
  createWidgetModuleRegistry: vi.fn(() => ({})),
  createLayoutModuleRegistry: vi.fn(() => ({ get: vi.fn(async () => null) })),
}));
vi.mock("../src/main/widget-protocol", () => ({
  registerBabyMenuProtocolHandlers: vi.fn(),
  registerBabyMenuProtocolSchemes: vi.fn(),
}));
vi.mock("../src/main/tray", () => ({ createBabyMenuTray }));
vi.mock("../src/main/shell-path", () => ({ expandProcessPathForGuiLaunch: vi.fn(() => "/usr/bin:/bin") }));
vi.mock("../src/shared/paths", () => ({
  EXTENSIONS_DIR_ENV: "BABY_MENU_EXTENSIONS_DIR",
  getRepoRoot: vi.fn(() => "/repo"),
  isUncWindowsLaunch: vi.fn(() => false),
}));

describe("Windows shell lifecycle", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    preferencesHarness.reset();
    listWslDistributions.mockImplementation(async () => ({ ok: true as const, distributions: ["Ubuntu"] }));
    vi.spyOn(console, "warn");
    electronApp.isPackaged = false;
    electronApp.getPath.mockImplementation((name: string) => {
      if (name === "home") return "/home/test-user";
      if (name === "exe") return "C:\\Program Files\\Baby Menu\\Baby Menu.exe";
      return "/tmp";
    });
    electronApp.requestSingleInstanceLock.mockReset();
    electronApp.requestSingleInstanceLock.mockReturnValue(true);
    browserWindowInstance.isDestroyed.mockReturnValue(false);
    browserWindowInstance.isVisible.mockReturnValue(false);
    trayInstance.getBounds.mockReturnValue({ x: 100, y: 10, width: 24, height: 24 });
    delete process.env.BABY_MENU_REMOTE_DEBUGGING_PORT;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  afterEach(() => {
    delete process.env.BABY_MENU_REMOTE_DEBUGGING_PORT;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("acquires the single-instance lock and starts normally when it is the primary instance", async () => {
    electronApp.requestSingleInstanceLock.mockReturnValue(true);

    await import("../src/main/app");

    expect(electronApp.requestSingleInstanceLock).toHaveBeenCalledExactlyOnceWith();
    expect(electronApp.quit).not.toHaveBeenCalled();
    expect(electronApp.on).toHaveBeenCalledWith("second-instance", expect.any(Function));
  });

  it("exits the second process when the single-instance lock is already held", async () => {
    electronApp.requestSingleInstanceLock.mockReturnValue(false);

    await import("../src/main/app");

    expect(electronApp.requestSingleInstanceLock).toHaveBeenCalledExactlyOnceWith();
    expect(electronApp.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(electronApp.quit).not.toHaveBeenCalled();
  });

  it("emits a structured console.warn on lock denial before calling app.exit(0)", async () => {
    electronApp.requestSingleInstanceLock.mockReturnValue(false);

    await import("../src/main/app");

    expect(console.warn).toHaveBeenCalledTimes(1);
    const warnArg = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(warnArg).toBeTypeOf("string");
    const parsed = JSON.parse(warnArg);
    expect(parsed).toMatchObject({
      event: "second-instance-rejected",
      platform: process.platform,
      isPackaged: false,
    });
    expect(Object.keys(parsed)).toStrictEqual(["event", "platform", "isPackaged"]);
    expect(electronApp.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(electronApp.quit).not.toHaveBeenCalled();
    // Verify warn was called before exit
    const warnCallIndex = (console.warn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const exitCallIndex = electronApp.exit.mock.invocationCallOrder[0];
    expect(warnCallIndex).toBeLessThan(exitCallIndex);
  });

  it("does not emit a warning when the single-instance lock is acquired", async () => {
    electronApp.requestSingleInstanceLock.mockReturnValue(true);

    await import("../src/main/app");

    expect(console.warn).not.toHaveBeenCalled();
  });

  it("shows and focuses the popover when a second-instance event fires and popover is ready", async () => {
    const appModule = await import("../src/main/app");
    await appModule.startBabyMenuApp();

    // Trigger popover creation so popoverWindow is non-null
    const onTrayClick = createBabyMenuTray.mock.calls.at(-1)?.[0];
    await onTrayClick?.({ x: 100, y: 10, width: 24, height: 24 });

    const onSecondInstance = electronApp.on.mock.calls.find(([event]) => event === "second-instance")?.[1];

    expect(onSecondInstance).toBeTypeOf("function");

    // Popover is already visible - should focus but not show again
    browserWindowInstance.isDestroyed.mockReturnValue(false);
    browserWindowInstance.isVisible.mockReturnValue(true);
    browserWindowInstance.focus.mockClear();
    browserWindowInstance.show.mockClear();
    onSecondInstance?.();
    await vi.waitFor(() => expect(browserWindowInstance.focus).toHaveBeenCalledExactlyOnceWith());
    expect(browserWindowInstance.show).not.toHaveBeenCalled();

    // Popover is hidden - should show and focus
    browserWindowInstance.isVisible.mockReturnValue(false);
    browserWindowInstance.focus.mockClear();
    browserWindowInstance.show.mockClear();
    onSecondInstance?.();
    await vi.waitFor(() => expect(browserWindowInstance.show).toHaveBeenCalledExactlyOnceWith());
    expect(browserWindowInstance.focus).toHaveBeenCalledExactlyOnceWith();
  });

  it("creates and shows the popover when a second instance activates a tray-only primary", async () => {
    const appModule = await import("../src/main/app");
    await appModule.startBabyMenuApp();
    const onSecondInstance = electronApp.on.mock.calls.find(([event]) => event === "second-instance")?.[1];

    onSecondInstance?.();

    await vi.waitFor(() => expect(browserWindowInstance.show).toHaveBeenCalledExactlyOnceWith());
    expect(trayInstance.getBounds).toHaveBeenCalledExactlyOnceWith();
    expect(browserWindowInstance.setBounds).toHaveBeenCalledWith({ x: 8, y: 42, width: 504, height: 620 });
    expect(browserWindowInstance.focus).toHaveBeenCalledExactlyOnceWith();
  });

  it("makes the Windows context-menu Open action show or focus without hiding", async () => {
    const appModule = await import("../src/main/app");
    await appModule.startBabyMenuApp();
    const trayOptions = createBabyMenuTray.mock.calls.at(-1)?.[1] as {
      onOpen?: (bounds: Rectangle) => void;
    };

    expect(trayOptions.onOpen).toBeTypeOf("function");

    trayOptions.onOpen?.({ x: 100, y: 10, width: 24, height: 24 });
    await vi.waitFor(() => expect(browserWindowInstance.show).toHaveBeenCalledExactlyOnceWith());

    browserWindowInstance.isVisible.mockReturnValue(true);
    browserWindowInstance.focus.mockClear();
    browserWindowInstance.hide.mockClear();
    trayOptions.onOpen?.({ x: 100, y: 10, width: 24, height: 24 });

    await vi.waitFor(() => expect(browserWindowInstance.focus).toHaveBeenCalledExactlyOnceWith());
    expect(browserWindowInstance.hide).not.toHaveBeenCalled();
  });

  it("coalesces second-instance activation received before tray creation", async () => {
    let finishSeeding: (() => void) | undefined;
    const seeding = new Promise<void>((resolve) => {
      finishSeeding = resolve;
    });
    const { seedExtensionWorkspace } = await import("../src/main/extension-seeder");
    (seedExtensionWorkspace as ReturnType<typeof vi.fn>).mockImplementationOnce(() => seeding);
    const appModule = await import("../src/main/app");
    const startup = appModule.startBabyMenuApp();
    const onSecondInstance = electronApp.on.mock.calls.find(([event]) => event === "second-instance")?.[1];

    onSecondInstance?.();
    onSecondInstance?.();
    expect(browserWindowInstance.show).not.toHaveBeenCalled();

    finishSeeding?.();
    await startup;

    expect(trayInstance.getBounds).toHaveBeenCalledExactlyOnceWith();
    expect(browserWindowInstance.show).toHaveBeenCalledExactlyOnceWith();
    expect(browserWindowInstance.focus).toHaveBeenCalledExactlyOnceWith();
  });

  it("is safe when a second-instance event fires before popover creation", async () => {
    const appModule = await import("../src/main/app");

    const onSecondInstance = electronApp.on.mock.calls.find(([event]) => event === "second-instance")?.[1];

    // Popover is null (not yet created) - handler should not throw
    expect(() => onSecondInstance?.()).not.toThrow();
  });

  it("is safe when a second-instance event fires after popover is destroyed", async () => {
    const appModule = await import("../src/main/app");

    const onSecondInstance = electronApp.on.mock.calls.find(([event]) => event === "second-instance")?.[1];

    // Popover is destroyed - handler should not throw
    browserWindowInstance.isDestroyed.mockReturnValue(true);
    expect(() => onSecondInstance?.()).not.toThrow();
  });

  it("sets the production Windows AppUserModelID from the packaged executable identity", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    electronApp.isPackaged = true;
    electronApp.requestSingleInstanceLock.mockReturnValue(true);

    await import("../src/main/app");

    expect(electronApp.setAppUserModelId).toHaveBeenCalledExactlyOnceWith("com.kunchenguid.baby-menu");
  });

  it("sets the dev Windows AppUserModelID for a packaged preview", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    electronApp.isPackaged = true;
    electronApp.getPath.mockImplementation((name: string) =>
      name === "exe" ? "C:\\Preview\\Baby Menu Dev.exe" : "/tmp",
    );

    await import("../src/main/app");

    expect(electronApp.setAppUserModelId).toHaveBeenCalledExactlyOnceWith("com.kunchenguid.baby-menu.dev");
  });

  it("does not set AppUserModelID on non-Windows platforms", async () => {
    electronApp.requestSingleInstanceLock.mockReturnValue(true);

    await import("../src/main/app");

    expect(electronApp.setAppUserModelId).not.toHaveBeenCalled();
  });

  it("returns current preferences when WSL settings probes finish out of order", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    const resolvers: Array<(value: { ok: true; distributions: string[] }) => void> = [];
    listWslDistributions.mockImplementation(
      () => new Promise<{ ok: true; distributions: string[] }>((resolve) => resolvers.push(resolve)),
    );
    const appModule = await import("../src/main/app");
    await appModule.startBabyMenuApp();
    const settings = registerIpcHandlers.mock.calls.at(-1)?.[5] as {
      get: () => Promise<{ agentModes?: Record<string, "native" | "wsl"> }>;
      setAgentMode: (agentName: string, mode: "native" | "wsl") => Promise<{ agentModes?: Record<string, "native" | "wsl"> }>;
    };

    const earlier = settings.get();
    await vi.waitFor(() => expect(listWslDistributions).toHaveBeenCalledTimes(1));
    const later = settings.setAgentMode("codex", "wsl");
    await vi.waitFor(() => expect(listWslDistributions).toHaveBeenCalledTimes(2));

    resolvers[1]?.({ ok: true, distributions: ["Ubuntu"] });
    await expect(later).resolves.toMatchObject({ agentModes: { codex: "wsl" } });
    resolvers[0]?.({ ok: true, distributions: ["Ubuntu"] });
    await expect(earlier).resolves.toMatchObject({ agentModes: { codex: "wsl" } });
  });

});
