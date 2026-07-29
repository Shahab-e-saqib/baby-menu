import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const workflowPath = resolve(import.meta.dirname, "../.github/workflows/release-windows.yml");

describe("Windows release workflow", () => {
  let workflow: string;

  beforeAll(async () => {
    workflow = await readFile(workflowPath, "utf8");
  });

  it("exists as a dedicated workflow file", async () => {
    const stats = await stat(workflowPath);
    expect(stats.isFile()).toBe(true);
  });

  it("triggers on version tags and workflow_dispatch (no inputs)", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("tags:");
    expect(workflow).toContain("- 'v*'");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("dry-run:");
    expect(workflow).not.toContain("type: boolean");
  });

  it("defaults to empty permissions at the workflow level so each job scopes its own", () => {
    const topPermissions = /^permissions:\s*\{\s*}/m;
    expect(workflow).toMatch(topPermissions);
  });

  it("scopes build job to contents:read and publish job to contents:write only", () => {
    // Build job: read-only (contents:read). Extract its permission block and
    // confirm it does not contain contents:write.
    const buildJobs = workflow.split(/\n(?=  publish:)/);
    const buildJob = buildJobs[0];
    expect(buildJob).toContain("contents: read");
    expect(buildJob).not.toContain("contents: write");

    // Publish job: contents:write
    expect(workflow).toContain("  publish:");
    expect(workflow).toContain("    permissions:");
    expect(workflow).toContain("      contents: write");
    // Confirm the write permission appears only once (only in publish job)
    expect(workflow.match(/contents:\s+write/g)?.length).toBe(1);
  });

  it("runs on windows-latest with pinned major action versions", () => {
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("pnpm/action-setup@v6");
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("actions/download-artifact@v4");
  });

  it("guards against unsigned public releases and verifies the signature", () => {
    expect(workflow).toContain("Guard against unsigned public GitHub Release");
    expect(workflow).toContain("WIN_CSC_LINK");
    expect(workflow).toContain("WIN_CSC_KEY_PASSWORD");
    expect(workflow).toContain("startsWith(github.ref, 'refs/tags/')");
    expect(workflow).toContain("Verify Authenticode signature (release build)");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain('$sig.Status -ne "Valid"');
    expect(workflow).toContain("CSC_LINK: ${{ secrets.WIN_CSC_LINK }}");
    expect(workflow).toContain("CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}");
    expect(workflow).not.toContain("Write-Host.*$cscLink");
    expect(workflow).not.toContain("Write-Host.*$cscPwd");
    // Only one signing-related step (no separate Detect step)
    const guardStep = workflow.match(/name: Guard against unsigned public GitHub Release[\s\S]*?Verify Authenticode signature/m);
    expect(guardStep).toBeTruthy();
  });

  it("renames signed installer to remove -unsigned suffix after signature verification", () => {
    expect(workflow).toContain("Rename signed installer (remove -unsigned suffix)");
    expect(workflow).toContain("-replace '-unsigned', ''");
    expect(workflow).toContain("Rename-Item");
    expect(workflow).toContain("steps.rename.outputs.name || steps.installer.outputs.name");
    expect(workflow).toContain("startsWith(github.ref, 'refs/tags/')");
  });

  it("computes SHA-256 checksum and creates a checksum file", () => {
    expect(workflow).toContain("Compute SHA-256 checksum");
    expect(workflow).toContain("Get-FileHash");
    expect(workflow).toContain("Algorithm SHA256");
    expect(workflow).toContain(".sha256");
  });

  it("does deterministic artifact matching that rejects stale or multiple installers", () => {
    expect(workflow).toContain("Resolve installer for deterministic artifact matching");
    expect(workflow).toContain('Filter "Baby-Menu-*.exe"');
    expect(workflow).toContain(".Count -eq 0");
    expect(workflow).toContain(".Count -gt 1");
  });

  it("uploads build artifacts with bounded retention for manual builds and short retention for tag handoff", () => {
    const uploadStep = workflow.match(/name: Upload installer as build artifact[\s\S]*?if-no-files-found: error/);
    expect(uploadStep).toBeTruthy();
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("baby-menu-win-x64-installer");
    expect(workflow).toContain("retention-days:");
    expect(workflow).toContain("if-no-files-found: error");
  });

  it("uses a separate publish job that depends on build and has contents:write", () => {
    expect(workflow).toContain("publish:");
    expect(workflow).toContain("needs: build");
    expect(workflow).toContain("if: startsWith(github.ref, 'refs/tags/')");
    expect(workflow).toContain("actions/download-artifact@v4");
    expect(workflow).toContain("baby-menu-win-x64-installer");
    expect(workflow).toContain("gh release upload");
    expect(workflow).toContain("--clobber");
  });

  it("detects missing release via gh exit status without PowerShell native-command ambiguity", () => {
    const step = workflow.match(/name: Create or verify GitHub Release exists[\s\S]*?(?=^\s+- name:)/m);
    expect(step).toBeTruthy();
    const body = step![0];
    expect(body).toContain("gh release view");
    expect(body).toContain("$LASTEXITCODE -ne 0");
    expect(body).not.toContain("2>`$null");
    expect(body).not.toContain(">null");
    expect(body).toContain("$ErrorActionPreference = 'Continue'");
  });

  it("creates a draft release when missing and sets created_as_draft output", () => {
    const step = workflow.match(/name: Create or verify GitHub Release exists[\s\S]*?(?=^\s+- name:)/m);
    expect(step).toBeTruthy();
    const body = step![0];
    expect(body).toContain("gh release create");
    expect(body).toContain("--draft");
    expect(body).toContain("created_as_draft=true");
    expect(body).toContain("created_as_draft=false");
  });

  it("leaves existing releases untouched (no draft toggle for pre-existing releases)", () => {
    const step = workflow.match(/name: Create or verify GitHub Release exists[\s\S]*?(?=^\s+- name:)/m);
    expect(step).toBeTruthy();
    const body = step![0];
    expect(body).toContain("created_as_draft=false");
    // The else (existing-release) branch must not contain --draft.
    // Extract from '} else {' to the closing '}' of the else block.
    const elseBranch = body.match(/}\s*else\s*\{([^}]+)}/);
    expect(elseBranch).toBeTruthy();
    expect(elseBranch![1]).not.toContain("--draft");
    // The variable name created_as_draft contains the substring "draft" —
    // that's fine. Only the --draft CLI flag would toggle an existing release.
    expect(elseBranch![1]).toContain("Release $tag already exists");
    expect(elseBranch![1]).toContain("created_as_draft=false");
  });

  it("uploads assets between draft creation and publishing", () => {
    const publishJob = workflow.split(/\n(?=  publish:)/)[1] || workflow;
    const uploadPos = publishJob.indexOf("Upload assets to GitHub Release");
    const publishPos = publishJob.indexOf("Publish draft release");
    const createPos = publishJob.indexOf("Create or verify GitHub Release exists");
    expect(createPos).toBeGreaterThan(-1);
    expect(uploadPos).toBeGreaterThan(createPos);
    expect(publishPos).toBeGreaterThan(uploadPos);
  });

  it("publishes draft only when created_as_draft is true", () => {
    expect(workflow).toContain("Publish draft release");
    expect(workflow).toContain("steps.release.outputs.created_as_draft == 'true'");
    expect(workflow).toContain("gh release edit");
    expect(workflow).toContain("--draft=false");
  });

  it("does not include Chocolatey or Winget publishing", () => {
    expect(workflow).not.toMatch(/chocolatey/i);
    expect(workflow).not.toMatch(/winget/i);
    expect(workflow).not.toMatch(/choco/i);
  });

  it("builds the NSIS installer via electron-builder directly, not through the dev-mode package:win script", () => {
    expect(workflow).toContain("npx electron-builder --win --x64");
    expect(workflow).not.toContain("package:win");
    expect(workflow).not.toContain("electron-builder.dev.yml");
    expect(workflow).not.toContain("rmSync");
  });

  it("uses concurrency control to cancel in-progress runs on the same ref", () => {
    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("group: release-windows-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
  });

  it("uses ${{ github.token }} for GitHub API calls, never a custom secret token", () => {
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
  });
});
