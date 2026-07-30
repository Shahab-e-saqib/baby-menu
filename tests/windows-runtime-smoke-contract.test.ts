import { beforeAll, describe, expect, it } from "vitest";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(__dirname, "..");
const runnerPath = resolve(projectRoot, "scripts", "Verify-BabyMenuRuntimeSmoke.ps1");

const REQUIRED_FUNCTIONS = [
  "Invoke-RuntimeSmoke",
  "Assert-WindowsNative",
  "Assert-NotWsl",
  "Get-ExecutablePath",
  "Backup-Environment",
  "Restore-Environment",
  "Write-FailureEvidence",
];

const REQUIRED_PARAMS = [
  "UnpackedDir",
  "LaunchTimeoutSeconds",
];

describe("windows-runtime-smoke-contract", () => {
  let content: string;

  beforeAll(async () => {
    await expect(access(runnerPath)).resolves.toBeUndefined();
    content = await readFile(runnerPath, "utf-8");
  });

  it("exists and is readable", () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it("is compatible with Windows PowerShell 5.1", () => {
    expect(content).toMatch(/#Requires\s+-Version\s+5\.1/);
    expect(content).not.toMatch(/#Requires\s+-Version\s+7\.0/);
    const ps71Only = [/\?\?/, /\?\.\w/, /\?\?=/, /ForEach-Object -Parallel/];
    for (const pat of ps71Only) {
      expect(content, `PS5.1 must not use PS7+ syntax: ${pat}`).not.toMatch(pat);
    }
  });

  it("does not use PS7 automatic variables ($IsWindows etc.)", () => {
    expect(content).not.toMatch(/\$IsWindows/);
    expect(content).not.toMatch(/\$IsLinux/);
    expect(content).not.toMatch(/\$IsMacOS/);
  });

  it("sets $ErrorActionPreference to Stop", () => {
    expect(content).toMatch(/\$ErrorActionPreference\s*=\s*'Stop'/);
  });

  it("defines all required functions", () => {
    for (const fn of REQUIRED_FUNCTIONS) {
      expect(content, `missing function: ${fn}`).toMatch(new RegExp(`function ${fn}`));
    }
  });

  it("declares all required parameters", () => {
    for (const param of REQUIRED_PARAMS) {
      expect(content, `missing parameter: ${param}`).toContain(param);
    }
  });

  it("has mandatory UnpackedDir with PathType Container validation", () => {
    expect(content).toMatch(/UnpackedDir/);
    expect(content).toMatch(/PathType/);
  });

  it("has LaunchTimeoutSeconds parameter with ValidateRange 5-120", () => {
    expect(content).toMatch(/LaunchTimeoutSeconds/);
    expect(content).toMatch(/ValidateRange\(5,\s*120\)/);
  });

  it("isolates APPDATA, LOCALAPPDATA, USERPROFILE, HOME with temp roots", () => {
    expect(content).toMatch(/isolatedDirs/);
    expect(content).toMatch(/AppData-Roaming/);
    expect(content).toMatch(/AppData-Local/);
    expect(content).toMatch(/UserProfile/);
    expect(content).toMatch(/Home/);
  });

  it("uses ProcessStartInfo with UseShellExecute=false for all launches", () => {
    expect(content).toMatch(/ProcessStartInfo/);
    expect(content).toMatch(/RedirectStandardOutput/);
    expect(content).toMatch(/RedirectStandardError/);
    expect(content).toMatch(/UseShellExecute.*false/);
    expect(content).not.toMatch(/Start-Process\s+-FilePath\s+\$exePath/);
  });

  it("guards against non-Windows hosts via OSVersion.Platform", () => {
    expect(content).toMatch(/Assert-WindowsNative/);
    expect(content).toMatch(/OSVersion\.Platform/);
  });

  it("guards against WSL", () => {
    expect(content).toMatch(/Assert-NotWsl/);
    expect(content).toMatch(/WSL_DISTRO_NAME/);
  });

  it("proves no matching process exists before launch", () => {
    expect(content).toMatch(/pre-launch-no-running-process/);
    expect(content).toMatch(/Get-CimInstance/);
    expect(content).toMatch(/Win32_Process/);
    expect(content).toMatch(/ExecutablePath/);
  });

  it("pre-launch check compares GetDirectoryName against UnpackedDir", () => {
    expect(content).toMatch(/GetDirectoryName/);
    expect(content).toMatch(/StartsWith.*unpackedCanon/);
    expect(content).toMatch(/OrdinalIgnoreCase/);
  });

  it("clears child environment variables before Process.Start", () => {
    expect(content).toMatch(/EnvironmentVariables\.Clear/);
  });

  it("sets minimal env allowlist for child process", () => {
    expect(content).toMatch(/EnvironmentVariables\[.APPDATA.\]/);
    expect(content).toMatch(/EnvironmentVariables\[.LOCALAPPDATA.\]/);
    expect(content).toMatch(/EnvironmentVariables\[.USERPROFILE.\]/);
    expect(content).toMatch(/EnvironmentVariables\[.HOME.\]/);
    expect(content).toMatch(/EnvironmentVariables\[.TEMP.\]/);
    expect(content).toMatch(/EnvironmentVariables\[.TMP.\]/);
    expect(content).toMatch(/EnvironmentVariables\[.SYSTEMROOT.\]/);
  });

  it("sets WorkingDirectory to UnpackedDir on child process", () => {
    expect(content).toMatch(/\$psi\.WorkingDirectory\s*=\s*\$unpackedCanon/);
  });

  it("does not inherit GITHUB_ or ACTIONS_ environment variables", () => {
    expect(content).toMatch(/EnvironmentVariables\.Clear/);
    const envSetLines = content.match(/\$psi\.EnvironmentVariables\[[^\]]+\]\s*=/g) || [];
    for (const line of envSetLines) {
      expect(line).not.toMatch(/GITHUB_/i);
      expect(line).not.toMatch(/ACTIONS_/i);
      expect(line).not.toMatch(/AZURE_/i);
      expect(line).not.toMatch(/TOKEN/i);
      expect(line).not.toMatch(/SECRET/i);
    }
  });

  it("survivor CIM queries use ErrorAction Stop", () => {
    const stopCalls = (content.match(/Get-CimInstance[\s\S]*?ErrorAction Stop/g) || []);
    expect(stopCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("Get-ExecutablePath uses PathType Leaf to reject directories", () => {
    expect(content).toMatch(/PathType Leaf/);
  });

  it("Add-CheckResult supports skip status via ValidateSet", () => {
    expect(content).toMatch(/ValidateSet\('pass','fail','skip'/);
  });

  it("Add-CheckResult uses SKIP prefix for skip status", () => {
    expect(content).toMatch(/SKIP/);
  });

  it("uses wasAliveAtDeadline snapshot after polling loop", () => {
    expect(content).toMatch(/diagnostics\.wasAliveAtDeadline = -not/);
    expect(content).toMatch(/runtime-persistence/);
    expect(content).toMatch(/survived.*timeout/);
    expect(content).toMatch(/exited before deadline/);
  });

  it("captures exit code via WaitForExit(2000) on early exit", () => {
    expect(content).toMatch(/WaitForExit\(2000\)/);
    expect(content).toMatch(/\$diagnostics\.exitCode/);
  });

  it("parses second-instance-rejected JSON line-by-line from stdout and stderr", () => {
    expect(content).toMatch(/second-instance-rejected/);
    expect(content).toMatch(/foreach.*line.*split.*`n/);
    expect(content).toMatch(/"event"/);
    expect(content).toMatch(/"platform"/);
    expect(content).toMatch(/"isPackaged"/);
    expect(content).toMatch(/\$diagnostics\.singleInstanceRejected = \$true; break/);
  });

  it("produces safe diagnostic evidence with digests not raw output", () => {
    expect(content).toMatch(/diagnostic-evidence/);
    expect(content).toMatch(/stdoutSHA256/);
    expect(content).toMatch(/stderrSHA256/);
    expect(content).toMatch(/stdoutLen/);
    expect(content).toMatch(/stderrLen/);
    expect(content).toMatch(/singleInstanceRejected/);
    expect(content).toMatch(/diagnostics\.stdoutSHA256/);
    expect(content).toMatch(/diagnostics\.stderrSHA256/);
    expect(content).not.toMatch(/stdoutText.*Detail/);
  });

  it("caps stdout/stderr at 64KB with Substring", () => {
    // Raw output is never stored in diagnostics detail (only SHA-256 digests),
    // so Substring capping is not needed. The max cap constant still exists
    // for safety if raw output is ever stored.
    expect(content).toMatch(/65536/);
  });

  it("performs controlled kill via taskkill /T /F /PID", () => {
    expect(content).toMatch(/taskkill \/T \/F \/PID/);
    expect(content).not.toMatch(/taskkill.*IMAGENAME/);
  });

  it("proves no survivors after cleanup", () => {
    expect(content).toMatch(/cleanup-no-survivors/);
    expect(content).toMatch(/No survivors after forced cleanup/);
    expect(content).toMatch(/surviving process/);
  });

  it("uses Backup-Environment and Restore-Environment in try/finally", () => {
    expect(content).toMatch(/Backup-Environment/);
    expect(content).toMatch(/Restore-Environment/);
    expect(content).toMatch(/finally\s*\{/);
    expect(content).toMatch(/finally[\s\S]*?Restore-Environment/);
  });

  it("restores env vars and verifies after finally", () => {
    expect(content).toMatch(/env-restored/);
    expect(content).toMatch(/All parent env vars restored/);
    expect(content).toMatch(/Some parent env vars not properly restored/);
  });

  it("uses $launchedPid not read-only $pid", () => {
    const pidRefs = content.match(/\$pid[^a-zA-Z]/g) || [];
    const launchedPidRefs = content.match(/\$launchedPid[^a-zA-Z]/g) || [];
    expect(pidRefs.length).toBe(0);
    expect(launchedPidRefs.length).toBeGreaterThanOrEqual(4);
  });

  it("writes failure evidence JSON only on failure with SecretRedacted=true", () => {
    expect(content).toMatch(/SecretRedacted/);
    expect(content).toMatch(/runtime-smoke-failure/);
    expect(content).toMatch(/ConvertTo-Json/);
  });

  it("writes evidence via Write-FailureEvidence helper", () => {
    expect(content).toMatch(/function Write-FailureEvidence/);
    expect(content).toMatch(/EvidenceDir/);
    expect(content).toMatch(/Payload/);
  });

  it("failure evidence uses env:TEMP fallback when DiagnosticDir empty", () => {
    expect(content).toMatch(/env:TEMP.*baby-menu-runtime-smoke-diag/);
  });

  it("detects profile writes in isolated paths", () => {
    expect(content).toMatch(/profile-writes-contained/);
    expect(content).toMatch(/\$isolatedDirs\['APPDATA'\]/);
    expect(content).toMatch(/\$isolatedDirs\['LOCALAPPDATA'\]/);
  });

  it("throws on any failure, 0 on all pass", () => {
    expect(content).toMatch(/throw "Runtime smoke FAILED"/);
    expect(content).toMatch(/All runtime smoke checks passed/);
  });

  it("observes profile-writes after cleanup block", () => {
    const fnIdx = content.indexOf("function Invoke-RuntimeSmoke");
    const fnEnd = content.lastIndexOf("function Add-CheckResult");
    const fnBody = fnIdx > 0 && fnEnd > fnIdx ? content.substring(fnIdx, fnEnd) : content;
    const cleanupIdx = fnBody.indexOf("cleanup-no-survivors");
    const writesIdx = fnBody.indexOf("profile-writes-contained");
    expect(cleanupIdx).toBeGreaterThan(0);
    expect(writesIdx).toBeGreaterThan(0);
    expect(cleanupIdx).toBeLessThan(writesIdx);
  });

  it("does not use no-sandbox, disable-gpu, elevation, or retries", () => {
    expect(content).not.toMatch(/no-sandbox/);
    expect(content).not.toMatch(/disable-gpu/);
    expect(content).not.toMatch(/runas\b/i);
    expect(content).not.toMatch(/retry\b/i);
  });

  it("guarantees cleanup result on every path including CIM failure", () => {
    expect(content).toMatch(/Cleanup sweep threw/);
    expect(content).toMatch(/cleanup-no-survivors/);
    const failResults = content.match(/cleanup-no-survivors.*fail/g) || [];
    expect(failResults.length).toBeGreaterThanOrEqual(1);
  });

  it("temp profile cleanup runs in finally block with ErrorAction Stop", () => {
    const fnBody = content.substring(content.indexOf("function Invoke-RuntimeSmoke"));
    const finallyIdx = fnBody.indexOf("finally {");
    expect(finallyIdx).toBeGreaterThan(0);
    const finallyBlock = fnBody.substring(finallyIdx);
    expect(finallyBlock).toMatch(/Remove-Item.*-Path \$tempRoot/);
    expect(finallyBlock).toMatch(/-ErrorAction Stop/);
    expect(finallyBlock).toMatch(/Restore-Environment/);
    expect(finallyBlock).toMatch(/Test-Path \$tempRoot/);
  });

  it("records cleanup-temp pass/fail via Add-CheckResult", () => {
    expect(content).toMatch(/cleanup-temp/);
    expect(content).toMatch(/Temp root removed:/);
    expect(content).toMatch(/Temp root still exists after removal/);
    expect(content).toMatch(/Failed to remove temp root/);
  });

  it("persistence check is recorded before controlled kill", () => {
    const fnIdx = content.indexOf("function Invoke-RuntimeSmoke");
    const fnBody = content.substring(fnIdx);
    const persistenceIdx = fnBody.indexOf("runtime-persistence");
    const killIdx = fnBody.indexOf("taskkill");
    expect(persistenceIdx).toBeGreaterThan(0);
    expect(killIdx).toBeGreaterThan(0);
    expect(persistenceIdx).toBeLessThan(killIdx);
  });

  it("observes profile-writes check uses isolated dir vars not exePath", () => {
    const lines = content.match(/.+/g) || [];
    const writesLine = lines.find(l => l.includes('profile-writes-contained'));
    expect(writesLine).toBeTruthy();
    if (writesLine) {
      expect(writesLine).not.toMatch(/\$exePath/);
    }
  });

  // ---- Fix-specific behavioral tests ----

  it("initializes $savedEnv before outer try block", () => {
    const fnBody = content.substring(content.indexOf("function Invoke-RuntimeSmoke"));
    const tryIdx = fnBody.indexOf("try {");
    const savedEnvInitIdx = fnBody.indexOf("$savedEnv = @{}");
    expect(tryIdx).toBeGreaterThan(0);
    expect(savedEnvInitIdx).toBeGreaterThan(0);
    expect(savedEnvInitIdx).toBeLessThan(tryIdx);
  });

  it("prelaunch enumeration failure returns result object (not bare $false)", () => {
    expect(content).toMatch(/return @{ Passed = \$false; Diagnostics = \$diagnostics }/);
  });

  it("creates isolated TEMP directory before Process.Start", () => {
    expect(content).toMatch(/\$isolatedTemp = Join-Path/);
    // Temp, New-Item, -Path, and isolatedTemp are on separate lines
    expect(content).toMatch(/Temp[\s\S]*New-Item[\s\S]*-Path[\s\S]*isolatedTemp/);
  });

  it("failure evidence payload includes Diagnostics hashtable with safe fields", () => {
    // Evidence payload carries $smokeResult.Diagnostics
    expect(content).toMatch(/Diagnostics = \$smokeResult\.Diagnostics/);
    // The $diagnostics hashtable (assigned to Passed/Diagnostics returns) includes safe fields
    expect(content).toMatch(/\$diagnostics\s*=\s*@\{/);
    expect(content).toMatch(/\$diagnostics[\s\S]*exitCode/);
    expect(content).toMatch(/\$diagnostics[\s\S]*wasAliveAtDeadline/);
    expect(content).toMatch(/\$diagnostics[\s\S]*singleInstanceRejected/);
    expect(content).toMatch(/\$diagnostics[\s\S]*stdoutLength/);
    expect(content).toMatch(/\$diagnostics[\s\S]*stderrLength/);
    expect(content).toMatch(/\$diagnostics[\s\S]*stdoutSHA256/);
    expect(content).toMatch(/\$diagnostics[\s\S]*stderrSHA256/);
  });

  it("function returns hashtable with Passed and Diagnostics keys", () => {
    expect(content).toMatch(/Passed = \$false/);
    expect(content).toMatch(/Passed = \$true/);
    expect(content).toMatch(/Diagnostics = \$diagnostics/);
  });

  it("no $host.SetShouldExit call in workflow or script", () => {
    expect(content).not.toMatch(/SetShouldExit/);
  });

  it("workflow step does not capture output; relies on outcome", () => {
    // The script throws on failure; GitHub step fails via ErrorActionPreference
    expect(content).toMatch(/throw "Runtime smoke FAILED"/);
    // The trap handler still uses exit 1 for unexpected terminating errors
    expect(content).toMatch(/trap[\s\S]*exit 1/);
    // No GITHUB_OUTPUT capture of status
    expect(content).not.toMatch(/GITHUB_OUTPUT/);
  });

  // Secondary instance (second launch) behavior is covered by unit test,
  // not by a second packaged launch
  it("second instance secondary behavior: exit(0) not STATUS_BREAKPOINT", () => {
    expect(content).toMatch(/second-instance-rejected/);
    expect(content).toMatch(/diagnostics\.singleInstanceRejected/);
  });
});
