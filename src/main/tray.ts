import { nativeImage, Tray, type Rectangle } from "electron";

export type BabyMenuTray = {
  tray: Tray;
  getBounds: () => Rectangle;
};

const TEMPLATE_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path fill="black" stroke="white" stroke-width="1.4" stroke-linejoin="round" paint-order="stroke fill" d="M9 1.5c2.3 0 4.2 1.8 4.2 4.1 0 1.5-.8 2.8-2 3.5 2.1.7 3.6 2.4 3.6 4.3v1.1H3.2v-1.1c0-1.9 1.5-3.6 3.6-4.3-1.2-.7-2-2-2-3.5C4.8 3.3 6.7 1.5 9 1.5Zm0 2C7.8 3.5 6.8 4.4 6.8 5.6S7.8 7.8 9 7.8s2.2-1 2.2-2.2S10.2 3.5 9 3.5Zm0 7.3c-1.7 0-3.1.8-3.6 1.7h7.2c-.5-.9-1.9-1.7-3.6-1.7Z"/></svg>`,
  );

export function createBabyMenuTray(onClick: (bounds: Rectangle) => void): BabyMenuTray {
  const icon = nativeImage.createFromDataURL(TEMPLATE_ICON);

  const tray = new Tray(icon);
  tray.setTitle("Baby");
  tray.setToolTip("baby-menu");
  tray.on("click", (_event, bounds) => onClick(bounds));

  return {
    tray,
    getBounds: () => tray.getBounds(),
  };
}
