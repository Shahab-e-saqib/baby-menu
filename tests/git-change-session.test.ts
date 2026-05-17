import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitChangeSession } from "../src/main/git-change-session";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "baby-menu-git-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "tests@example.com"]);
  await git(repo, ["config", "user.name", "Baby Menu Tests"]);
  await writeFile(join(repo, "tracked.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

describe("GitChangeSession", () => {
  it("refuses to begin an editing session when the tree is already dirty", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "tracked.txt"), "user change\n");

    const session = await GitChangeSession.begin(repo);

    expect(session.startedClean).toBe(false);
    expect(session.canSave).toBe(false);
    expect(session.canRollback).toBe(false);
  });

  it("saves a clean session by creating a commit", async () => {
    const repo = await createRepo();
    const session = await GitChangeSession.begin(repo);
    await writeFile(join(repo, "tracked.txt"), "agent change\n");

    const result = await session.save("Save baby-menu agent changes");
    const { stdout } = await git(repo, ["log", "-1", "--pretty=%s"]);

    expect(result.ok).toBe(true);
    expect(stdout.trim()).toBe("Save baby-menu agent changes");
  });

  it("rolls back a clean session to the recorded head", async () => {
    const repo = await createRepo();
    const session = await GitChangeSession.begin(repo);
    await writeFile(join(repo, "tracked.txt"), "agent change\n");
    await writeFile(join(repo, "new-widget.ts"), "export const widget = true;\n");

    const result = await session.rollback();
    const content = await readFile(join(repo, "tracked.txt"), "utf8");
    const status = await git(repo, ["status", "--porcelain"]);

    expect(result.ok).toBe(true);
    expect(content).toBe("base\n");
    expect(status.stdout.trim()).toBe("");
  });

  it("refuses rollback when new commits appeared after the session started", async () => {
    const repo = await createRepo();
    const session = await GitChangeSession.begin(repo);
    await writeFile(join(repo, "tracked.txt"), "outside commit\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "outside"]);

    const result = await session.rollback();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("HEAD changed");
  });
});
