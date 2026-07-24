import { join } from "node:path";
import packageJson from "../package.json";
import { describe, expect, it, vi } from "vitest";

async function loadLauncher() {
  return import(new URL("../scripts/dev.mjs", import.meta.url).href) as Promise<{
    ACTIVE_ENV: string;
    EXTENSIONS_DIR_ENV: string;
    runDev: (options: Record<string, unknown>) => number;
    resetDevWorkspace: (options: Record<string, unknown>) => number;
  }>;
}

function createHarness() {
  const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const spawnCalls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean }> = [];
  const createdDirs: string[] = [];
  const removedDirs: string[] = [];
  const copiedFiles: Array<{ source: string; destination: string }> = [];
  const copiedDirectories: Array<{ source: string; destination: string }> = [];

  return {
    execCalls,
    spawnCalls,
    createdDirs,
    removedDirs,
    copiedFiles,
    copiedDirectories,
    mkdirSync: vi.fn((filePath: string) => createdDirs.push(filePath)),
    rmSync: vi.fn((filePath: string) => removedDirs.push(filePath)),
    copyFileSync: vi.fn((source: string, destination: string) => copiedFiles.push({ source, destination })),
    cpSync: vi.fn((source: string, destination: string) => copiedDirectories.push({ source, destination })),
    execFileSync: vi.fn((command: string, args: string[], options?: { cwd?: string }) => {
      execCalls.push({ command, args, cwd: options?.cwd });
      if (args.join(" ") === "rev-parse --show-toplevel") return "/repo\n";
      return "";
    }),
    spawnSync: vi.fn((command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean }) => {
      spawnCalls.push({ command, args, cwd: options?.cwd, env: options?.env, shell: options?.shell });
      return { status: 0 };
    }),
  };
}

describe("dev launcher", () => {
  it("wires pnpm dev through the local dev launcher", () => {
    expect(packageJson.scripts.dev).toBe("node scripts/dev.mjs");
    expect(packageJson.scripts["dev:reset"]).toBe("node scripts/dev.mjs --reset");
  });

  it("runs electron-vite directly when already inside the dev launcher", async () => {
    const { ACTIVE_ENV, runDev } = await loadLauncher();
    const harness = createHarness();

    const status = runDev({
      cwd: "/repo",
      env: { [ACTIVE_ENV]: "1" },
      ...harness,
    });

    expect(status).toBe(0);
    expect(harness.execCalls).toEqual([]);
    expect(harness.spawnCalls).toEqual([
      {
        command: "pnpm",
        args: ["exec", "electron-vite", "dev"],
        cwd: "/repo",
        env: expect.objectContaining({ [ACTIVE_ENV]: "1" }),
        shell: true,
      },
    ]);
  });

  it("prepares extensions-dev and runs electron-vite from the current checkout", async () => {
    const { ACTIVE_ENV, EXTENSIONS_DIR_ENV, runDev } = await loadLauncher();
    const harness = createHarness();

    const status = runDev({ cwd: "/repo", env: {}, ...harness });

    expect(status).toBe(0);
    expect(harness.createdDirs).toContain(join("/repo", "extensions-dev"));
    expect(harness.copiedFiles).toContainEqual({
      source: join("/repo", "extensions", "AGENTS.md"),
      destination: join("/repo", "extensions-dev", "AGENTS.md"),
    });
    expect(harness.copiedFiles).toContainEqual({
      source: join("/repo", "extensions", "babymenu-env.d.ts"),
      destination: join("/repo", "extensions-dev", "babymenu-env.d.ts"),
    });
    expect(harness.copiedDirectories).toContainEqual({
      source: join("/repo", "extensions", "recipes"),
      destination: join("/repo", "extensions-dev", "recipes"),
    });
    expect(harness.execCalls).toEqual([
      { command: "git", args: ["rev-parse", "--show-toplevel"], cwd: "/repo" },
      { command: "node", args: ["scripts/build-adapters.mjs"], cwd: "/repo" },
    ]);
    expect(harness.spawnCalls).toEqual([
      {
        command: "pnpm",
        args: ["exec", "electron-vite", "dev"],
        cwd: "/repo",
        env: expect.objectContaining({
          [ACTIVE_ENV]: "1",
          [EXTENSIONS_DIR_ENV]: join("/repo", "extensions-dev"),
        }),
        shell: true,
      },
    ]);
  });

  it("honors an explicit dev extension workspace", async () => {
    const { EXTENSIONS_DIR_ENV, runDev } = await loadLauncher();
    const harness = createHarness();

    const status = runDev({
      cwd: "/repo",
      env: { BABY_MENU_DEV_EXTENSIONS_DIR: "/tmp/baby-menu-dev-extensions" },
      ...harness,
    });

    expect(status).toBe(0);
    expect(harness.createdDirs).toContain("/tmp/baby-menu-dev-extensions");
    expect(harness.copiedFiles).toContainEqual({
      source: join("/repo", "extensions", "AGENTS.md"),
      destination: join("/tmp/baby-menu-dev-extensions", "AGENTS.md"),
    });
    expect(harness.copiedDirectories).toContainEqual({
      source: join("/repo", "extensions", "recipes"),
      destination: join("/tmp/baby-menu-dev-extensions", "recipes"),
    });
    expect(harness.spawnCalls[0]?.env).toEqual(expect.objectContaining({
      [EXTENSIONS_DIR_ENV]: "/tmp/baby-menu-dev-extensions",
    }));
  });

  it("launches pnpm through a shell so pnpm.cmd resolves on Windows", async () => {
    // Node cannot spawn a `.cmd`/`.bat` without `shell: true`; pnpm is `pnpm.cmd`
    // on Windows. The dev launcher must invoke pnpm through a shell on every
    // platform so the Windows developer workflow works out of the box.
    const { ACTIVE_ENV, runDev } = await loadLauncher();
    const harness = createHarness();

    runDev({ cwd: "/repo", env: { [ACTIVE_ENV]: "1" }, ...harness });

    expect(harness.spawnCalls[0]?.shell).toBe(true);
  });

  it("removes extensions-dev before running dev on reset", async () => {
    const { ACTIVE_ENV, EXTENSIONS_DIR_ENV, resetDevWorkspace } = await loadLauncher();
    const devExtensionsDir = join("/repo", "extensions-dev");
    const harness = createHarness();

    const status = resetDevWorkspace({ cwd: "/repo", env: {}, ...harness });

    expect(status).toBe(0);
    expect(harness.removedDirs).toContain(devExtensionsDir);
    // Reset must also clear the embedded agent's persistent conversation, or the
    // agent rebuilds widgets from its prior context and never re-reads updated
    // recipes. The session store lives outside extensions-dev, under .cache.
    expect(harness.removedDirs).toContain(join("/repo", ".cache", "baby-menu", "acp-sessions"));
    expect(harness.createdDirs).toContain(devExtensionsDir);
    expect(harness.copiedFiles).toContainEqual({
      source: join("/repo", "extensions", "AGENTS.md"),
      destination: join(devExtensionsDir, "AGENTS.md"),
    });
    expect(harness.copiedDirectories).toContainEqual({
      source: join("/repo", "extensions", "recipes"),
      destination: join(devExtensionsDir, "recipes"),
    });
    expect(harness.spawnCalls).toEqual([
      {
        command: "pnpm",
        args: ["exec", "electron-vite", "dev"],
        cwd: "/repo",
        env: expect.objectContaining({
          [ACTIVE_ENV]: "1",
          [EXTENSIONS_DIR_ENV]: devExtensionsDir,
        }),
        shell: true,
      },
    ]);
  });
});
