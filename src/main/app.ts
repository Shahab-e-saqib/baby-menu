import { app, BrowserWindow, screen, shell, type Rectangle } from "electron";
import { basename, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { BabyMenuCustomAgentInput, BabyMenuSettings } from "../shared/contracts";
import { getRepoRoot, isUncWindowsLaunch } from "../shared/paths";
import { createAgentCatalogController } from "./agent-catalog-controller";
import { listWslDistributions } from "./wsl-cli";
import { BabyMenuAgentRuntime, commandExists } from "./agent-runtime";
import { resolveBabyMenuRuntimePaths } from "./app-paths";
import { seedExtensionWorkspace } from "./extension-seeder";
import { registerIpcHandlers } from "./ipc";
import {
  DEFAULT_POPOVER_SIZE,
  calculatePopoverBounds,
  createPopoverOptions,
  loadPopoverRenderer,
  responsivePopoverSize,
  type Size,
} from "./popover";
import { createBackgroundTaskScheduler } from "./background-task-scheduler";
import { createExtensionDatabase } from "./extension-database";
import { createNotifier } from "./notifier";
import { createPreferencesService } from "./preferences";
import { createBackgroundTaskSource, createServerActionRegistry } from "./server-action-registry";
import { getDefaultTelemetry, initDefaultTelemetry } from "./telemetry";
import { expandProcessPathForGuiLaunch } from "./shell-path";
import { buildAdapterLauncherTokens } from "./launch-command";
import { createUpdateChecker } from "./update-checker";
import { createBabyMenuTray, type BabyMenuTray } from "./tray";
import {
  parseWindowsAdapterLaunchRequest,
  prepareWindowsAdapterLauncher,
  runWindowsAdapterLauncher,
} from "./windows-adapter-launcher";
import { createLayoutModuleRegistry, createWidgetModuleRegistry } from "./widget-module-registry";
import { registerBabyMenuProtocolHandlers, registerBabyMenuProtocolSchemes } from "./widget-protocol";

const windowsAdapterLaunchRequest = parseWindowsAdapterLaunchRequest();

if (windowsAdapterLaunchRequest) {
  prepareWindowsAdapterLauncher(app);
}

if (!windowsAdapterLaunchRequest && process.platform === "darwin") {
  app.commandLine.appendSwitch("use-mock-keychain");
}

// Narrow GPU fallback for the MAIN packaged app process when launched from a
// UNC path (e.g. a WSL \\wsl.localhost\... network share): Chromium's sandboxed
// GPU subprocess cannot launch from a network share, which crashes the app at
// startup in a fatal GPU-init loop (gpu_data_manager_impl_private.cc:417
// "GPU process isn't usable. Goodbye."). This is scoped to UNC launches only, so
// native local-drive installs keep full GPU acceleration and the GPU sandbox;
// the Electron-as-Node adapter launcher has its own equivalent handling. The
// switches must be appended before app.whenReady() (i.e. before Chromium starts).
if (!windowsAdapterLaunchRequest && isUncWindowsLaunch()) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("disable-gpu");
}

const remoteDebuggingPort = Number(process.env.BABY_MENU_REMOTE_DEBUGGING_PORT);
if (
  !windowsAdapterLaunchRequest &&
  Number.isInteger(remoteDebuggingPort) &&
  remoteDebuggingPort >= 1 &&
  remoteDebuggingPort <= 65_535
) {
  app.commandLine.appendSwitch("remote-debugging-port", String(remoteDebuggingPort));
}

if (!windowsAdapterLaunchRequest) {
  registerBabyMenuProtocolSchemes();
}

// Windows application identity must be set before app.whenReady() so the
// taskbar groups the running instance under the correct AppUserModelID.
if (!windowsAdapterLaunchRequest && process.platform === "win32") {
  const executablePath = app.getPath("exe");
  const executableName = win32.basename(executablePath, win32.extname(executablePath));
  const isDevIdentity = !app.isPackaged || executableName.toLowerCase() === "baby menu dev";
  app.setAppUserModelId(
    isDevIdentity ? "com.kunchenguid.baby-menu.dev" : "com.kunchenguid.baby-menu",
  );
}

