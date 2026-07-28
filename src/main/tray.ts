import { Menu, nativeImage, Tray, type Rectangle } from "electron";

export type BabyMenuTray = {
  tray: Tray;
  getBounds: () => Rectangle;
};

export type BabyMenuTrayOptions = {
  iconPath: string;
  onOpen?: (bounds: Rectangle) => void;
  onQuit?: () => void;
};

export function createBabyMenuTray(onClick: (bounds: Rectangle) => void, options: BabyMenuTrayOptions): BabyMenuTray {
  const icon = nativeImage.createFromPath(options.iconPath);

  if (process.platform === "darwin") {
    icon.setTemplateImage(true);
  }

  const tray = new Tray(icon);
  tray.setToolTip(process.platform === "darwin" ? "baby-menu" : "Baby Menu");
  tray.on("click", (_event, bounds) => onClick(bounds));

  if (process.platform === "win32") {
    const contextMenu = Menu.buildFromTemplate([
      { label: "Open Baby Menu", click: () => options.onOpen?.(tray.getBounds()) },
      { type: "separator" },
      { label: "Quit", click: () => options.onQuit?.() },
    ]);
    tray.setContextMenu(contextMenu);
  }

  return {
    tray,
    getBounds: () => tray.getBounds(),
  };
}
