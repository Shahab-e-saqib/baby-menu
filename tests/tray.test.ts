import { beforeEach, describe, expect, it, vi } from "vitest";

const image = {
  setTemplateImage: vi.fn(),
};

const tray = {
  getBounds: vi.fn(),
  on: vi.fn(),
  setTitle: vi.fn(),
  setToolTip: vi.fn(),
};

const createFromDataURL = vi.fn((_dataUrl: string) => image);
const Tray = vi.fn(function MockTray() {
  return tray;
});

vi.mock("electron", () => ({
  nativeImage: { createFromDataURL },
  Tray,
}));

describe("createBabyMenuTray", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a visible menu bar status item", async () => {
    const { createBabyMenuTray } = await import("../src/main/tray");

    createBabyMenuTray(vi.fn());
    const dataUrl = createFromDataURL.mock.calls[0]?.[0] ?? "";
    const svg = decodeURIComponent(dataUrl.replace("data:image/svg+xml;utf8,", ""));

    expect(svg).toContain('stroke="white"');
    expect(image.setTemplateImage).not.toHaveBeenCalledWith(true);
    expect(tray.setTitle).toHaveBeenCalledWith("Baby");
    expect(tray.setToolTip).toHaveBeenCalledWith("baby-menu");
  });
});
