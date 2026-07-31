import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Read an ICO file and parse its directory entries.
 * Returns the header fields plus an array of parsed directory entries.
 */
function parseIco(data: Buffer) {
  expect(data.byteLength).toBeGreaterThanOrEqual(6);
  const reserved = data.readUInt16LE(0);
  const type = data.readUInt16LE(2);
  const count = data.readUInt16LE(4);
  expect(reserved).toBe(0);
  expect(type).toBe(1);
  expect(count).toBeGreaterThan(0);

  const entries: Array<{
    width: number;
    height: number;
    colors: number;
    planes: number;
    bpp: number;
    dataSize: number;
    dataOffset: number;
  }> = [];

  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const rawW = data.readUInt8(off);
    const rawH = data.readUInt8(off + 1);
    entries.push({
      width: rawW === 0 ? 256 : rawW,
      height: rawH === 0 ? 256 : rawH,
      colors: data.readUInt8(off + 2),
      planes: data.readUInt16LE(off + 4),
      bpp: data.readUInt16LE(off + 6),
      dataSize: data.readUInt32LE(off + 8),
      dataOffset: data.readUInt32LE(off + 12),
    });
  }

  return { count, entries };
}

describe("Windows icon assets", () => {
  describe("app-icon.ico", () => {
    const appIcoPath = resolve(import.meta.dirname, "../assets/app-icon.ico");

    it("exists as a file", async () => {
      await expect(stat(appIcoPath).then((f) => f.isFile())).resolves.toBe(true);
    });

    it("contains six icon entries (16, 24, 32, 48, 64, 256)", async () => {
      const data = await readFile(appIcoPath);
      const ico = parseIco(data);
      expect(ico.count).toBe(6);
    });

    it("includes all expected standard sizes", async () => {
      const data = await readFile(appIcoPath);
      const ico = parseIco(data);

      const expectedDims = [
        { width: 16, height: 16 },
        { width: 24, height: 24 },
        { width: 32, height: 32 },
        { width: 48, height: 48 },
        { width: 64, height: 64 },
        { width: 256, height: 256 },
      ];

      expect(ico.entries).toHaveLength(expectedDims.length);
      for (const [i, expected] of expectedDims.entries()) {
        expect(ico.entries[i].width).toBe(expected.width);
        expect(ico.entries[i].height).toBe(expected.height);
      }
    });

    it("declares 32 bits per pixel for every entry", async () => {
      const data = await readFile(appIcoPath);
      const ico = parseIco(data);
      for (const [i, entry] of ico.entries.entries()) {
        expect(entry.bpp).toBe(32);
      }
    });

    it("embeds valid PNG image data for every entry", async () => {
      const data = await readFile(appIcoPath);
      const ico = parseIco(data);
      for (const [i, entry] of ico.entries.entries()) {
        const slice = data.subarray(entry.dataOffset, entry.dataOffset + entry.dataSize);
        expect(slice.byteLength).toBe(entry.dataSize);
        expect(slice.subarray(0, PNG_MAGIC.byteLength)).toEqual(PNG_MAGIC);
        // Verify the PNG IHDR dimensions match the directory entry
        const pngWidth = slice.readUInt32BE(16);
        const pngHeight = slice.readUInt32BE(20);
        expect(pngWidth).toBe(entry.width);
        expect(pngHeight).toBe(entry.height);
      }
    });

  });

  describe("tray Windows icon", () => {
    const trayIcoPath = resolve(import.meta.dirname, "../assets/tray/baby_menu.ico");

    it("exists as a file", async () => {
      await expect(stat(trayIcoPath).then((f) => f.isFile())).resolves.toBe(true);
    });

    it("contains two icon entries (16 and 32)", async () => {
      const data = await readFile(trayIcoPath);
      const ico = parseIco(data);
      expect(ico.count).toBe(2);
    });

    it("includes tray-appropriate sizes", async () => {
      const data = await readFile(trayIcoPath);
      const ico = parseIco(data);
      expect(ico.entries).toHaveLength(2);
      expect(ico.entries[0].width).toBe(16);
      expect(ico.entries[0].height).toBe(16);
      expect(ico.entries[1].width).toBe(32);
      expect(ico.entries[1].height).toBe(32);
    });

    it("declares 32 bits per pixel", async () => {
      const data = await readFile(trayIcoPath);
      const ico = parseIco(data);
      expect(ico.entries.every((e) => e.bpp === 32)).toBe(true);
    });

    it("embeds valid PNG image data for every entry", async () => {
      const data = await readFile(trayIcoPath);
      const ico = parseIco(data);
      for (const [i, entry] of ico.entries.entries()) {
        const slice = data.subarray(entry.dataOffset, entry.dataOffset + entry.dataSize);
        expect(slice.byteLength).toBe(entry.dataSize);
        expect(slice.subarray(0, PNG_MAGIC.byteLength)).toEqual(PNG_MAGIC);
        const pngWidth = slice.readUInt32BE(16);
        const pngHeight = slice.readUInt32BE(20);
        expect(pngWidth).toBe(entry.width);
        expect(pngHeight).toBe(entry.height);
      }
    });

  });
});
