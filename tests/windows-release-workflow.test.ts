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

  it("scopes build job to contents:read only (no id-token:write)", () => {
    const buildJob = workflow.split(/\n(?=\s+sign:)/)[0];
    expect(buildJob).toContain("contents: read");
    expect(buildJob).not.toContain("id-token: write");
    expect(buildJob).not.toContain("environment:");
  });

  it("scopes sign job to contents:read and id-token:write within windows-release environment", () => {
    const signJob = workflow.match(/  sign:[\s\S]*?(?=\n  publish:)/);
    expect(signJob).toBeTruthy();
    const body = signJob![0];
    expect(body).toContain("contents: read");
    expect(body).toContain("id-token: write");
    expect(body).toContain("environment: windows-release");
    expect(body).not.toContain("contents: write");
  });

  it("scopes publish job to contents:write only", () => {
    expect(workflow).toContain("    permissions:");
    expect(workflow).toContain("      contents: write");
    expect(workflow.match(/contents:\s+write/g)?.length).toBe(1);
  });

  it("has build -> sign -> publish dependency chain", () => {
    expect(workflow).toContain("needs: build");
    expect(workflow).toContain("needs: sign");
    // The two job-level if: gates (sign and publish both gated on tag).
    // Step-level guard in build also uses this check, so use a job-level pattern.
    const jobLevelGates = workflow.match(/^ {4}if: startsWith\(github\.ref, 'refs\/tags\/'\)/gm);
    expect(jobLevelGates?.length).toBe(2);
  });

  it("runs on windows-latest with pinned major action versions", () => {
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("pnpm/action-setup@v6");
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("actions/download-artifact@v4");
  });

  it("guards against partial Trusted Signing config in early notification step", () => {
    expect(workflow).toContain("Guard early notification for unsigned tag build");
    const snippet = workflow.match(/Guard early notification[\s\S]*?Build NSIS installer/);
    expect(snippet).toBeTruthy();
    const body = snippet![0];
    expect(body).toContain("AZURE_CLIENT_ID");
    expect(body).toContain("AZURE_TENANT_ID");
    expect(body).toContain("AZURE_SUBSCRIPTION_ID");
    expect(body).toContain("AZURE_TRUSTED_SIGNING_ENDPOINT");
    expect(body).toContain("AZURE_TRUSTED_SIGNING_ACCOUNT");
    expect(body).toContain("AZURE_TRUSTED_SIGNING_CERT_PROFILE");
    expect(body).toContain("WIN_CSC_LINK");
    expect(body).toContain("WIN_CSC_KEY_PASSWORD");
    expect(body).toContain("Partial Trusted Signing configuration");
    expect(body).toContain("Set all 6 TS variables");
  });

  it("builds NSIS installer with conditional CSC_LINK/CSC_KEY_PASSWORD", () => {
    const buildStep = workflow.match(/Build NSIS installer[\s\S]*?npx electron-builder --win --x64/);
    expect(buildStep).toBeTruthy();
    const block = workflow.match(/Build NSIS installer[\s\S]*?(?=^\s+- name:)/m);
    expect(block).toBeTruthy();
    const body = block![0];
    expect(body).toContain("CSC_LINK: ${{ (startsWith(github.ref, 'refs/tags/') && vars.AZURE_TRUSTED_SIGNING_ENDPOINT == '' && secrets.WIN_CSC_LINK) || '' }}");
    expect(body).toContain("CSC_KEY_PASSWORD: ${{ (startsWith(github.ref, 'refs/tags/') && vars.AZURE_TRUSTED_SIGNING_ENDPOINT == '' && secrets.WIN_CSC_KEY_PASSWORD) || '' }}");
  });

  it("resolves installer deterministically in build job", () => {
    const buildJob = workflow.split(/\n(?=\s+sign:)/)[0];
    expect(buildJob).toContain("Resolve installer deterministically");
    expect(buildJob).toContain('Filter "Baby-Menu-*.exe"');
    expect(buildJob).toContain(".Count -eq 0");
    expect(buildJob).toContain(".Count -gt 1");
  });

  it("computes SHA-256 checksum on manual dry-run only", () => {
    expect(workflow).toContain("Compute SHA-256 checksum (manual dry-run)");
    expect(workflow).toContain("!startsWith(github.ref, 'refs/tags/')");
    expect(workflow).toContain("Get-FileHash");
    expect(workflow).toContain("Algorithm SHA256");
  });

  it("uploads candidate (exe only, 1-day) on tag path, unsigned installer+sha256 (7-day) on manual path", () => {
    expect(workflow).toContain("Upload build candidate (tag path, sign job handoff)");
    const tagUpload = workflow.match(/Upload build candidate \(tag path[\s\S]*?if-no-files-found: error/);
    expect(tagUpload).toBeTruthy();
    expect(tagUpload![0]).toContain("baby-menu-win-x64-candidate");
    expect(tagUpload![0]).toContain("release/*.exe");
    expect(tagUpload![0]).toContain("retention-days: 1");
    expect(tagUpload![0]).not.toContain(".sha256");

    expect(workflow).toContain("Upload unsigned manual artifact (dry-run, no signing)");
    const manualUpload = workflow.match(/Upload unsigned manual artifact \(dry-run, no signing\)[\s\S]*?if-no-files-found: error/);
    expect(manualUpload).toBeTruthy();
    expect(manualUpload![0]).toContain("baby-menu-win-x64-installer");
    expect(manualUpload![0]).toContain("retention-days: 7");
    expect(manualUpload![0]).toContain(".sha256");
  });

  it("manual upload is gated on non-tag (workflow_dispatch only)", () => {
    const manualStep = workflow.match(/Upload unsigned manual artifact \(dry-run, no signing\)[\s\S]*?if-no-files-found: error/);
    expect(manualStep).toBeTruthy();
    expect(manualStep![0]).toContain("!startsWith(github.ref, 'refs/tags/')");
  });

  it("manual runs never receive signing credentials", () => {
    const buildEnv = workflow.match(/Build NSIS installer[\s\S]*?(?=^\s+- name: Resolve)/m);
    expect(buildEnv).toBeTruthy();
    const envBlock = buildEnv![0];
    // The CSC_LINK expression gates on startsWith(github.ref, 'refs/tags/') &&
    // vars.AZURE_TRUSTED_SIGNING_ENDPOINT == '' so manual runs always produce
    // empty string regardless of secret presence.
    expect(envBlock).toContain("startsWith(github.ref, 'refs/tags/')");
    expect(envBlock).toContain("vars.AZURE_TRUSTED_SIGNING_ENDPOINT == ''");
    // Build step comment confirms manual produces unsigned
    expect(envBlock).toContain("manual path: CSC_LINK unset");
  });

  it("sign job downloads candidate, resolves exact installer path", () => {
    const signJob = workflow.match(/  sign:[\s\S]*?(?=\n  publish:)/);
    expect(signJob).toBeTruthy();
    const body = signJob![0];
    expect(body).toContain("actions/download-artifact@v4");
    expect(body).toContain("baby-menu-win-x64-candidate");
    expect(body).toContain("Resolve installer deterministically");
    expect(body).toContain('Filter "Baby-Menu-*.exe"');
    expect(body).toContain(".Count -eq 0");
    expect(body).toContain(".Count -gt 1");
  });

  it("sign job determines provider with comprehensive TS guard", () => {
    const signJob = workflow.match(/  sign:[\s\S]*?(?=\n  publish:)/);
    expect(signJob).toBeTruthy();
    const body = signJob![0];
    expect(body).toContain("Determine provider and guard fully");
    expect(body).toContain("tsAllSet");
    expect(body).toContain("tsAnySet");
    expect(body).toContain("provider=trusted-signing");
    expect(body).toContain("provider=pfx");
    expect(body).toContain("Partial Trusted Signing configuration");
    expect(body).toContain("Set all 6 TS variables");
  });

  it("sign job gates Azure login on TS provider output", () => {
    const signJob = workflow.match(/  sign:[\s\S]*?(?=\n  publish:)/);
    expect(signJob).toBeTruthy();
    const body = signJob![0];
    expect(body).toContain("steps.provider.outputs.provider == 'trusted-signing'");
    expect(body).toContain("client-id: ${{ vars.AZURE_CLIENT_ID }}");
    expect(body).toContain("tenant-id: ${{ vars.AZURE_TENANT_ID }}");
    expect(body).toContain("subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}");
  });

  it("pins Azure actions to peeled commit SHAs with version comment", () => {
    expect(workflow).toContain("azure/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43 # v3.0.0 (peeled commit)");
    expect(workflow).toContain("azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82 # v2.0.0 (peeled commit)");
  });

  it("uses trusted-signing-account-name input and signs exact file path", () => {
    const signStep = workflow.match(/name: Sign with Trusted Signing[\s\S]*?(?=^\s+- name:)/m);
    expect(signStep).toBeTruthy();
    const body = signStep![0];
    expect(body).toContain("trusted-signing-account-name: ${{ vars.AZURE_TRUSTED_SIGNING_ACCOUNT }}");
    expect(body).toContain("files: ${{ steps.installer.outputs.path }}");
    expect(body).not.toContain("files-folder:");
    expect(body).not.toMatch(/^\s+signing-account-name:/m);
    expect(body).toContain("file-digest: SHA256");
    expect(body).toContain("timestamp-rfc3161: http://timestamp.acs.microsoft.com");
    expect(body).toContain("timestamp-digest: SHA256");
  });

  it("verifies Authenticode signature and timestamp in sign job", () => {
    expect(workflow).toContain("Verify Authenticode signature and timestamp");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain('$sig.Status -ne "Valid"');
    expect(workflow).toContain("$null -eq $sig.TimeStamperCertificate");
    expect(workflow).toContain("Authenticode signature is missing RFC3161 timestamp");
  });

  it("renames signed installer to remove -unsigned suffix after signature verification", () => {
    expect(workflow).toContain("Rename signed installer (remove -unsigned suffix)");
    expect(workflow).toContain("-replace '-unsigned', ''");
    expect(workflow).toContain("Rename-Item");
  });

  it("computes SHA-256 checksum after rename", () => {
    expect(workflow).toContain("Compute SHA-256 checksum");
    expect(workflow).toContain("Get-FileHash");
    expect(workflow).toContain("Algorithm SHA256");
    expect(workflow).toContain(".sha256");
  });

  it("uploads release artifact as baby-menu-win-x64-release with 1-day retention", () => {
    const uploadStep = workflow.match(/name: Upload release artifact[\s\S]*?if-no-files-found: error/);
    expect(uploadStep).toBeTruthy();
    const body = uploadStep![0];
    expect(body).toContain("baby-menu-win-x64-release");
    expect(body).toContain("retention-days: 1");
    expect(body).toContain(".sha256");
  });

  it("publish job downloads from sign job's release artifact", () => {
    const publishJob = workflow.split(/\n(?=  publish:)/)[1] || workflow;
    expect(publishJob).toContain("actions/download-artifact@v4");
    expect(publishJob).toContain("baby-menu-win-x64-release");
    expect(publishJob).toContain("gh release upload");
    expect(publishJob).toContain("--clobber");
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
    const elseBranch = body.match(/}\s*else\s*\{([^}]+)}/);
    expect(elseBranch).toBeTruthy();
    expect(elseBranch![1]).not.toContain("--draft");
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

  it("builds the NSIS installer via electron-builder directly", () => {
    expect(workflow).toContain("npx electron-builder --win --x64");
    expect(workflow).not.toContain("package:win");
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

  it("uses repository variables (not secrets) for Azure identifiers and TS config", () => {
    expect(workflow).toContain("${{ vars.AZURE_CLIENT_ID }}");
    expect(workflow).toContain("${{ vars.AZURE_TENANT_ID }}");
    expect(workflow).toContain("${{ vars.AZURE_SUBSCRIPTION_ID }}");
    expect(workflow).toContain("${{ vars.AZURE_TRUSTED_SIGNING_ENDPOINT }}");
    expect(workflow).toContain("${{ vars.AZURE_TRUSTED_SIGNING_ACCOUNT }}");
    expect(workflow).toContain("${{ vars.AZURE_TRUSTED_SIGNING_CERT_PROFILE }}");
  });

  it("ensures sign job operations execute in correct order: resolve -> guard -> login -> sign -> verify -> rename -> checksum -> upload", () => {
    const signJob = workflow.match(/  sign:[\s\S]*?(?=\n  publish:)/);
    expect(signJob).toBeTruthy();
    const body = signJob![0];
    const resolvePos = body.indexOf("Resolve installer deterministically");
    const guardPos = body.indexOf("Determine provider and guard");
    const loginPos = body.indexOf("Azure login (Trusted Signing)");
    const signPos = body.indexOf("Sign with Trusted Signing");
    const verifyPos = body.indexOf("Verify Authenticode signature and timestamp");
    const renamePos = body.indexOf("Rename signed installer");
    const checksumPos = body.indexOf("Compute SHA-256 checksum");
    const uploadPos = body.indexOf("Upload release artifact");
    expect(resolvePos).toBeGreaterThan(-1);
    expect(guardPos).toBeGreaterThan(resolvePos);
    expect(loginPos).toBeGreaterThan(guardPos);
    expect(signPos).toBeGreaterThan(loginPos);
    expect(verifyPos).toBeGreaterThan(signPos);
    expect(renamePos).toBeGreaterThan(verifyPos);
    expect(checksumPos).toBeGreaterThan(renamePos);
    expect(uploadPos).toBeGreaterThan(checksumPos);
  });
});
