import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const workflowPath = resolve(import.meta.dirname, "../.github/workflows/release-windows.yml");

describe("Windows installer preview workflow", () => {
  let workflow: string;

  beforeAll(async () => {
    workflow = await readFile(workflowPath, "utf8");
  });

  it("exists as a dedicated workflow file", async () => {
    const stats = await stat(workflowPath);
    expect(stats.isFile()).toBe(true);
  });

  it("is workflow_dispatch-only", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).not.toMatch(/^\s+tags:/m);
    expect(workflow).not.toContain("refs/tags/");
  });

  it("uses read-only repository permissions", () => {
    expect(workflow).toMatch(/^permissions:\s*\{\s*}/m);
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).not.toContain("environment:");
  });

  it("runs a single unsigned preview job on windows-latest", () => {
    expect(workflow).toContain("build-unsigned-preview:");
    expect(workflow.match(/^  [a-z][a-z0-9-]+:$/gm)).toHaveLength(1);
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("timeout-minutes: 30");
  });

  it("installs, validates, builds, and packages with pinned major actions", () => {
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("pnpm/action-setup@v6");
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("pnpm typecheck");
    expect(workflow).toContain("pnpm test");
    expect(workflow).toContain("pnpm build");
    expect(workflow).toContain("npx electron-builder --win --x64");
  });

  it("disables signing identity discovery and accepts only unsigned installers", () => {
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(workflow).toContain('Filter "Baby-Menu-*-x64-unsigned.exe"');
    expect(workflow).toContain(".Count -eq 0");
    expect(workflow).toContain(".Count -gt 1");
    expect(workflow).not.toMatch(/CSC_LINK|CSC_KEY_PASSWORD|AZURE_|SignPath/i);
  });

  it("computes a SHA-256 checksum for the resolved installer", () => {
    expect(workflow).toContain("Get-FileHash");
    expect(workflow).toContain("Algorithm SHA256");
    expect(workflow).toContain("$installerPath.sha256");
    expect(workflow).toContain("checksum_path=");
  });

  it("uploads an explicitly internal unsigned preview with bounded retention", () => {
    expect(workflow).toContain("Upload unsigned internal preview");
    expect(workflow).toContain("baby-menu-win-x64-unsigned-internal-preview");
    expect(workflow).toContain("retention-days: 7");
    expect(workflow).toContain("if-no-files-found: error");
  });

  it("contains no signing, deployment, or release-publication path", () => {
    expect(workflow).not.toMatch(/azure\/|artifact-signing|authenticode|trusted.signing|pfx/i);
    expect(workflow).not.toMatch(/\bgh release\b|create.*release|publish/i);
    expect(workflow).not.toContain("actions/download-artifact");
    expect(workflow).not.toMatch(/^  (sign|publish):/m);
  });

  it("uses concurrency control for the selected ref", () => {
    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("group: windows-installer-preview-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
  });
});
