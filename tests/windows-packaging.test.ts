import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const NATIVE_BINARY = "lightningcss.win32-x64-msvc.node";
const projectRoot = resolve(__dirname, "..");

async function findNamedFile(root: string, name: string): Promise<string | null> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const match = await findNamedFile(path, name);
      if (match) return match;
    }
  }
  return null;
}

describe("Windows package native dependencies", () => {
  it("installs the Windows x64 lightningcss binary", async () => {
    const match = await findNamedFile(join(projectRoot, "node_modules", ".pnpm"), NATIVE_BINARY);
    expect(match).not.toBeNull();
  });

  it.skipIf(!process.env.BABY_MENU_WINDOWS_PACKAGE_DIR)(
    "includes the Windows x64 lightningcss binary in app.asar.unpacked",
    async () => {
      const packageDir = process.env.BABY_MENU_WINDOWS_PACKAGE_DIR;
      if (!packageDir) throw new Error("BABY_MENU_WINDOWS_PACKAGE_DIR is required");
      const unpackedModules = join(packageDir, "resources", "app.asar.unpacked", "node_modules");
      const match = await findNamedFile(unpackedModules, NATIVE_BINARY);
      expect(match).not.toBeNull();
    },
  );
});

// SQLite is not bundled as a separate platform binary because Electron >= 33
// provides node:sqlite as a built-in module. Only native binaries that
// Electron does not supply (lightningcss, esbuild, Tailwind Oxide etc.)
// are included in app.asar.unpacked/node_modules.
describe.skipIf(!process.env.BABY_MENU_WINDOWS_PACKAGE_DIR)(
  "Windows package runtime content",
  () => {
    const packageDir = process.env.BABY_MENU_WINDOWS_PACKAGE_DIR;
    if (!packageDir) return;
    const resources = join(packageDir, "resources");
    const unpacked = join(resources, "app.asar.unpacked");

    describe("unpacked bundled ACP adapter entrypoints", () => {
      const adaptersDir = join(unpacked, "out", "adapters");

      it("includes the Claude adapter entrypoint", async () => {
        await expect(stat(join(adaptersDir, "claude", "index.mjs")).then((s) => s.isFile())).resolves.toBe(true);
      });

      it("includes the Codex adapter entrypoint", async () => {
        await expect(stat(join(adaptersDir, "codex", "index.mjs")).then((s) => s.isFile())).resolves.toBe(true);
      });
    });

    describe("bundled extension-template files", () => {
      const templateDir = join(resources, "extensions-template");

      it("includes AGENTS.md", async () => {
        await expect(stat(join(templateDir, "AGENTS.md")).then((s) => s.isFile())).resolves.toBe(true);
      });

      it("includes babymenu-env.d.ts", async () => {
        await expect(stat(join(templateDir, "babymenu-env.d.ts")).then((s) => s.isFile())).resolves.toBe(true);
      });

      it("includes hello-world/widget.tsx", async () => {
        await expect(stat(join(templateDir, "hello-world", "widget.tsx")).then((s) => s.isFile())).resolves.toBe(true);
      });

      it("includes hello-world/components.tsx", async () => {
        await expect(stat(join(templateDir, "hello-world", "components.tsx")).then((s) => s.isFile())).resolves.toBe(true);
      });

      it("includes recipe files", async () => {
        const recipesDir = join(templateDir, "recipes");
        const entries = await readdir(recipesDir);
        expect(entries).toContain("claude-code-quota.html");
        expect(entries).toContain("codex-quota.html");
        expect(entries).toContain("grok-quota.html");
        expect(entries).toHaveLength(5);
      });
    });

    describe("Windows tray resources", () => {
      const trayDir = join(resources, "tray");

      it("includes baby_menu.ico", async () => {
        await expect(stat(join(trayDir, "baby_menu.ico")).then((s) => s.isFile())).resolves.toBe(true);
      });

      it("includes baby_menuTemplate.png", async () => {
        await expect(stat(join(trayDir, "baby_menuTemplate.png")).then((s) => s.isFile())).resolves.toBe(true);
      });

      it("includes baby_menuTemplate@1x.png", async () => {
        await expect(stat(join(trayDir, "baby_menuTemplate@1x.png")).then((s) => s.isFile())).resolves.toBe(true);
      });

      it("includes baby_menuTemplate@2x.png", async () => {
        await expect(stat(join(trayDir, "baby_menuTemplate@2x.png")).then((s) => s.isFile())).resolves.toBe(true);
      });

      it("includes baby_menuTemplate@3x.png", async () => {
        await expect(stat(join(trayDir, "baby_menuTemplate@3x.png")).then((s) => s.isFile())).resolves.toBe(true);
      });
    });
  },
);