// Single-instance lock: only the first process creates the tray, popover,
// runtime, and background services. A second process quits immediately.
let popoverWindow: BrowserWindow | null = null;
let activeTray: BabyMenuTray | null = null;
let pendingPopoverActivation = false;
let popoverActivationPromise: Promise<void> | null = null;
let latestTrayBounds: Rectangle | null = null;
let latestPopoverSize: Size = DEFAULT_POPOVER_SIZE;
let isPrimaryInstance = true;
if (!windowsAdapterLaunchRequest) {
  isPrimaryInstance = app.requestSingleInstanceLock();
  if (isPrimaryInstance) {
    app.on("second-instance", () => {
      void requestPopoverActivation();
    });
  } else {
    console.warn(
      JSON.stringify({
        event: "second-instance-rejected",
        platform: process.platform,
        isPackaged: app.isPackaged,
      }),
    );
    app.exit(0);
  }
}

export function getActiveBabyMenuTray(): BabyMenuTray | null {
  return activeTray;
}

function currentDirname(): string {
  return typeof __dirname === "string" ? __dirname : fileURLToPath(new URL(".", import.meta.url));
}

async function createPopoverWindow(): Promise<BrowserWindow> {
  if (popoverWindow && !popoverWindow.isDestroyed()) return popoverWindow;

  const dirname = currentDirname();
  popoverWindow = new BrowserWindow(createPopoverOptions(join(dirname, "../preload/index.cjs")));
  popoverWindow.on("blur", () => {
    if (process.env.BABY_MENU_KEEP_POPOVER_OPEN === "1") return;
    popoverWindow?.hide();
  });
  // Tell the renderer when the popover is shown or hidden so view refresh can pause
  // while nobody is looking. Main owns the authoritative signal: the Page Visibility
  // API is unreliable here (the popover is created show:false, and the gating would
  // silently break if backgroundThrottling were ever disabled).
  popoverWindow.on("show", () => sendPopoverVisibility(true));
  // Once the popover is hidden, drop back to accessory mode so the dock icon disappears again.
  // See setPopoverKeyWindowActive for why the popover becomes a regular-policy app while visible.
  popoverWindow.on("hide", () => {
    setPopoverKeyWindowActive(false);
    sendPopoverVisibility(false);
  });

  await loadPopoverRenderer(
    popoverWindow,
    process.env.ELECTRON_RENDERER_URL,
    join(dirname, "../renderer/index.html"),
    { isPackaged: app.isPackaged },
  );

  return popoverWindow;
}

async function togglePopover(trayBounds: Rectangle): Promise<void> {
  latestTrayBounds = trayBounds;
  const window = await createPopoverWindow();
  if (window.isVisible()) {
    window.hide();
    return;
  }

  await showPopover(trayBounds, window);
}

async function activatePopoverFromTray(): Promise<void> {
  if (!activeTray) {
    pendingPopoverActivation = true;
    return;
  }
  const trayBounds = activeTray.getBounds();
  latestTrayBounds = trayBounds;
  const window = await createPopoverWindow();
  if (window.isVisible()) {
    window.focus();
    return;
  }

  await showPopover(trayBounds, window);
}

function requestPopoverActivation(): Promise<void> | null {
  if (!activeTray) {
    pendingPopoverActivation = true;
    return null;
  }
  if (popoverActivationPromise) return popoverActivationPromise;

  pendingPopoverActivation = false;
  popoverActivationPromise = activatePopoverFromTray()
    .catch((error) => {
      console.error("[baby-menu] popover activation failed", error);
    })
    .finally(() => {
      popoverActivationPromise = null;
    });
  return popoverActivationPromise;
}

async function showPopover(trayBounds: Rectangle, window: BrowserWindow): Promise<void> {
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  window.setBounds(calculatePopoverBounds(trayBounds, display.workArea, latestPopoverSize));
  setPopoverKeyWindowActive(true);
  window.show();
  window.focus();
  // The popover is baby-menu's single screen, so opening it is the app's page
  // view. Send a Umami pageview (empty event name) so the dashboard's Views /
  // Visitors / Pages reports populate, and keep the named event for funnels.
  const telemetry = getDefaultTelemetry();
  telemetry.pageview("/popover");
  telemetry.track("popover_open");
}

