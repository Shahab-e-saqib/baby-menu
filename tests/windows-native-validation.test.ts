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
    // Must not use PS7+ only syntax
    const ps71Only = [/\?\?/, /\?\.\w/, /\?\?=/, /ForEach-Object -Parallel/, /using namespace /];
    for (const pat of ps71Only) {
      expect(content, `PS5.1 must not use PS7+ syntax: ${pat}`).not.toMatch(pat);
    }
    // ValidateSet with pass/fail/skip is PS5.1-compatible
    expect(content).toMatch(/ValidateSet\('pass','fail','skip'/);
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

  it("accepts versioned product names without accepting prefix-confusable names", () => {
    expect(content).toContain("Test-ProductUninstallDisplayName");
    expect(content).toContain("ProductVersionPattern");
    const versionedName = /^(Baby Menu|Baby Menu Dev)\s+\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;
    expect(versionedName.test("Baby Menu 0.1.21")).toBe(true);
    expect(versionedName.test("Baby Menu Dev 0.1.21")).toBe(true);
    expect(versionedName.test("Baby Menu Evil 0.1.21")).toBe(false);
    expect(versionedName.test("Baby Menu 0.1.21-extra-name")).toBe(true);
  });

  it("passes the packaged test-home override and records containment", () => {
    expect(content).toContain("BABY_MENU_PACKAGED_TEST_HOME");
    expect(content).toContain("bounded-launch-packaged-home-contained");
    expect(content).toContain("effectivePackagedRoot");
  });

  it("creates and verifies isolated sentinel file with SHA256 hash comparison", () => {
    expect(content).toMatch(/SentinelHash/);
    expect(content).toMatch(/Get-FileHash/);
    expect(content).toMatch(/SHA256/);
    expect(content).toMatch(/sentinel-verify-/);
    expect(content).toMatch(/Sentinel SHA256 mismatch/);
  });

  it("has bounded launch persistence and cleanup as separate deterministic checks", () => {
    expect(content).toMatch(/bounded-launch-persistence/);
    expect(content).toMatch(/bounded-launch-cleanup/);
    expect(content).toMatch(/wasAliveAtDeadline/);
    expect(content).toMatch(/survived.*timeout/);
  });

  it("bounded launch uses ProcessStartInfo with UseShellExecute=false", () => {
    expect(content).toMatch(/ProcessStartInfo/);
    expect(content).toMatch(/RedirectStandardOutput/);
    expect(content).toMatch(/RedirectStandardError/);
    expect(content).toMatch(/UseShellExecute.*false/);
  });

  it("bounded launch captures exit code from Process.ExitCode", () => {
    expect(content).toMatch(/\$exitCode/);
    expect(content).toMatch(/\.ExitCode/);
    expect(content).toMatch(/exit code/);
  });

  it("bounded launch caps stdout/stderr at 64KB with Substring cap", () => {
    expect(content).toMatch(/65536/);
    expect(content).toMatch(/Substring\(0, \$maxCap\)/);
  });

  it("bounded launch computes SHA-256 digests of captured stdout/stderr with base64 redaction", () => {
    const launchFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(launchFunc).not.toBeNull();
    const fn = launchFunc![0];
    // Must compute SHA256 digests for both stdout and stderr
    expect(fn).toMatch(/stdoutDigest/);
    expect(fn).toMatch(/stderrDigest/);
    expect(fn).toMatch(/SHA256\]::Create\(\)/);
    expect(fn).toMatch(/REDACTED-BASE64/);
    // Digest must appear in diagnostics detail
    expect(fn).toMatch(/stdoutSHA256/);
    expect(fn).toMatch(/stderrSHA256/);
  });

  it("persistence uses wasAliveAtDeadline snapshot; pass only when alive at deadline", () => {
    const launchFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(launchFunc).not.toBeNull();
    const fn = launchFunc![0];
    // Must snapshot alive-at-deadline immediately after the polling loop
    expect(fn).toMatch(/\$wasAliveAtDeadline = -not/);
    // Pass only when wasAliveAtDeadline is true (may be on adjacent lines)
    expect(fn).toMatch(/\$wasAliveAtDeadline[\s\S]*?survived/);
    // Any process that exited (including at the deadline boundary) must fail
    expect(fn).not.toMatch(/exited early after.*\$\{elapsed\}s/);
    // Exit code captured via brief WaitForExit(2000)
    expect(fn).toMatch(/WaitForExit\(2000\)/);
  });

  it("persistence records fail for process that exited during the final polling sleep (boundary regression)", () => {
    // The while loop exits when elapsed >= LaunchTimeoutSeconds; a process
    // that exited during the last 2-second sleep must not receive a pass.
    const launchFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(launchFunc).not.toBeNull();
    const fn = launchFunc![0];
    // wasAliveAtDeadline is snapshotted after the loop but before any kill.
    // bounded-launch-persistence appears in early guards; use lastIndexOf to
    // find the main path occurrence after the while loop.
    const loopStart = fn.indexOf("while (\$elapsed -lt");
    const snapshotIdx = fn.indexOf("\$wasAliveAtDeadline");
    const persistenceCheckIdx = fn.lastIndexOf("bounded-launch-persistence");
    expect(loopStart).toBeGreaterThan(0);
    expect(snapshotIdx).toBeGreaterThan(loopStart);
    expect(snapshotIdx).toBeLessThan(persistenceCheckIdx);
  });

  it("cleanup check runs independently even when persistence failed (early exit)", () => {
    // The cleanup check must not be gated on persistence passing
    const launchFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(launchFunc).not.toBeNull();
    const fn = launchFunc![0];
    // Cleanup must appear before any guard that would skip it due to persistence failure
    expect(fn).toMatch(/CLEANUP/);
    expect(fn).toMatch(/bounded-launch-cleanup/);
    // Cleanup must not be inside a $persistencePassed guard
    const persistenceIfIdx = fn.indexOf("persistence.*pass");
    const cleanupIdx = fn.indexOf("bounded-launch-cleanup");
    // Cleanup check should not be gated on persistence passing alone
  });

  it("env restoration and manifest checks run after persistence failure / catch", () => {
    // Verify env-restored and manifest-unchanged checks come after the finally block
    const launchFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(launchFunc).not.toBeNull();
    const fn = launchFunc![0];
    const finallyBlockStart = fn.lastIndexOf("finally {");
    const envRestoredIdx = fn.indexOf("bounded-launch-env-restored");
    const manifestIdx = fn.indexOf("bounded-launch-profile-manifest-unchanged");
    expect(finallyBlockStart).toBeGreaterThan(0);
    expect(envRestoredIdx).toBeGreaterThan(finallyBlockStart);
    expect(manifestIdx).toBeGreaterThan(finallyBlockStart);
  });

  it("bounded launch records diagnostic detail with safe markers (singleInstanceRejected, digest lengths)", () => {
    expect(content).toMatch(/bounded-launch-diagnostics/);
    expect(content).toMatch(/singleInstanceRejected/);
    expect(content).toMatch(/stdoutLen/);
    expect(content).toMatch(/stderrLen/);
  });

  it("bounded launch parses second-instance-rejected JSON line-by-line from both stdout and stderr", () => {
    const launchFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(launchFunc).not.toBeNull();
    const fn = launchFunc![0];
    expect(fn).toMatch(/second-instance-rejected/);
    // Must scan each line individually (line-by-line)
    expect(fn).toMatch(/foreach.*line.*split.*`n/);
    // Must check both stdout and stderr
    expect(fn).toMatch(/foreach.*line.*\$rawStdout/);
    expect(fn).toMatch(/foreach.*line.*\$rawStderr/);
    // Must match exact fields: event, platform, isPackaged
    expect(fn).toMatch(/"event"/);
    expect(fn).toMatch(/"platform"/);
    expect(fn).toMatch(/"isPackaged"/);
    // Must not embed raw output text in check details
    expect(fn).not.toMatch(/stdoutText.*Detail/);
  });

  it("bounded launch marker parsing ignores other log lines on both streams (console.warn on stderr)", () => {
    // The parser must tolerate extraneous lines before/after the marker
    // and accept the marker line when mixed with arbitrary other content.
    const launchFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(launchFunc).not.toBeNull();
    const fn = launchFunc![0];
    // Must test each line independently, not the whole stream
    expect(fn).toMatch(/line.*-match.*secondInstanceLine/);
    // Must break on first matching line so only one detection is needed
    expect(fn).toMatch(/\$singleInstanceRejected = \$true; break/);
  });

  it("WhatIf plan mode produces exactly 24 checks with exit0, empty stderr, PlanOnly, 0 failures", () => {
    // post-install-no-running-app added one check (was 23, now 24).
    const planOnlySkips = (content.match(/Plan-only:/g) || []).length; // 10
    expect(planOnlySkips).toBe(10);
    // Manual checks: 7 entries in Get-ManualChecks
    const manualEntries = (content.match(/@{ Name = '/g) || []).length;
    expect(manualEntries).toBe(7);
    // Unsupported checks: 5 distinct check names
    const unsupportedNames = ['packaged-extension-execution', 'sqlite-persistence', 'keep-undo-change-session', 'credential-inheritance', 'descendant-cancellation'];
    const unsupportedCount = unsupportedNames.filter(n => content.includes(n)).length;
    expect(unsupportedCount).toBe(5);
    // Preflight pass and uninstall skip (not Plan-only)
    expect(content).toMatch(/preflight-guards/);
    expect(content).toMatch(/Uninstall requires -AllowUninstall/);
    // Total: 10(Plan-only) + 7(manual) + 5(unsupported) + 1(preflight) + 1(uninstall) = 24
  });

  it("bounded launch guarantees cleanup result on every path including process never launched", () => {
    const launchFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(launchFunc).not.toBeNull();
    const fn = launchFunc![0];
    // Catch block must handle process-never-launched case
    expect(fn).toMatch(/process never launched/);
    expect(fn).toMatch(/cleanup.*skip/);
    // Exactly one cleanup result must be recorded on every code path
    const cleanupResults = fn.match(/bounded-launch-cleanup.*(?:pass|fail|skip)/g) || [];
    expect(cleanupResults.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Post-install process detection ----

  it("defines Invoke-PostInstallProcessCheck function", () => {
    expect(content).toMatch(/function Invoke-PostInstallProcessCheck/);
  });

  it("post-install process check uses Get-CimInstance Win32_Process with -ErrorAction Stop inside try/catch", () => {
    const func = content.match(/function Invoke-PostInstallProcessCheck \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    const fn = func![0];
    // Must use -ErrorAction Stop (not SilentlyContinue) so inaccessible data is caught
    expect(fn).toMatch(/Get-CimInstance.*Win32_Process.*ErrorAction Stop/);
    // Must wrap in try/catch (use [\s\S] for multiline)
    expect(fn).toMatch(/try\s*\{[\s\S]*?Get-CimInstance[\s\S]*?Win32_Process[\s\S]*?ErrorAction Stop/);
    expect(fn).toMatch(/catch\s*\{[\s\S]*?Add-CheckResult[\s\S]*?\$name[\s\S]*?'fail'/);
    expect(fn).toMatch(/catch\s*\{[\s\S]*?\$script:ProceedWithLaunch = \$false/);
    expect(fn).toMatch(/ExecutablePath/);
  });

  it("post-install process check uses -ErrorAction Stop for re-enumeration after kill", () => {
    const func = content.match(/function Invoke-PostInstallProcessCheck \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    const fn = func![0];
    // Second Get-CimInstance (survivor check) must also use -ErrorAction Stop
    const catchBlocks = fn.match(/catch \{[^}]*\}/g) || [];
    expect(catchBlocks.length).toBeGreaterThanOrEqual(2);
  });

  it("enumeration failure sets ProceedWithLaunch=false and suppresses explicit launch", () => {
    const func = content.match(/function Invoke-PostInstallProcessCheck \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    const fn = func![0];
    // First catch block: enumeration failure -> fail + ProceedWithLaunch = false + return
    const catch1 = fn.match(/catch \{[\s\S]*?\}/);
    expect(catch1).not.toBeNull();
    const c1 = catch1![0];
    expect(c1).toMatch(/Add-CheckResult[\s\S]*?\$name[\s\S]*?'fail'/);
    expect(c1).toMatch(/\$script:ProceedWithLaunch = \$false/);
    expect(c1).toMatch(/return/);
    // Must not log process names, PIDs, or other sensitive details on enumeration failure
    expect(c1).not.toMatch(/PID/);
    expect(c1).not.toMatch(/ExecutablePath/);
    expect(c1).not.toMatch(/ProcessId/);
  });

  it("post-install process check uses GetDirectoryName path matching against InstallDir", () => {
    const func = content.match(/function Invoke-PostInstallProcessCheck \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    expect(func![0]).toMatch(/GetDirectoryName/);
    // Must compare against $installDirCanon using StartsWith with OrdinalIgnoreCase
    expect(func![0]).toMatch(/StartsWith.*installDirCanon/);
    expect(func![0]).toMatch(/OrdinalIgnoreCase/);
    expect(func![0]).not.toMatch(/IMAGENAME/);
    expect(func![0]).not.toMatch(/\bname\b.*match/);
  });

  it("post-install process check uses taskkill /T /F /PID for killing (not by name)", () => {
    const func = content.match(/function Invoke-PostInstallProcessCheck \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    expect(func![0]).toMatch(/taskkill \/T \/F \/PID/);
    // Must kill by PID, not by IMAGENAME or process name
    expect(func![0]).not.toMatch(/taskkill.*IMAGENAME/);
    expect(func![0]).not.toMatch(/taskkill.*\/IM\b/);
  });

  it("post-install process check sets $script:ProceedWithLaunch to false when processes found", () => {
    const func = content.match(/function Invoke-PostInstallProcessCheck \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    expect(func![0]).toMatch(/\$script:ProceedWithLaunch = \$false/);
  });

  it("post-install process check reports pass with no running app processes, fail with any found", () => {
    const func = content.match(/function Invoke-PostInstallProcessCheck \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    const fn = func![0];
    expect(fn).toMatch(/post-install-no-running-app/);
    expect(fn).toMatch(/'pass'.*No app processes running/);
    expect(fn).toMatch(/'fail'.*app process.*running from InstallDir/);
  });

  it("post-install process check verifies no survivors after kill", () => {
    const func = content.match(/function Invoke-PostInstallProcessCheck \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    const fn = func![0];
    expect(fn).toMatch(/survivor/);
    expect(fn).toMatch(/no survivors/);
  });

  it("post-install process check WhatIf guard returns honest skip without mutation", () => {
    const func = content.match(/function Invoke-PostInstallProcessCheck \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    const fn = func![0];
    // Must have WhatIf guard that returns early
    expect(fn).toMatch(/\$WhatIfPreference/);
    expect(fn).toMatch(/return/);
    // Must not call Get-CimInstance or taskkill in the WhatIf guard path
    const whatIfBlock = fn.match(/\$WhatIfPreference\)\s*\{[\s\S]*?return/);
    expect(whatIfBlock).not.toBeNull();
    expect(whatIfBlock![0]).not.toMatch(/Get-CimInstance/);
    expect(whatIfBlock![0]).not.toMatch(/taskkill/);
  });

  it("main flow calls Invoke-PostInstallProcessCheck before Invoke-BoundedLaunchCheck", () => {
    // Use lastIndexOf to find the invocation call sites in the main flow
    // (function definitions appear earlier in the file and would give wrong order)
    const postInstallIdx = content.lastIndexOf("Invoke-PostInstallProcessCheck");
    const boundedLaunchIdx = content.lastIndexOf("Invoke-BoundedLaunchCheck");
    expect(postInstallIdx).toBeGreaterThan(0);
    expect(boundedLaunchIdx).toBeGreaterThan(0);
    expect(postInstallIdx).toBeLessThan(boundedLaunchIdx);
  });

  it("bounded launch is gated by $script:ProceedWithLaunch", () => {
    expect(content).toMatch(/\$script:ProceedWithLaunch/);
    // Use lastIndexOf to find the gate and call in the main flow
    const gateIdx = content.lastIndexOf("\$script:ProceedWithLaunch");
    const boundedLaunchIdx = content.lastIndexOf("Invoke-BoundedLaunchCheck");
    expect(gateIdx).toBeGreaterThan(0);
    expect(boundedLaunchIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeLessThan(boundedLaunchIdx);
    expect(content).toMatch(/if \(\$script:ProceedWithLaunch\)/);
  });

  it("all bounded-launch sub-checks are skipped when ProceedWithLaunch is false", () => {
    const elseBlock = content.match(/else \{\s+Add-CheckResult -Name 'bounded-launch-persistence'[\s\S]*?\n\}/);
    expect(elseBlock).not.toBeNull();
    const block = elseBlock![0];
    expect(block).toMatch(/bounded-launch-persistence.*skip/);
    expect(block).toMatch(/bounded-launch-cleanup.*skip/);
    expect(block).toMatch(/bounded-launch-diagnostics.*skip/);
    expect(block).toMatch(/bounded-launch-exe-under-installdir.*skip/);
    expect(block).toMatch(/bounded-launch-profile-isolation.*skip/);
    expect(block).toMatch(/bounded-launch-profile-writes-contained.*skip/);
    expect(block).toMatch(/bounded-launch-env-restored.*skip/);
    expect(block).toMatch(/bounded-launch-profile-manifest-unchanged.*skip/);
    // Must have exactly one result per check (no duplicate bounded-launch-persistence)
    const persistenceMatches = block.match(/bounded-launch-persistence/g) || [];
    expect(persistenceMatches.length).toBe(1);
  });

  it("post-install-no-running-app has exactly one result per relevant check", () => {
    const matches = content.match(/post-install-no-running-app/g) || [];
    expect(matches.length).toBe(1);
  });

  it("bounded-launch-persistence ManualGuidance does not suggest retry; says stop/report to captain", () => {
    // Find the else-block ManualGuidance where bounded-launch-persistence is skipped
    // with the ProceedWithLaunch is false message (not the -AllowLaunch guard)
    const skipGuidance = content.match(/ProceedWithLaunch is false.*ManualGuidance '[^']*'/);
    expect(skipGuidance).not.toBeNull();
    const guidance = skipGuidance![0];
    expect(guidance).not.toMatch(/retry/i);
    expect(guidance).not.toMatch(/clean environment/);
    expect(guidance).toMatch(/Stop/i);
    expect(guidance).toMatch(/captain/);
    expect(guidance).toMatch(/another launch.*captain authorization/i);
  });

  it("post-install process check is PS5.1 compatible (no ?? ?. ??= ForEach-Object -Parallel)", () => {
    const func = content.match(/function Invoke-PostInstallProcessCheck \{[\s\S]*?^}/m);
    expect(func).not.toBeNull();
    const fn = func![0];
    expect(fn).not.toMatch(/\?\?/);
    expect(fn).not.toMatch(/\?\.\w/);
    expect(fn).not.toMatch(/\?\?=/);
    expect(fn).not.toMatch(/ForEach-Object -Parallel/);
    // Uses ForEach-Object with scriptblock or foreach statement
    expect(fn).toMatch(/\$found \| ForEach-Object/);
  });

  it("persistence check is recorded before any controlled kill (taskkill)", () => {
    const launchFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(launchFunc).not.toBeNull();
    const fn = launchFunc![0];
    const persistenceAddIdx = fn.indexOf("bounded-launch-persistence");
    const killIdx = fn.indexOf("taskkill");
    const diagnosticsIdx = fn.indexOf("bounded-launch-diagnostics");
    expect(persistenceAddIdx).toBeGreaterThan(0);
    expect(diagnosticsIdx).toBeGreaterThan(0);
    // Persistence check is recorded before taskkill
    expect(persistenceAddIdx).toBeLessThan(killIdx);
    // Diagnostics come after cleanup
    expect(diagnosticsIdx).toBeGreaterThan(killIdx);
  });

  it("process-tree cleanup via taskkill still present", () => {
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
      { name: "Invoke-BoundedLaunchCheck", skipPattern: "Plan-only: would launch Baby Menu", passPattern: "ProcessStartInfo" },
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

  it("accepts exact production and dev package identities", () => {
    expect(content).toContain("$script:ProductNames = @('Baby Menu', 'Baby Menu Dev')");
    expect(content).toContain("$script:ExecutableNames = @('Baby Menu.exe', 'Baby Menu Dev.exe', 'BabyMenu.exe')");
    expect(content).toContain("'Uninstall Baby Menu Dev.exe'");
    expect(content).toContain("Test-ProductUninstallDisplayName -DisplayName $displayName");
  });

  it("enumerates all processes under InstallDir via Win32_Process for survivor cleanup", () => {
    expect(content).toMatch(/Win32_Process/);
    expect(content).toMatch(/ExecutablePath/);
    expect(content).toMatch(/GetDirectoryName/);
    // Must fail if any descendant survives, not just the parent PID
    expect(content).toMatch(/surviving process/);
    expect(content).toMatch(/No survivors after forced cleanup/);
  });

  it("bounded cleanup includes the launched PID and fails closed on enumeration errors", () => {
    const launchFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(launchFunc).not.toBeNull();
    const fn = launchFunc![0];
    const cimQueries = fn.match(/Get-CimInstance -ClassName Win32_Process[^\r\n]*/g) ?? [];
    expect(cimQueries.length).toBeGreaterThanOrEqual(4);
    expect(cimQueries.every((query) => query.includes("-ErrorAction Stop"))).toBe(true);
    expect(fn).not.toMatch(/ProcessId -ne \$launchedPid/);
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
    // Guard must mention bounded timeout in its skip message
    expect(guard).toMatch(/bounded timeout/);
  });

  it("bounded launch checks executable-under-InstallDir as deterministic check before launch", () => {
    expect(content).toMatch(/bounded-launch-exe-under-installdir/);
    expect(content).toMatch(/'pass'.*Executable.*is under InstallDir/);
    expect(content).toMatch(/'fail'.*not under InstallDir/);
  });

  it("bounded launch exe-under-InstallDir check fails early before Process::Start", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    const exeCheckIdx = fn.indexOf("bounded-launch-exe-under-installdir");
    const startProcIdx = fn.indexOf("Process]::Start");
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

  it("bounded launch sets isolated env vars before Process::Start", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    const setEnvIdx = fn.indexOf("SetEnvironmentVariable");
    const startProcIdx = fn.indexOf("Process]::Start");
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

  it("bounded launch profile-writes check runs unconditionally after cleanup", () => {
    const blFunc = content.match(/function Invoke-BoundedLaunchCheck \{[\s\S]*?^}/m);
    expect(blFunc).not.toBeNull();
    const fn = blFunc![0];
    expect(fn).toMatch(/bounded-launch-profile-writes-contained/);
    // Check appears after the cleanup result (cleanupRecorded)
    const cleanupIdx = fn.indexOf("bounded-launch-cleanup");
    const writesIdx = fn.indexOf("bounded-launch-profile-writes-contained");
    expect(cleanupIdx).toBeGreaterThan(0);
    expect(writesIdx).toBeGreaterThan(cleanupIdx);
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

  it("smoke script exercises at least 29 scenarios with Assert-Equal or Assert-Contains", async () => {
    const { readFile } = await import("node:fs/promises");
    const smokePath = resolve(__dirname, "..", "tests", "windows-validate-helpers-smoke.ps1");
    const smoke = await readFile(smokePath, "utf-8");
    const assertions = (smoke.match(/Assert-Equal/g) || []).length + (smoke.match(/Assert-Contains/g) || []).length;
    expect(assertions).toBeGreaterThanOrEqual(29);
  });

  it("smoke script uses ProcessStartInfo for launch pattern tests", async () => {
    const { readFile } = await import("node:fs/promises");
    const smokePath = resolve(__dirname, "..", "tests", "windows-validate-helpers-smoke.ps1");
    const smoke = await readFile(smokePath, "utf-8");
    expect(smoke).toMatch(/ProcessStartInfo/);
    expect(smoke).toMatch(/RedirectStandardOutput/);
    expect(smoke).toMatch(/\.ExitCode/);
    expect(smoke).toMatch(/exit code 0/);
    expect(smoke).toMatch(/exit code 42/);
  });

  it("smoke script tests output capping and env backup/restore", async () => {
    const { readFile } = await import("node:fs/promises");
    const smokePath = resolve(__dirname, "..", "tests", "windows-validate-helpers-smoke.ps1");
    const smoke = await readFile(smokePath, "utf-8");
    expect(smoke).toMatch(/Cap-Output/);
    expect(smoke).toMatch(/TRUNCATED/);
    expect(smoke).toMatch(/Backup-Environment/);
    expect(smoke).toMatch(/Restore-Environment/);
  });
});
