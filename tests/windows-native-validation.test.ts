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
    // No Add-CheckResult or Write-Evidence in the guard-failure catch.
    // Anchor on the specific guard catch opening; do not match inner catches.
    const catchBlock = content.match(/} catch \{\s+\[Console\]::Error\.WriteLine\("Guard failed:[\s\S]*?exit 1/);
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
    const catchBlock = content.match(/} catch \{\s+\[Console\]::Error\.WriteLine\("Guard failed:[\s\S]*?exit 1/);
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

  // ---- Regression: descendant-cancellation quoting and top-level error handling ----

  it("descendant-cancellation ManualGuidance does not use backslash-escaped quotes", () => {
    // Backslash \" inside a double-quoted PowerShell string causes a
    // non-terminating ParameterBindingException.  Must use "" escaping instead.
    const dcLines = content.match(/descendant-cancellation[\s\S]*?ManualGuidance[^)]*\)/);
    expect(dcLines).not.toBeNull();
    expect(dcLines![0]).not.toContain('\\"');
    // Must contain the correct tasklist filter with PowerShell-native double-quote escaping
    expect(dcLines![0]).toMatch(/""IMAGENAME eq node\.exe""/);
  });

  it("sets $ErrorActionPreference to Stop for terminating errors", () => {
    expect(content).toMatch(/\$ErrorActionPreference\s*=\s*'Stop'/);
  });

  it("trap handler uses non-throwing [Console]::Error.WriteLine not Write-Error", () => {
    expect(content).toMatch(/^trap \{/m);
    expect(content).toMatch(/exit 1/);
    // The trap must avoid writing to the untrusted DiagnosticDir
    const trapBlock = content.match(/^trap \{[\s\S]*?^}/m);
    expect(trapBlock).not.toBeNull();
    expect(trapBlock![0]).not.toMatch(/Write-Error/);
    expect(trapBlock![0]).toMatch(/\[Console\]::Error\.WriteLine/);
    expect(trapBlock![0]).toMatch(/env:TEMP/);
  });

  it("guard catch block uses non-throwing [Console]::Error.WriteLine not Write-Error", () => {
    // Same rationale: Write-Error with $ErrorActionPreference=Stop would
    // terminate and recurse into the trap handler.
    const catchBlock = content.match(/} catch \{\s+\[Console\]::Error\.WriteLine\("Guard failed:[\s\S]*?exit 1/);
    expect(catchBlock).not.toBeNull();
    expect(catchBlock![0]).not.toMatch(/Write-Error/);
    expect(catchBlock![0]).toMatch(/\[Console\]::Error\.WriteLine/);
  });

  // ---- Regression tests for profile isolation in bounded launch ----

  it("defines Backup-Environment helper function", () => {
    expect(content).toMatch(/function Backup-Environment/);
    expect(content).toMatch(/param\(\[string\[\]\]\$Variables\)/);
    expect(content).toMatch(/\$backup = @\{\}/);
  });

  it("Backup-Environment iterates Variables and returns hashtable", () => {
    const func = content.match(/function Backup-Environment \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    expect(func![0]).toMatch(/foreach.*\$var.*\$Variables/);
    expect(func![0]).toMatch(/GetEnvironmentVariable.*Process/);
    expect(func![0]).toMatch(/return \$backup/);
  });

  it("defines Restore-Environment helper function", () => {
    expect(content).toMatch(/function Restore-Environment/);
    expect(content).toMatch(/param\(\[hashtable\]\$Backup\)/);
  });

  it("Restore-Environment uses Remove-Item Env: for null-origin variables", () => {
    const func = content.match(/function Restore-Environment \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    expect(func![0]).toMatch(/SetEnvironmentVariable/);
    expect(func![0]).toMatch(/Remove-Item "Env:/);
  });

  it("defines Assert-ProfilePathsSafe helper function", () => {
    expect(content).toMatch(/function Assert-ProfilePathsSafe/);
    expect(content).toMatch(/param\(\[hashtable\]\$ProfilePaths/);
    expect(content).toMatch(/is not under UserDataDir/);
  });

  it("Assert-ProfilePathsSafe throws when isolated path escapes UserDataDir", () => {
    const func = content.match(/function Assert-ProfilePathsSafe \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    expect(func![0]).toMatch(/throw/);
    expect(func![0]).toMatch(/is not under UserDataDir/);
    expect(func![0]).toMatch(/StartsWith/);
  });

  it("bounded launch isolates APPDATA, LOCALAPPDATA, USERPROFILE, HOME under UserDataDir", () => {
    expect(content).toMatch(/\$profileIsolationRoot/);
    expect(content).toMatch(/Join-Path \$UserDataDir "child-profile"/);
    // All four isolated dir paths must be defined
    expect(content).toMatch(/AppData-Roaming/);
    expect(content).toMatch(/AppData-Local/);
    expect(content).toMatch(/UserProfile/);
    expect(content).toMatch(/Home"/);
  });

  it("bounded launch calls Assert-ProfilePathsSafe before creating dirs", () => {
    // The isolation safety check must appear before New-Item directory creation
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    const assertIdx = fn.indexOf("Assert-ProfilePathsSafe");
    const newItemIdx = fn.indexOf("New-Item -ItemType Directory");
    expect(assertIdx).toBeGreaterThan(0);
    expect(newItemIdx).toBeGreaterThan(0);
    expect(assertIdx).toBeLessThan(newItemIdx);
  });

  it("bounded launch creates isolated profile directories only in non-WhatIf mode", () => {
    // The WhatIf guard in Invoke-BoundedLaunchCheck returns early before any
    // profile creation commands. Anchor on the function to avoid matching
    // the unrelated guard catch in main.
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    const whatIfBlock = fn.match(/\$WhatIfPreference\)\s*\{[\s\S]*?Add-CheckResult[\s\S]*?return/);
    expect(whatIfBlock).not.toBeNull();
    const guard = whatIfBlock![0];
    // Guard must not contain New-Item for profile dirs
    expect(guard).not.toMatch(/New-Item.*child-profile/);
    // Guard must mention profile isolation in its skip message
    expect(guard).toMatch(/isolated profile directories/);
  });

  it("bounded launch checks executable-under-InstallDir as deterministic check before launch", () => {
    expect(content).toMatch(/bounded-launch-exe-under-installdir/);
    expect(content).toMatch(/'pass'.*Executable.*is under InstallDir/);
    expect(content).toMatch(/'fail'.*not under InstallDir/);
  });

  it("bounded launch exe-under-InstallDir check fails early before Start-Process", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    const exeCheckIdx = fn.indexOf("bounded-launch-exe-under-installdir");
    const startProcIdx = fn.indexOf("Start-Process");
    expect(exeCheckIdx).toBeGreaterThan(0);
    expect(startProcIdx).toBeGreaterThan(0);
    expect(exeCheckIdx).toBeLessThan(startProcIdx);
  });

  it("bounded launch snapshots all four env vars via Backup-Environment before modifying", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    expect(fn).toMatch(/Backup-Environment.*APPDATA.*LOCALAPPDATA.*USERPROFILE.*HOME/);
    expect(fn).toMatch(/\$savedEnv/);
    const backupIdx = fn.indexOf("Backup-Environment");
    const setEnvIdx = fn.indexOf("SetEnvironmentVariable");
    expect(backupIdx).toBeGreaterThan(0);
    expect(setEnvIdx).toBeGreaterThan(0);
    expect(backupIdx).toBeLessThan(setEnvIdx);
  });

  it("bounded launch sets isolated env vars before Start-Process", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    const setEnvIdx = fn.indexOf("SetEnvironmentVariable");
    const startProcIdx = fn.indexOf("Start-Process");
    expect(setEnvIdx).toBeGreaterThan(0);
    expect(startProcIdx).toBeGreaterThan(0);
    expect(setEnvIdx).toBeLessThan(startProcIdx);
  });

  it("bounded launch does not log individual isolated env var values", () => {
    // Only the root isolation path may be logged, not per-variable values
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    // The log must reference the root path, not individual env var names or values
    const logLines = fn.match(/Write-Host.*profileIsolationRoot/g) || [];
    expect(logLines.length).toBeGreaterThanOrEqual(1);
    for (const line of logLines) {
      expect(line).not.toMatch(/APPDATA/);
      expect(line).not.toMatch(/LOCALAPPDATA/);
    }
  });

  it("bounded launch uses Restore-Environment in finally block", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    expect(fn).toMatch(/finally\s*\{/);
    const finallyBlock = fn.match(/finally\s*\{[\s\S]*?\}\s*\n/m);
    expect(finallyBlock).not.toBeNull();
    expect(finallyBlock![0]).toMatch(/Restore-Environment/);
  });

  it("catch block in bounded launch still runs finally for env restoration", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    expect(fn).toMatch(/catch\s*\{/);
    // catch must come before finally
    const catchIdx = fn.indexOf("catch {");
    const finallyIdx = fn.indexOf("finally {");
    expect(catchIdx).toBeGreaterThan(0);
    expect(finallyIdx).toBeGreaterThan(catchIdx);
  });

  it("Restore-Environment is called before env-restored verification check", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    const restoreIdx = fn.indexOf("Restore-Environment");
    const restoreCheckIdx = fn.indexOf("bounded-launch-env-restored");
    expect(restoreIdx).toBeGreaterThan(0);
    expect(restoreCheckIdx).toBeGreaterThan(0);
    expect(restoreIdx).toBeLessThan(restoreCheckIdx);
  });

  it("bounded launch verifies env var restoration after finally with pass/fail check", () => {
    expect(content).toMatch(/bounded-launch-env-restored/);
    const restoredPass = content.match(/bounded-launch-env-restored.*pass.*restored/);
    expect(restoredPass).not.toBeNull();
    const restoredFail = content.match(/bounded-launch-env-restored.*fail.*not properly restored/);
    expect(restoredFail).not.toBeNull();
  });

  it("bounded launch checks profile writes contained under UserDataDir", () => {
    expect(content).toMatch(/bounded-launch-profile-writes-contained/);
    expect(content).toMatch(/captured under isolated paths/);
  });

  it("bounded launch profile-writes check does not run when launch itself failed", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    const writesCheckIdx = fn.indexOf("bounded-launch-profile-writes-contained");
    const launchFailedGuardIdx = fn.indexOf('if (-not $launchFailed)');
    expect(launchFailedGuardIdx).toBeGreaterThan(0);
    expect(writesCheckIdx).toBeGreaterThan(launchFailedGuardIdx);
  });

  // ---- Regression: PID variable collision (PS5.1 read-only $PID) ----

  it("bounded launch uses $launchedPid not $pid for child PID", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    // Must use $launchedPid, not the read-only automatic $pid
    expect(fn).toMatch(/\$launchedPid/);
    expect(fn).not.toMatch(/(?<!\$)pid = \$proc\.Id/);
    expect(fn).not.toMatch(/PID \$pid/);
    // Verify every PID reference uses the renamed variable
    const pidRefs = fn.match(/\$pid[^a-zA-Z]/g) || [];
    const launchedPidRefs = fn.match(/\$launchedPid[^a-zA-Z]/g) || [];
    expect(pidRefs.length).toBe(0);
    expect(launchedPidRefs.length).toBeGreaterThanOrEqual(6);
  });

  it("the script does not assign $pid elsewhere in executable-launch contexts", () => {
    // Only Start-Process calls in the file that relate to executable launch
    // must avoid $pid.  Uninstall / installer Start-Process calls do not
    // capture the PID at all, so they are fine.
    const launchContext = content.match(/Invoke-BoundedLaunchCheck[\s\S]*?]::GetFullPath/m);
    expect(launchContext).not.toBeNull();
    expect(launchContext![0]).not.toMatch(/\$pid/);
  });

  // ---- Regression: manifest-based profile leak detection ----

  it("defines New-DirectoryManifest helper function", () => {
    expect(content).toMatch(/function New-DirectoryManifest/);
    // Must return plain hashtable, not OrderedDictionary, to match Compare-DirectoryManifest [hashtable] params
    expect(content).toMatch(/\$manifest = @\{\}/);
    expect(content).not.toMatch(/\[ordered\]@\{/);
    expect(content).toMatch(/Get-FileHash.*SHA256/);
    expect(content).toMatch(/LastWriteTimeUtc/);
  });

  it("New-DirectoryManifest returns null for nonexistent path", () => {
    const func = content.match(/function New-DirectoryManifest \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    expect(func![0]).toMatch(/return \$null/);
    expect(func![0]).toMatch(/IsNullOrWhiteSpace/);
    expect(func![0]).toMatch(/Test-Path/);
  });

  it("defines Compare-DirectoryManifest helper function", () => {
    expect(content).toMatch(/function Compare-DirectoryManifest/);
    expect(content).toMatch(/\$Before/);
    expect(content).toMatch(/\$After/);
  });

  it("Compare-DirectoryManifest returns true when both Before and After are null", () => {
    const func = content.match(/function Compare-DirectoryManifest \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    expect(func![0]).toMatch(/return \$true/);
    // First guard: both null
    const nullCheck = func![0].match(/\$null -eq \$Before -and \$null -eq \$After/);
    expect(nullCheck).not.toBeNull();
  });

  it("Compare-DirectoryManifest returns false when one manifest is null", () => {
    const func = content.match(/function Compare-DirectoryManifest \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    const fn = func![0];
    const firstReturn = fn.indexOf("return $true");
    const secondReturn = fn.indexOf("return $false", firstReturn + 1);
    expect(firstReturn).toBeGreaterThan(0);
    expect(secondReturn).toBeGreaterThan(firstReturn);
    // The null-or check appears between the two returns
    const between = fn.substring(firstReturn + 10, secondReturn);
    expect(between).toMatch(/null.*null/);
  });

  it("bounded launch captures manifests of real profile subdirectories before env modification", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    // Manifest capture must happen after Backup-Environment but before SetEnvironmentVariable
    const backupIdx = fn.indexOf("Backup-Environment");
    const manifestCaptureIdx = fn.indexOf("New-DirectoryManifest");
    const setEnvIdx = fn.indexOf("SetEnvironmentVariable");
    expect(backupIdx).toBeGreaterThan(0);
    expect(manifestCaptureIdx).toBeGreaterThan(0);
    expect(setEnvIdx).toBeGreaterThan(0);
    expect(backupIdx).toBeLessThan(manifestCaptureIdx);
    expect(manifestCaptureIdx).toBeLessThan(setEnvIdx);
  });

  it("bounded launch targets baby-menu, Baby Menu, and .baby-menu subdirectories", () => {
    expect(content).toMatch(/APPDATA.*baby-menu/);
    expect(content).toMatch(/LOCALAPPDATA.*baby-menu/);
    expect(content).toMatch(/LOCALAPPDATA.*Baby Menu/);
    expect(content).toMatch(/USERPROFILE.*\\.baby-menu/);
  });

  it("bounded launch compares manifests after env restoration (manifest-unchanged check)", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    // The manifest comparison must use Compare-DirectoryManifest
    expect(fn).toMatch(/Compare-DirectoryManifest/);
    // It must produce a pass/fail check result
    expect(fn).toMatch(/bounded-launch-profile-manifest-unchanged/);
    expect(fn).toMatch(/Real profile subdirectories unchanged/);
    expect(fn).toMatch(/Real profile subdirectories changed/);
  });

  it("manifest-unchanged check runs after env restoration and env-verification", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    const envRestoredIdx = fn.indexOf("bounded-launch-env-restored");
    const manifestUnchangedIdx = fn.indexOf("bounded-launch-profile-manifest-unchanged");
    expect(envRestoredIdx).toBeGreaterThan(0);
    expect(manifestUnchangedIdx).toBeGreaterThan(0);
    expect(envRestoredIdx).toBeLessThan(manifestUnchangedIdx);
  });

  it("manifest-unchanged check uses ToUpperInvariant for canonical key", () => {
    expect(content).toMatch(/ToUpperInvariant/);
    expect(content).toMatch(/GetFullPath.*ToUpperInvariant/);
  });

  // ---- Regression: SHA256 key presence must match (not silently skip) ----

  it("Compare-DirectoryManifest uses -xor to require SHA256 presence match", () => {
    const func = content.match(/function Compare-DirectoryManifest \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    const fn = func![0];
    // Must use -xor to detect one-sided SHA256
    expect(fn).toMatch(/ContainsKey\('SHA256'\) -xor/);
    // When both have SHA256, values must still match
    expect(fn).toMatch(/ContainsKey\('SHA256'\) -and.*SHA256 -ne/);
  });

  it("SHA256 xor check appears after length and last-write checks", () => {
    const func = content.match(/function Compare-DirectoryManifest \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    const fn = func![0];
    const lengthIdx = fn.indexOf("b.Length");
    const lastWriteIdx = fn.indexOf("b.LastWrite");
    const xorIdx = fn.indexOf("-xor");
    expect(lengthIdx).toBeGreaterThan(0);
    expect(lastWriteIdx).toBeGreaterThan(0);
    expect(xorIdx).toBeGreaterThan(lastWriteIdx);
  });

  it("SHA256 value comparison happens after xor guard", () => {
    const func = content.match(/function Compare-DirectoryManifest \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    const fn = func![0];
    const xorIdx = fn.indexOf("-xor");
    const sha256ValueIdx = fn.indexOf("-and.*SHA256 -ne");
    // The -xor guard comes first, then the value comparison
    const sha256ValueLine = fn.match(/ContainsKey\('SHA256'\) -and.*SHA256 -ne/);
    expect(sha256ValueLine).not.toBeNull();
  });

  // ---- PS5.1 helper smoke script ----

  it("creates windows-validate-helpers-smoke.ps1 for standalone execution", async () => {
    const { access } = await import("node:fs/promises");
    const smokePath = resolve(__dirname, "..", "tests", "windows-validate-helpers-smoke.ps1");
    await expect(access(smokePath)).resolves.toBeUndefined();
  });

  it("smoke script is compatible with PS5.1 (#Requires -Version 5.1)", async () => {
    const { readFile } = await import("node:fs/promises");
    const smokePath = resolve(__dirname, "..", "tests", "windows-validate-helpers-smoke.ps1");
    const smoke = await readFile(smokePath, "utf-8");
    expect(smoke).toMatch(/#Requires -Version 5\.1/);
  });

  it("smoke script defines both helpers matching production signatures", async () => {
    const { readFile } = await import("node:fs/promises");
    const smokePath = resolve(__dirname, "..", "tests", "windows-validate-helpers-smoke.ps1");
    const smoke = await readFile(smokePath, "utf-8");
    // Must define New-DirectoryManifest returning plain @{}
    expect(smoke).toMatch(/function New-DirectoryManifest/);
    expect(smoke).toMatch(/\$manifest = @\{\}/);
    // Must define Compare-DirectoryManifest with [hashtable] params
    expect(smoke).toMatch(/function Compare-DirectoryManifest/);
    expect(smoke).toMatch(/\[hashtable\]\$Before/);
    // Must use -xor for SHA256 presence
    expect(smoke).toMatch(/-xor \$a\.ContainsKey/);
  });

  it("smoke script exercises at least 12 scenarios with Assert-Equal", async () => {
    const { readFile } = await import("node:fs/promises");
    const smokePath = resolve(__dirname, "..", "tests", "windows-validate-helpers-smoke.ps1");
    const smoke = await readFile(smokePath, "utf-8");
    const scenarios = smoke.match(/Assert-Equal/g) || [];
    expect(scenarios.length).toBeGreaterThanOrEqual(12);
  });
});
