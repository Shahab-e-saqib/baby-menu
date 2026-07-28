import { beforeEach, describe, expect, it, vi } from "vitest";

const image = {
  setTemplateImage: vi.fn(),
};

let trayOnHandlers: Record<string, (...args: unknown[]) => void> = {};
let setContextMenuHandler: ((menu: unknown) => void) | undefined;

const tray = {
  getBounds: vi.fn(() => ({ x: 0, y: 0, width: 16, height: 16 })),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    trayOnHandlers[event] = handler;
  }),
  setContextMenu: vi.fn(),
  setTitle: vi.fn(),
  setToolTip: vi.fn(),
};

const createFromPath = vi.fn((_path: string) => image);
const Tray = vi.fn(function MockTray() {
  return tray;
});
const buildFromTemplate = vi.fn((template: unknown[]) => template);

vi.mock("electron", () => ({
  Menu: { buildFromTemplate },
  nativeImage: { createFromPath },
  Tray,
}));

describe("createBabyMenuTray", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trayOnHandlers = {};
    setContextMenuHandler = undefined;
  });

  describe("on macOS", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin" });
    });

    it("creates a template menu bar icon from the packaged tray asset", async () => {
      const { createBabyMenuTray } = await import("../src/main/tray");

      createBabyMenuTray(vi.fn(), { iconPath: "/repo/assets/tray/baby_menuTemplate.png" });

      expect(createFromPath).toHaveBeenCalledWith("/repo/assets/tray/baby_menuTemplate.png");
      expect(image.setTemplateImage).toHaveBeenCalledWith(true);
      expect(Tray).toHaveBeenCalledWith(image);
      expect(tray.setTitle).not.toHaveBeenCalled();
      expect(tray.setToolTip).toHaveBeenCalledWith("baby-menu");
    });

    it("does not create a context menu", async () => {
      const { createBabyMenuTray } = await import("../src/main/tray");

      createBabyMenuTray(vi.fn(), {
        iconPath: "/repo/assets/tray/baby_menuTemplate.png",
        onOpen: vi.fn(),
        onQuit: vi.fn(),
      });

      expect(tray.setContextMenu).not.toHaveBeenCalled();
    });
  });

  describe("on Windows", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32" });
    });

    it("loads the ICO icon and does not set template image", async () => {
      const { createBabyMenuTray } = await import("../src/main/tray");

      createBabyMenuTray(vi.fn(), { iconPath: "/repo/assets/tray/baby_menu.ico" });

      expect(createFromPath).toHaveBeenCalledWith("/repo/assets/tray/baby_menu.ico");
      expect(image.setTemplateImage).not.toHaveBeenCalled();
      expect(Tray).toHaveBeenCalledWith(image);
    });

    it("sets tooltip to Baby Menu", async () => {
      const { createBabyMenuTray } = await import("../src/main/tray");

      createBabyMenuTray(vi.fn(), { iconPath: "/repo/assets/tray/baby_menu.ico" });

      expect(tray.setToolTip).toHaveBeenCalledWith("Baby Menu");
    });

    it("builds a context menu with Open Baby Menu and Quit", async () => {
      const { createBabyMenuTray } = await import("../src/main/tray");

      createBabyMenuTray(vi.fn(), {
        iconPath: "/repo/assets/tray/baby_menu.ico",
        onOpen: vi.fn(),
        onQuit: vi.fn(),
      });

      expect(tray.setContextMenu).toHaveBeenCalledOnce();
      const menu = tray.setContextMenu.mock.calls[0][0] as Array<{ label: string }>;
      expect(menu).toHaveLength(3);
      expect(menu[0]).toMatchObject({ label: "Open Baby Menu" });
      expect(menu[1]).toMatchObject({ type: "separator" });
      expect(menu[2]).toMatchObject({ label: "Quit" });
    });

    it("invokes onOpen when Open Baby Menu is clicked in context menu", async () => {
      const onOpen = vi.fn();
      const { createBabyMenuTray } = await import("../src/main/tray");

      createBabyMenuTray(vi.fn(), {
        iconPath: "/repo/assets/tray/baby_menu.ico",
        onOpen,
        onQuit: vi.fn(),
      });

      const menu = tray.setContextMenu.mock.calls[0][0] as Array<{ click?: () => void }>;
      const openItem = menu[0];
      openItem.click?.();
      expect(onOpen).toHaveBeenCalledOnce();
    });

    it("invokes onQuit when Quit is clicked in context menu", async () => {
      const onQuit = vi.fn();
      const { createBabyMenuTray } = await import("../src/main/tray");

      createBabyMenuTray(vi.fn(), {
        iconPath: "/repo/assets/tray/baby_menu.ico",
        onOpen: vi.fn(),
        onQuit,
      });

      const menu = tray.setContextMenu.mock.calls[0][0] as Array<{ click?: () => void }>;
      const quitItem = menu[2];
      quitItem.click?.();
      expect(onQuit).toHaveBeenCalledOnce();
    });

    it("does not require onOpen or onQuit callbacks", async () => {
      const { createBabyMenuTray } = await import("../src/main/tray");

      createBabyMenuTray(vi.fn(), { iconPath: "/repo/assets/tray/baby_menu.ico" });

      expect(tray.setContextMenu).toHaveBeenCalledOnce();
      const menu = tray.setContextMenu.mock.calls[0][0] as Array<{ click?: () => void }>;
      expect(() => menu[0].click?.()).not.toThrow();
      expect(() => menu[2].click?.()).not.toThrow();
    });
  });
});
