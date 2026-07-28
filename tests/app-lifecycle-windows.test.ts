import type { Rectangle } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trayInstance = {
  tray: {},
  getBounds: vi.fn(),
};

const createBabyMenuTray = vi.fn((_onClick: (bounds: Rectangle) => void) => trayInstance);

const electronApp = {
  commandLine: { appendSwitch: vi.fn() },
  disableHardwareAcceleration: vi.fn(),
  dock: { hide: vi.fn() },
  getAppPath: vi.fn(() => "/repo"),
  getPath: vi.fn((name: string) => (name === "home" ? "/home/test-user" : "/tmp")),
  getVersion: vi.fn(() => "0.0.0-test"),
  getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
  setLoginItemSettings: vi.fn(),
  setActivationPolicy: vi.fn(),
  focus: vi.fn(),
  isPackaged: false,
  on: vi.fn(),
  whenReady: vi.fn(async () => undefined),
  quit: vi.fn(),
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

vi.mock("electron", () => ({
  app: electronApp,
  BrowserWindow: vi.fn(function MockBrowserWindow() { return browserWindowInstance; }),
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  screen: { getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })) },
  shell: { openExternal: vi.fn(async () => undefined) },
}));

vi.mock("../src/main/ipc", () => ({ registerIpcHandlers: vi.fn() }));
vi.mock("../src/main/telemetry", () => {
  const client = { track: vi.fn(), pageview: vi.fn(), close: vi.fn(async () => undefined) };
  return { initDefaultTelemetry: vi.fn(() => client), getDefaultTelemetry: vi.fn(() => client) };
});
vi.mock("../src/main/agent-runtime", () => ({
  BabyMenuAgentRuntime: vi.fn(),
  commandExists: vi.fn(() => false),
}));
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
    electronApp.isPackaged = false;
    electronApp.requestSingleInstanceLock.mockReset();
    electronApp.requestSingleInstanceLock.mockReturnValue(true);
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

  it("quits the second process when the single-instance lock is already held", async () => {
    electronApp.requestSingleInstanceLock.mockReturnValue(false);

    await import("../src/main/app");

    expect(electronApp.requestSingleInstanceLock).toHaveBeenCalledExactlyOnceWith();
    expect(electronApp.quit).toHaveBeenCalledExactlyOnceWith();
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
    expect(browserWindowInstance.show).not.toHaveBeenCalled();
    expect(browserWindowInstance.focus).toHaveBeenCalledExactlyOnceWith();

    // Popover is hidden - should show and focus
    browserWindowInstance.isVisible.mockReturnValue(false);
    browserWindowInstance.focus.mockClear();
    browserWindowInstance.show.mockClear();
    onSecondInstance?.();
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

  it("sets the Windows AppUserModelID to the application ID before readiness", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    electronApp.requestSingleInstanceLock.mockReturnValue(true);

    await import("../src/main/app");

    expect(electronApp.setAppUserModelId).toHaveBeenCalledExactlyOnceWith("com.kunchenguid.baby-menu");
  });

  it("does not set AppUserModelID on non-Windows platforms", async () => {
    electronApp.requestSingleInstanceLock.mockReturnValue(true);

    await import("../src/main/app");

    expect(electronApp.setAppUserModelId).not.toHaveBeenCalled();
  });
});