// baby-menu runs as a macOS accessory app (dock hidden) so it has no permanent dock icon. But an
// accessory app's windows never become the macOS "key window", and macOS only does CSS cursor-rect
// tracking for the key window - so as an accessory app the popover's cursor never updates correctly
// (it stays the default arrow, or updates unstably and flickers). Switching to the "regular"
// activation policy while the popover is visible lets it become the key window so the cursor tracks
// correctly; switching back to "accessory" on hide keeps the dock icon from lingering. Net effect:
// the dock icon is only present for the brief moment the popover is open.
function setPopoverKeyWindowActive(active: boolean): void {
  if (process.platform !== "darwin") return;
  app.setActivationPolicy(active ? "regular" : "accessory");
  if (active) app.focus({ steal: true });
}

function sendToPopover(channel: string, payload: unknown): void {
  if (!popoverWindow || popoverWindow.isDestroyed()) return;
  popoverWindow.webContents.send(channel, payload);
}

function sendPopoverVisibility(visible: boolean): void {
  sendToPopover("baby-menu:popover:visibility", { visible });
}

function setPopoverContentSize(size: { width: number; height: number }) {
  const workArea = latestTrayBounds
    ? screen.getDisplayNearestPoint({ x: latestTrayBounds.x, y: latestTrayBounds.y }).workArea
    : undefined;
  latestPopoverSize = responsivePopoverSize(size, workArea);
  if (!latestTrayBounds || !popoverWindow || popoverWindow.isDestroyed()) return;

  const display = screen.getDisplayNearestPoint({ x: latestTrayBounds.x, y: latestTrayBounds.y });
  popoverWindow.setBounds(calculatePopoverBounds(latestTrayBounds, display.workArea, latestPopoverSize));
}

// Retained for the height-only bridge call; keeps the current width and lets the
// new width+height path own the full adaptive sizing.
function setPopoverContentHeight(height: number) {
  setPopoverContentSize({ width: latestPopoverSize.width, height });
}

