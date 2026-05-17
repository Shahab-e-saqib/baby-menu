import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DevExtensionChangeSession } from "../src/main/dev-extension-change-session";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("DevExtensionChangeSession", () => {
  it("rolls back ignored extension workspace changes to the pre-turn contents", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "baby-menu-dev-extension-session-"));
    const extensionsDir = join(rootDir, "extensions-dev");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(join(extensionsDir, "AGENTS.md"), "rules\n");
    await writeFile(join(extensionsDir, "existing.txt"), "before\n");

    const session = await DevExtensionChangeSession.begin(extensionsDir, join(rootDir, ".cache", "snapshots"));
    await writeFile(join(extensionsDir, "existing.txt"), "after\n");
    await mkdir(join(extensionsDir, "demo"));
    await writeFile(join(extensionsDir, "demo", "widget.tsx"), "export const widget = true;\n");

    const result = await session.rollback();

    expect(result.ok).toBe(true);
    await expect(readFile(join(extensionsDir, "existing.txt"), "utf8")).resolves.toBe("before\n");
    await expect(readFile(join(extensionsDir, "AGENTS.md"), "utf8")).resolves.toBe("rules\n");
    await expect(pathExists(join(extensionsDir, "demo"))).resolves.toBe(false);
  });

  it("treats keep as accepting dev extension changes without creating a git commit", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "baby-menu-dev-extension-session-"));
    const extensionsDir = join(rootDir, "extensions-dev");
    await mkdir(extensionsDir, { recursive: true });
    const session = await DevExtensionChangeSession.begin(extensionsDir, join(rootDir, ".cache", "snapshots"));
    await writeFile(join(extensionsDir, "new-widget.tsx"), "export const widget = true;\n");

    const result = await session.save();

    expect(result).toEqual({ ok: true });
    await expect(readFile(join(extensionsDir, "new-widget.tsx"), "utf8")).resolves.toContain("widget");
    expect(session.canRollback).toBe(false);
  });
});
