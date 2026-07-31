#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");

const SVG_PATH = join(repoRoot, "assets", "app-icon.svg");
const APP_ICO_PATH = join(repoRoot, "assets", "app-icon.ico");
const TRAY_ICO_PATH = join(repoRoot, "assets", "tray", "baby_menu.ico");

function icoDirEntry(width, height, dataSize, dataOffset) {
  const w = width >= 256 ? 0 : width;
  const h = height >= 256 ? 0 : height;
  const buf = Buffer.alloc(16);
  buf.writeUInt8(w, 0);
  buf.writeUInt8(h, 1);
  buf.writeUInt8(0, 2);
  buf.writeUInt8(0, 3);
  buf.writeUInt16LE(1, 4);
  buf.writeUInt16LE(32, 6);
  buf.writeUInt32LE(dataSize, 8);
  buf.writeUInt32LE(dataOffset, 12);
  return buf;
}

function assembleIco(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6;
  const entrySize = 16;

  let offset = headerSize + count * entrySize;
  const entries = pngBuffers.map((png) => {
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const entry = icoDirEntry(width, height, png.length, offset);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([
    Buffer.from([0, 0, 1, 0, count & 0xff, (count >> 8) & 0xff]),
    ...entries,
    ...pngBuffers,
  ]);
}

async function main() {
  const { default: sharp } = await import("sharp");
  const tmp = mkdtempSync(join(tmpdir(), "baby-menu-ico-"));

  try {
    const svgBuffer = readFileSync(SVG_PATH);

    async function renderPng(size) {
      const png = await sharp(svgBuffer).resize(size, size).png().toBuffer();
      return png;
    }

    const appSizes = [16, 24, 32, 48, 64, 256];
    const appPngs = await Promise.all(appSizes.map(renderPng));
    const appIco = assembleIco(appPngs);
    writeFileSync(APP_ICO_PATH, appIco);
    console.log(`Wrote ${APP_ICO_PATH} (${appIco.length} bytes, ${appSizes.length} entries)`);

    const traySizes = [16, 32];
    const trayPngs = await Promise.all(traySizes.map(renderPng));
    const trayIco = assembleIco(trayPngs);
    writeFileSync(TRAY_ICO_PATH, trayIco);
    console.log(`Wrote ${TRAY_ICO_PATH} (${trayIco.length} bytes, ${traySizes.length} entries)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