export async function startBabyMenuApp(): Promise<void> {
  expandProcessPathForGuiLaunch();
  await app.whenReady();

  // Anonymous, best-effort usage telemetry. No-op unless a build-time Umami
  // website id was injected (packaged release builds only); see ./telemetry.
  const telemetry = initDefaultTelemetry({
    app: "baby-menu",
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });
  telemetry.track("app_start");

  const sourceRoot = getRepoRoot();
  const paths = resolveBabyMenuRuntimePaths(sourceRoot);
  // Seeding the bundled defaults is best-effort: it touches a user-owned
  // workspace that can be a read-only or managed (home-manager / Nix) symlink,
  // and the embedded agent self-heals it later anyway. A failure here must never
  // prevent the tray from appearing, so it is contained rather than fatal.
  try {
    await seedExtensionWorkspace({ extensionsDir: paths.extensionsDir, templateDir: paths.bundledExtensionTemplateDir });
  } catch (error) {
    console.error("[baby-menu] extension workspace seeding failed; continuing startup", error);
  }
  registerBabyMenuProtocolHandlers({ widgetCacheDir: paths.widgetCacheDir });

  if (process.platform === "darwin") {
    app.dock?.hide();
  }

  // Local Baby Menu Dev bundles must never mutate the user's login items.
  const allowOpenAtLogin = paths.isPackaged && basename(app.getPath("exe")) === "Baby Menu";
  const preferences = createPreferencesService({
    userDataDir: paths.appDataRoot,
    app,
    defaultOpenAtLogin: allowOpenAtLogin,
    allowOpenAtLogin,
  });
  const persistedPreferences = await preferences.apply();

  // Built-in claude/codex agents are driven by the bundled clean-room ACP
  // adapters. Run them with the bundled Electron as Node (ELECTRON_RUN_AS_NODE)
  // so there is no dependency on a separately-installed `node` - the same class
  // of PATH fragility that made the agent look "unavailable" before.
  const adapterLauncher = buildAdapterLauncherTokens({
    executable: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: "1" },
    windowsAppPath:
      process.platform === "win32" && !app.isPackaged
        ? app.getAppPath()
        : undefined,
  });
  // The catalog is a live runtime service: it owns agents.json and pushes
  // rebuilt registry overrides into the runtime so UI-added custom agents apply
  // immediately. agentRuntime is referenced through closures (assigned just below)
  // and only invoked after startup, so the forward reference is safe.
  let agentRuntime: BabyMenuAgentRuntime;
  const agentCatalog = createAgentCatalogController({
    agentsJsonPath: join(paths.appDataRoot, "agents.json"),
    resolveAdapterPath: (adapter) => join(paths.adaptersDir, adapter, "index.mjs"),
    adapterLauncher,
    commandExists,
    getActiveAgentName: () => agentRuntime.currentAgent,
    onOverridesChange: (overrides) => agentRuntime.setRegistryOverrides(overrides),
  });
  await agentCatalog.load();

  agentRuntime = new BabyMenuAgentRuntime(paths.appDataRoot, {
    agentName: persistedPreferences.agentName,
    registryOverrides: Object.keys(agentCatalog.overrides).length > 0 ? agentCatalog.overrides : undefined,
    telemetry,
    agentAvailability: Object.fromEntries(agentCatalog.options().map((agent) => [agent.name, agent.available])),
    executionModes: persistedPreferences.agentModes,
    wslDistribution: persistedPreferences.wslDistribution ?? "Ubuntu",
    paths: {
      extensionsDir: paths.extensionsDir,
      agentStateDir: paths.agentStateDir,
      snapshotDir: paths.devExtensionSnapshotDir,
      isPackaged: paths.isPackaged,
    },
  });
  const database = createExtensionDatabase(paths.databasePath);
  const notify = createNotifier();

  async function buildSettings(): Promise<BabyMenuSettings> {
    const wslProbe = process.platform === "win32" ? await listWslDistributions() : null;
    const current = await preferences.get();
    return {
      openAtLogin: current.openAtLogin,
      agentName: agentRuntime.currentAgent,
      agentSwitchDisabledReason: agentRuntime.agentSwitchDisabledReason,
      agents: agentCatalog.options(),
      agentModes: current.agentModes ?? {},
      wslSupported: process.platform === "win32",
      wslDistribution: current.wslDistribution ?? "Ubuntu",
      wslDistributions: wslProbe?.ok ? wslProbe.distributions : [],
    };
  }

  let agentSettingsMutation = Promise.resolve();
  function serializeAgentSettingsMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = agentSettingsMutation.then(mutation, mutation);
    agentSettingsMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  const settingsController = {
    get: buildSettings,
    async setOpenAtLogin(openAtLogin: boolean) {
      await preferences.setOpenAtLogin(openAtLogin);
      return buildSettings();
    },
    async setAgent(agentName: string) {
      await serializeAgentSettingsMutation(async () => {
        await agentRuntime.setAgent(agentName);
        const nextPreferences = await preferences.get();
        await agentRuntime.setExecutionMode(nextPreferences.agentModes?.[agentName] ?? "native", nextPreferences.wslDistribution ?? "Ubuntu");
        await preferences.setAgent(agentName);
      });
      return buildSettings();
    },
    async setAgentMode(agentName: string, mode: "native" | "wsl") {
      await serializeAgentSettingsMutation(async () => {
        if (agentName === agentRuntime.currentAgent) await agentRuntime.setExecutionMode(mode, (await preferences.get()).wslDistribution ?? "Ubuntu");
        await preferences.setAgentMode(agentName, mode);
      });
      return buildSettings();
    },
    async setWslDistribution(distribution: string) {
      await serializeAgentSettingsMutation(async () => {
        const current = await preferences.get();
        if ((current.agentModes?.[agentRuntime.currentAgent] ?? "native") === "wsl") await agentRuntime.setExecutionMode("wsl", distribution);
        await preferences.setWslDistribution(distribution);
      });
      return buildSettings();
    },
    async addAgent(input: BabyMenuCustomAgentInput) {
      await agentCatalog.addAgent(input);
      return buildSettings();
    },
    async updateAgent(name: string, input: { label?: string; command: string }) {
      await agentCatalog.updateAgent(name, input);
      return buildSettings();
    },
    async removeAgent(name: string) {
      await agentCatalog.removeAgent(name);
      return buildSettings();
    },
  };

  const serverActions = createServerActionRegistry({
    rootDir: paths.appDataRoot,
    actionRoots: [paths.extensionsDir],
    cacheDir: paths.serverActionCacheDir,
    db: database,
    notify,
  });
  const widgetRegistryOptions = {
    rootDir: paths.appDataRoot,
    extensionsDir: paths.extensionsDir,
    mode: (paths.isPackaged ? "compiled" : "vite") as "compiled" | "vite",
    widgetCacheDir: paths.widgetCacheDir,
  };
  const widgetModules = createWidgetModuleRegistry(widgetRegistryOptions);
  const layoutModules = createLayoutModuleRegistry(widgetRegistryOptions);

  const updateChecker = createUpdateChecker({
    currentVersion: app.getVersion(),
    openExternal: (url) => shell.openExternal(url),
    // Dev/source builds are never "behind" a release, so force the indicator on
    // there to make it visible while developing. Packaged builds do the real check.
    simulateUpdate: !app.isPackaged,
  });

  registerIpcHandlers(
    paths.appDataRoot,
    agentRuntime,
    serverActions,
    widgetModules,
    {
      setContentHeight: setPopoverContentHeight,
      setContentSize: setPopoverContentSize,
      getVisibility: () => ({ visible: popoverWindow?.isVisible() ?? false }),
    },
    settingsController,
    {
      quit: () => app.quit(),
      getUpdateStatus: () => updateChecker.getStatus(),
      openReleasePage: () => updateChecker.openReleasePage(),
    },
    { recipesDir: paths.recipesDir, database, layoutModules },
  );
  activeTray = createBabyMenuTray(
    (bounds) => {
      void togglePopover(bounds);
    },
    {
      iconPath: paths.trayIconPath,
      onOpen: () => {
        void requestPopoverActivation();
      },
      onQuit: () => app.quit(),
    },
  );

  if (pendingPopoverActivation || process.env.BABY_MENU_OPEN_POPOVER_ON_START === "1") {
    await requestPopoverActivation();
  }

  // Background tasks run on their own cadence in the main process, regardless of whether
  // the popover is open, and notify open widgets to re-read when a run completes.
  const backgroundTasks = createBackgroundTaskScheduler({
    source: createBackgroundTaskSource({
      rootDir: paths.appDataRoot,
      actionRoots: [paths.extensionsDir],
      cacheDir: paths.serverActionCacheDir,
    }),
    context: { rootDir: paths.appDataRoot, db: database, notify },
    watchDir: paths.extensionsDir,
    onTaskRun: (extensionId) => {
      if (!popoverWindow?.isVisible()) return;
      sendToPopover("baby-menu:background:update", { extensionId });
    },
  });
  void backgroundTasks.start();

  app.on("activate", () => undefined);
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", () => {
    backgroundTasks.stop();
    database.close();
    void telemetry.close(1_000);
  });
}

if (!process.env.VITEST) {
  if (windowsAdapterLaunchRequest) {
    void runWindowsAdapterLauncher(windowsAdapterLaunchRequest).then(
      (exitCode) => app.exit(exitCode),
      (error) => {
        console.error("[baby-menu] Windows adapter launcher failed", error);
        app.exit(1);
      },
    );
  } else if (isPrimaryInstance) {
    // Last-resort guard: an unhandled rejection here would otherwise leave a dead
    // app with a lingering dock icon and no tray, with no diagnostic in the logs.
    startBabyMenuApp().catch((error) => {
      console.error("[baby-menu] fatal startup error", error);
    });
  }
}
