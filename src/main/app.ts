import { app, BrowserWindow, screen, type Rectangle } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoRoot } from "../shared/paths";
import { registerIpcHandlers } from "./ipc";
import {
  DEFAULT_POPOVER_SIZE,
  calculatePopoverBounds,
  createPopoverOptions,
  loadPopoverRenderer,
  responsivePopoverSize,
  type Size,
} from "./popover";
import { createBabyMenuTray, type BabyMenuTray } from "./tray";

let popoverWindow: BrowserWindow | null = null;
let activeTray: BabyMenuTray | null = null;
let latestTrayBounds: Rectangle | null = null;
let latestPopoverSize: Size = DEFAULT_POPOVER_SIZE;

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

  await loadPopoverRenderer(
    popoverWindow,
    process.env.ELECTRON_RENDERER_URL,
    join(dirname, "../renderer/index.html"),
    { isPackaged: app.isPackaged },
  );

  return popoverWindow;
}

async function togglePopover(trayBounds: Rectangle): Promise<void> {
  const window = await createPopoverWindow();
  latestTrayBounds = trayBounds;
  if (window.isVisible()) {
    window.hide();
    return;
  }

  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  window.setBounds(calculatePopoverBounds(trayBounds, display.workArea, latestPopoverSize));
  window.show();
  window.focus();
}

function setPopoverContentHeight(height: number) {
  latestPopoverSize = responsivePopoverSize(height);
  if (!latestTrayBounds || !popoverWindow || popoverWindow.isDestroyed()) return;

  const display = screen.getDisplayNearestPoint({ x: latestTrayBounds.x, y: latestTrayBounds.y });
  popoverWindow.setBounds(calculatePopoverBounds(latestTrayBounds, display.workArea, latestPopoverSize));
}

export async function startBabyMenuApp(): Promise<void> {
  await app.whenReady();

  if (process.platform === "darwin") {
    app.dock?.hide();
  }

  registerIpcHandlers(getRepoRoot(), undefined, undefined, undefined, { setContentHeight: setPopoverContentHeight });
  activeTray = createBabyMenuTray((bounds) => {
    void togglePopover(bounds);
  });

  app.on("activate", () => undefined);
  app.on("window-all-closed", () => undefined);
}

if (!process.env.VITEST) {
  void startBabyMenuApp();
}
