import { readdir } from "node:fs/promises";
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
