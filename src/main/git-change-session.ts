import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitActionResult, GitSessionSnapshot } from "../shared/contracts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await git(cwd, args);
  return stdout.trim();
}

async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  return (await gitText(cwd, ["status", "--porcelain"])) === "";
}

export class GitChangeSession {
  readonly rootDir: string;
  readonly head: string | null;
  readonly startedClean: boolean;

  private completed = false;

  private constructor(rootDir: string, head: string | null, startedClean: boolean) {
    this.rootDir = rootDir;
    this.head = head;
    this.startedClean = startedClean;
  }

  get canSave(): boolean {
    return this.startedClean && !this.completed;
  }

  get canRollback(): boolean {
    return this.startedClean && !this.completed;
  }

  static async begin(rootDir: string): Promise<GitChangeSession> {
    const startedClean = await isWorkingTreeClean(rootDir);
    const head = startedClean ? await gitText(rootDir, ["rev-parse", "HEAD"]) : null;
    return new GitChangeSession(rootDir, head, startedClean);
  }

  snapshot(message?: string): GitSessionSnapshot {
    return {
      startedClean: this.startedClean,
      canSave: this.canSave,
      canRollback: this.canRollback,
      head: this.head,
      message,
    };
  }

  async save(message = "Save baby-menu agent changes"): Promise<GitActionResult> {
    const safety = await this.ensureSafeToApply("save");
    if (!safety.ok) return safety;

    if (await isWorkingTreeClean(this.rootDir)) {
      return { ok: false, reason: "No changes to save" };
    }

    await git(this.rootDir, ["add", "--all"]);
    await git(this.rootDir, ["commit", "-m", message]);
    this.completed = true;
    const commit = await gitText(this.rootDir, ["rev-parse", "HEAD"]);
    return { ok: true, commit };
  }

  async rollback(): Promise<GitActionResult> {
    const safety = await this.ensureSafeToApply("rollback");
    if (!safety.ok) return safety;

    await git(this.rootDir, ["reset", "--hard", this.head ?? "HEAD"]);
    await git(this.rootDir, ["clean", "-fd"]);
    this.completed = true;
    return { ok: true };
  }

  private async ensureSafeToApply(action: "save" | "rollback"): Promise<GitActionResult> {
    if (!this.startedClean || this.head === null) {
      return {
        ok: false,
        reason: `Cannot ${action}: session did not start from a clean working tree`,
      };
    }
    if (this.completed) {
      return { ok: false, reason: `Cannot ${action}: session is already completed` };
    }

    const currentHead = await gitText(this.rootDir, ["rev-parse", "HEAD"]);
    if (currentHead !== this.head) {
      return {
        ok: false,
        reason: `Cannot ${action}: HEAD changed since the session started`,
      };
    }

    return { ok: true };
  }
}
