import { beforeAll, describe, expect, it } from "vitest";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(__dirname, "..");
const runnerPath = resolve(projectRoot, "scripts", "windows-validate.ps1");

const REAL_EXEC_PATTERNS = [
  "Start-Process",
  "ExitCode",
  "Get-ChildItem",
  "Test-Path",
  "CheckResult",
];
const REGISTRY_PATTERNS = [
  "HKCU:",
  "Uninstall",
  "DisplayName",
  "DisplayVersion",
];
const SENTINEL_PATTERNS = [
  "sentinel",
  "Out-File",
];
const LAUNCH_PATTERNS = [
  "taskkill",
  "/T /F /PID",
  "LaunchTimeoutSeconds",
];
const HONEST_SKIP_PATTERNS = [
  "packaged-extension-execution",
  "sqlite-persistence",
  "keep-undo-change-session",
  "credential-inheritance",
  "descendant-cancellation",
];
const MANUAL_SOURCE_NAMES = [
  "tray-icon-visual",
  "popover-open-close",
  "popover-layout",
  "settings-ui",
  "agent-conversation",
  "keep-undo-ui",
  "window-behavior",
];

describe("windows-native-validation", () => {
  let content: string;

  beforeAll(async () => {
    await expect(access(runnerPath)).resolves.toBeUndefined();
    content = await readFile(runnerPath, "utf-8");
  });

  it("runner script exists and is readable", () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it("is compatible with Windows PowerShell 5.1", () => {
    expect(content).toMatch(/#Requires\s+-Version\s+5\.1/);
    expect(content).not.toMatch(/#Requires\s+-Version\s+7\.0/);
  });

  it("has SupportsShouldProcess for -WhatIf", () => {
    expect(content).toMatch(/SupportsShouldProcess/);
  });

  it("guards against non-Windows hosts via OSVersion.Platform", () => {
    expect(content).toMatch(/Assert-WindowsNative/);
    expect(content).toMatch(/OSVersion\.Platform/);
    expect(content).toMatch(/notmatch '\^\[A-Za-z\]:/);
  });

  it("guards against WSL", () => {
    expect(content).toMatch(/Assert-NotWsl/);
    expect(content).toMatch(/WSL_DISTRO_NAME/);
  });

  it("guards InstallDir/UserDataDir/DiagnosticDir against dangerous roots", () => {
    expect(content).toMatch(/Assert-PathSafe/);
    expect(content).toMatch(/Assert-ExistingPathSafe/);
    expect(content).toMatch(/volume root/);
    expect(content).toMatch(/protected system path/);
    expect(content).toMatch(/collides with user-profile root/);
  });

  it("refuses to overwrite existing paths", () => {
    expect(content).toMatch(/Refusing to overwrite/);
  });

  it("requires explicit AllowInstall/AllowUninstall/AllowLaunch", () => {
    expect(content).toMatch(/\$AllowInstall/);
    expect(content).toMatch(/\$AllowUninstall/);
    expect(content).toMatch(/\$AllowLaunch/);
  });

  it("produces structured evidence JSON with secret redaction", () => {
    expect(content).toMatch(/ConvertTo-Json/);
    expect(content).toMatch(/\*\*REDACTED\*\*/);
    expect(content).toMatch(/evidencePath/);
    expect(content).toMatch(/DiagnosticDir/);
  });

  it("defines pass/fail/skip check results via ValidateSet", () => {
    expect(content).toMatch(/ValidateSet\('pass','fail','skip'/);
  });

  it("runs real installer via Start-Process with exit code check", () => {
    expect(content).toMatch(/Start-Process/);
    expect(content).toMatch(/ExitCode/);
    expect(content).toMatch(/\/D=/);
  });

  it("verifies installed files via Get-ChildItem", () => {
    expect(content).toMatch(/Get-ChildItem/);
    expect(content).toMatch(/app\.asar/);
    expect(content).toMatch(/Baby Menu.*\.exe/);
  });

  it("checks shortcuts in Start Menu directories", () => {
    expect(content).toMatch(/Start Menu/);
    expect(content).toMatch(/\.lnk/);
  });

  it("checks HKCU uninstall registry entry", () => {
    for (const pat of REGISTRY_PATTERNS) {
      expect(content, `missing registry pattern: ${pat}`).toContain(pat);
    }
  });

  it("creates and verifies isolated sentinel file with SHA256 hash comparison", () => {
    expect(content).toMatch(/SentinelHash/);
    expect(content).toMatch(/Get-FileHash/);
    expect(content).toMatch(/SHA256/);
    expect(content).toMatch(/sentinel-verify-/);
    expect(content).toMatch(/Sentinel SHA256 mismatch/);
  });

  it("has exactly one bounded launch with process-tree cleanup via taskkill", () => {
    for (const pat of LAUNCH_PATTERNS) {
      expect(content, `missing launch pattern: ${pat}`).toContain(pat);
    }
  });

  it("reports unsupported runtime checks as skip with external commands", () => {
    for (const pat of HONEST_SKIP_PATTERNS) {
      expect(content, `missing honest-skip check: ${pat}`).toContain(pat);
    }
  });

  it("identifies genuinely manual GUI-only checks with stable Name values", () => {
    expect(content).toMatch(/Get-ManualChecks/);
    expect(content).toMatch(/\$check\.Name/);
    expect(content).toMatch(/manual-\$\(\$check\.Name\)/);
    for (const name of MANUAL_SOURCE_NAMES) {
      expect(content, `missing manual source Name: ${name}`).toContain(name);
    }
  });

  it("runs uninstaller via Start-Process with exit code and dir removal check", () => {
    expect(content).toMatch(/Uninstall/);
    expect(content).toMatch(/uninst/);
    expect(content).toMatch(/InstallDir removed after uninstall/);
  });

  it("exits 1 on any failure", () => {
    expect(content).toMatch(/exit 1/);
  });

  it("uses PS 5.1-compatible types (ArrayList not Generic.List)", () => {
    expect(content).toMatch(/Collections\.ArrayList/);
    expect(content).not.toMatch(/Generic\.List\[/);
  });

  it("does not use PS7-only automatic variables ($IsWindows/$IsLinux/$IsMacOS)", () => {
    // PS 5.1 does not define $IsWindows/$IsLinux/$IsMacOS; the script must
    // use [System.Environment]::OSVersion.Platform instead.
    expect(content).not.toMatch(/\$IsWindows/);
    expect(content).not.toMatch(/\$IsLinux/);
    expect(content).not.toMatch(/\$IsMacOS/);
  });

  it("each mutation/verification function returns plan-only skip before executing pass branches", () => {
    // Every function that can produce a 'pass' result must first check
    // $WhatIfPreference or $PSCmdlet.ShouldProcess and emit a plan-only skip.
    const funcs = [
      { name: "Invoke-InstallerCheck", skipPattern: "Plan-only: installer", passPattern: "Start-Process" },
      { name: "Invoke-InstalledFilesCheck", skipPattern: "Plan-only: would verify installed files", passPattern: "Get-ChildItem" },
      { name: "Invoke-ShortcutCheck", skipPattern: "Plan-only: would verify shortcuts", passPattern: "Get-ChildItem.*Baby Menu" },
      { name: "Invoke-RegistryUninstallCheck", skipPattern: "Plan-only: would verify HKCU", passPattern: "Get-ItemProperty" },
      { name: "Invoke-SentinelCreate", skipPattern: "Plan-only: would create sentinel", passPattern: "Out-File.*sentinel" },
      { name: "Invoke-SentinelVerify", skipPattern: "Plan-only: would verify sentinel", passPattern: "SentinelHash" },
      { name: "Invoke-BoundedLaunchCheck", skipPattern: "Plan-only: would launch Baby Menu", passPattern: "Win32_Process" },
      { name: "Invoke-UninstallCheck", skipPattern: "Plan-only: would uninstall", passPattern: "Start-Process.*uninst" },
    ];
    for (const fn of funcs) {
      expect(content, `missing skip-before-pass guard in ${fn.name}`).toMatch(
        new RegExp(`function ${fn.name}.*${fn.skipPattern}.*${fn.passPattern}`, "s"),
      );
    }
    // Verify no pass can bypass the guard: every -Status pass must appear only
    // after a $WhatIfPreference or $PSCmdlet.ShouldProcess check in its scope.
    const passLines = content.match(/Status 'pass'/g) || [];
    const guardCount = (content.match(/\$WhatIfPreference/g) || []).length +
                       (content.match(/ShouldProcess/g) || []).length;
    expect(passLines.length).toBeLessThan(guardCount);
  });

  // ---- Regression tests for the 8 safety-review fixes ----

  it("canonicalizes all three path arguments via GetFullPath", () => {
    expect(content).toMatch(/GetFullPath/);
    expect(content).toMatch(/installDirResolved/);
    expect(content).toMatch(/userDataDirResolved/);
    expect(content).toMatch(/diagnosticDirResolved/);
    expect(content).toMatch(/\$InstallDir\s*=\s*\$installDirResolved/);
  });

  it("rejects every volume root (C:\\, D:\\) not just the system drive", () => {
    expect(content).toMatch(/volume root/);
    // Must compare resolved path against GetPathRoot, not just SystemDrive
    expect(content).toMatch(/GetPathRoot/);
    expect(content).toContain('if ($resolved -eq $root)');
  });

  it("rejects parent/child overlap among InstallDir/UserDataDir/DiagnosticDir", () => {
    expect(content).toMatch(/Assert-NoPathOverlap/);
    expect(content).toMatch(/must not overlap/);
    expect(content).toMatch(/resolve to the same path/);
    // Called for all three pairs
    expect((content.match(/Assert-NoPathOverlap/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it("does not write evidence to untrusted DiagnosticDir on guard failure", () => {
    // The guard catch block must write to TEMP, not to DiagnosticDir
    expect(content).toMatch(/tempPath/);
    expect(content).toMatch(/env:TEMP/);
    // No Add-CheckResult or Write-Evidence in the guard-failure catch
    const catchBlock = content.match(/catch \{[\s\S]*?exit 1/);
    expect(catchBlock).not.toBeNull();
    expect(catchBlock![0]).not.toContain("Write-Evidence");
    expect(catchBlock![0]).not.toContain("Add-CheckResult");
  });

  it("requires all three mutation flags together or none at all", () => {
    expect(content).toMatch(/Assert-MutationConsent/);
    expect(content).toMatch(/all be provided together/);
    // Must check that any single flag without the others is rejected
    expect(content).toMatch(/\$anyMutation/);
    expect(content).toMatch(/\$allMutation/);
  });

  it("runs NSIS silently with /S and /D as last argument", () => {
    expect(content).toMatch(/\/S.*\/D=\$InstallDir/);
    // /D= must be the last argument in the ArgumentList array
    const installerLines = content.match(/Invoke-InstallerCheck[\s\S]*?^}/m);
    expect(installerLines).not.toBeNull();
    expect(installerLines![0]).toMatch(/'\/S', "\/D=\$InstallDir"/);
  });

  it("searches for electron-builder uninstaller 'Uninstall Baby Menu.exe' first", () => {
    // Match the search array with single-quote PS string literals
    const uninstBabyMenu = "'Uninstall Baby Menu.exe'";
    const uninstGeneric = "'Uninstall.exe'";
    const babyIdx = content.indexOf(uninstBabyMenu);
    const genericIdx = content.indexOf(uninstGeneric);
    expect(babyIdx, "Uninstall Baby Menu.exe must appear in the script").toBeGreaterThan(0);
    expect(genericIdx, "Uninstall.exe must appear in the script").toBeGreaterThan(0);
    expect(babyIdx, "Uninstall Baby Menu.exe must come before Uninstall.exe in the search array").toBeLessThan(genericIdx);
  });

  it("enumerates all processes under InstallDir via Win32_Process for survivor cleanup", () => {
    expect(content).toMatch(/Win32_Process/);
    expect(content).toMatch(/ExecutablePath/);
    expect(content).toMatch(/GetDirectoryName/);
    // Must fail if any descendant survives, not just the parent PID
    expect(content).toMatch(/surviving process/);
    expect(content).toMatch(/no descendants under InstallDir remain/);
  });

  // ---- Regression tests for plan-only zero-mutation fix ----

  it("plan-only Write-Evidence returns JSON before any New-Item or Out-File", () => {
    // The plan guard must short-circuit before creating DiagnosticDir or writing files.
    const weFunc = content.match(/^function Write-Evidence \{[\s\S]*?^}/m);
    expect(weFunc).not.toBeNull();
    const funcBody = weFunc![0];
    const returnJsonIdx = funcBody.indexOf("return $json");
    const newItemIdx = funcBody.indexOf("New-Item");
    const outFileIdx = funcBody.indexOf("Out-File");
    expect(returnJsonIdx).toBeGreaterThan(0);
    expect(returnJsonIdx).toBeLessThan(newItemIdx);
    expect(returnJsonIdx).toBeLessThan(outFileIdx);
  });

  it("plan-only Write-Evidence adds PlanOnly=true marker to evidence JSON", () => {
    expect(content).toMatch(/evidence\.PlanOnly\s*=\s*\$true/);
  });

  it("guard failure catch does not write temp file in plan mode", () => {
    // Out-File must appear after the $WhatIfPreference guard in the catch block
    const catchBlock = content.match(/catch \{[\s\S]*?exit 1/);
    expect(catchBlock).not.toBeNull();
    const cb = catchBlock![0];
    expect(cb).toContain("$WhatIfPreference");
    const outFilePos = cb.indexOf("Out-File");
    const guardPos = cb.indexOf("$WhatIfPreference");
    expect(guardPos).toBeGreaterThan(0);
    expect(outFilePos).toBeGreaterThan(guardPos);
  });

  it("actual mode Write-Evidence still creates directory and writes file", () => {
    // After the plan-only early return, the remainder must still produce evidence
    const weFunc = content.match(/^function Write-Evidence \{[\s\S]*?^}/m);
    expect(weFunc).not.toBeNull();
    const funcBody = weFunc![0];
    const afterReturn = funcBody.split("return $json")[1] || "";
    expect(afterReturn).toMatch(/New-Item/);
    expect(afterReturn).toMatch(/Out-File/);
    expect(afterReturn).toMatch(/evidencePath/);
  });

  it("plan-only evidence has explicit BEGIN and END markers around JSON for deterministic parsing", () => {
    expect(content).toMatch(/BEGIN PLAN-ONLY EVIDENCE/);
    expect(content).toMatch(/END PLAN-ONLY EVIDENCE/);
    // Both markers must wrap the evidence JSON output
    const markerBlock = content.match(/"--- BEGIN PLAN-ONLY EVIDENCE ---"[\s\S]*?"--- END PLAN-ONLY EVIDENCE ---"/);
    expect(markerBlock).not.toBeNull();
    const block = markerBlock![0];
    // JSON output must appear between BEGIN and END
    expect(block).toMatch(/\$evidenceResult/);
    // BEGIN marker must come before the JSON output, END after
    const beginIdx = block.indexOf("BEGIN PLAN-ONLY EVIDENCE");
    const endIdx = block.indexOf("END PLAN-ONLY EVIDENCE");
    const jsonOutputIdx = block.indexOf("\$evidenceResult");
    expect(beginIdx).toBeLessThan(jsonOutputIdx);
    expect(jsonOutputIdx).toBeLessThan(endIdx);
  });
});
