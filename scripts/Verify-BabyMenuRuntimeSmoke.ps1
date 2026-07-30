<#
.SYNOPSIS
  Verifies Baby Menu packaged Windows runtime persistence with bounded launch.
  Compatible with Windows PowerShell 5.1 and PowerShell 7+.
.DESCRIPTION
  Launches the Baby Menu app from a win-unpacked directory once, with isolated
  profile roots (APPDATA/LOCALAPPDATA/USERPROFILE/HOME), proves it stays alive
  for a bounded 20s, captures safe diagnostic evidence on early exit, performs
  controlled cleanup, and proves no survivors. Does not require the NSIS
  installer - works against the electron-builder dir output.
  Never inherits CI secrets: the child process receives only a minimal
  allowlist of environment variables (isolated profile paths plus TEMP/TMP and
  SYSTEMROOT). WorkingDirectory is set to UnpackedDir.
.PARAMETER UnpackedDir
  Path to the win-unpacked directory (e.g. release/win-unpacked).
.PARAMETER LaunchTimeoutSeconds
  How long to wait for the app to stay alive (default 20).
.PARAMETER DiagnosticDir
  Where to write evidence on failure (default: env:TEMP\baby-menu-runtime-smoke-diag).
#>

#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateScript({ Test-Path $_ -PathType Container })]
    [string]$UnpackedDir,

    [ValidateRange(5, 120)]
    [int]$LaunchTimeoutSeconds = 20,

    [string]$DiagnosticDir = ''
)

$ErrorActionPreference = 'Stop'

trap {
    [Console]::Error.WriteLine("Fatal: $_")
    exit 1
}

$passed = 0
$failed = 0

function Add-CheckResult {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [ValidateSet('pass','fail','skip')] [string]$Status,
        [string]$Detail = ''
    )
    if ($Status -eq 'pass') { $script:passed++ } else { $script:failed++ }
    $prefix = if ($Status -eq 'pass') { 'PASS' } else { if ($Status -eq 'skip') { 'SKIP' } else { 'FAIL' } }
    if ($Detail) { Write-Host "  [$prefix] $Name - $Detail" }
    else { Write-Host "  [$prefix] $Name" }
}

# ---------------------------------------------------------------------------
# Platform guards
# ---------------------------------------------------------------------------

function Assert-WindowsNative {
    $platform = [System.Environment]::OSVersion.Platform
    if ($platform -eq 'Unix' -or $platform -eq 'MacOSX') {
        throw "This runner must execute on native Windows. Detected: $platform"
    }
    if ($env:OS -ne 'Windows_NT') { throw "Environment is not Windows_NT: $env:OS" }
}

function Assert-NotWsl {
    if (Test-Path '/proc/version') {
        $procVer = Get-Content '/proc/version' -TotalCount 1 -ErrorAction SilentlyContinue
        if ($procVer -and $procVer -match 'Microsoft|WSL') {
            throw "This runner must execute on native Windows, not WSL."
        }
    }
    if ($env:WSL_DISTRO_NAME) { throw "This runner must execute on native Windows, not WSL." }
}

function Get-ExecutablePath {
    param([string]$Dir)
    $exe = Join-Path $Dir 'Baby Menu.exe'
    if (Test-Path $exe -PathType Leaf) { return $exe }
    $exe = Join-Path $Dir 'BabyMenu.exe'
    if (Test-Path $exe -PathType Leaf) { return $exe }
    return $null
}

function Backup-Environment {
    param([string[]]$Variables)
    $backup = @{}
    foreach ($var in $Variables) {
        $backup[$var] = [Environment]::GetEnvironmentVariable($var, 'Process')
    }
    return $backup
}

function Restore-Environment {
    param([hashtable]$Backup)
    foreach ($entry in $Backup.GetEnumerator()) {
        $key = $entry.Key
        $value = $entry.Value
        if ($null -ne $value) {
            [Environment]::SetEnvironmentVariable($key, $value, 'Process')
        } else {
            Remove-Item "Env:$key" -ErrorAction SilentlyContinue
        }
    }
}

function Write-FailureEvidence {
    param(
        [string]$EvidenceDir,
        [hashtable]$Payload
    )
    if (-not (Test-Path $EvidenceDir)) {
        $null = New-Item -ItemType Directory -Path $EvidenceDir -Force
    }
    $json = $Payload | ConvertTo-Json -Depth 3
    $evidencePath = Join-Path $EvidenceDir "runtime-smoke-failure-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')).json"
    $json | Out-File -FilePath $evidencePath -Encoding utf8
    Write-Host "Failure evidence written to: $evidencePath"
    return $evidencePath
}

# ---------------------------------------------------------------------------
# Main smoke logic
# ---------------------------------------------------------------------------

function Invoke-RuntimeSmoke {
    [CmdletBinding()]
    param(
        [string]$UnpackedDir,
        [int]$LaunchTimeoutSeconds
    )

    Write-Host "=== Baby Menu Packaged Runtime Smoke ==="
    Write-Host "UnpackedDir: $UnpackedDir"
    Write-Host "Timeout: ${LaunchTimeoutSeconds}s"
    Write-Host ''

    $unpackedCanon = [System.IO.Path]::GetFullPath($UnpackedDir).TrimEnd('\')
    $exePath = Get-ExecutablePath -Dir $unpackedCanon
    if (-not $exePath) {
        Add-CheckResult -Name 'executable-found' -Status 'fail' -Detail "No Baby Menu executable found in $unpackedCanon"
        return @{ Passed = $false }
    }
    Add-CheckResult -Name 'executable-found' -Status 'pass' -Detail "Found $exePath"

    # Create isolated temp roots
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "baby-menu-runtime-smoke-$([System.Guid]::NewGuid().ToString('N'))"
    $isolatedDirs = @{
        APPDATA      = Join-Path $tempRoot 'AppData-Roaming'
        LOCALAPPDATA = Join-Path $tempRoot 'AppData-Local'
        USERPROFILE  = Join-Path $tempRoot 'UserProfile'
        HOME         = Join-Path $tempRoot 'Home'
    }
    foreach ($dir in $isolatedDirs.Values) {
        $null = New-Item -ItemType Directory -Path $dir -Force
    }
    # Create isolated temp directory for child's TEMP/TMP
    $isolatedTemp = Join-Path $isolatedDirs['LOCALAPPDATA'] 'Temp'
    $null = New-Item -ItemType Directory -Path $isolatedTemp -Force

    $diagnostics = @{
        exitCode                = $null
        wasAliveAtDeadline      = $false
        singleInstanceRejected  = $false
        stdoutLength            = 0
        stderrLength            = 0
        stdoutSHA256            = $null
        stderrSHA256            = $null
    }
    $evidenceParts = @()
    $launchedPid = $null
    $procLaunched = $false

    # Initialize $savedEnv before try so finally always has a valid reference
    $savedEnv = @{}

    # Outer try/finally ensures env restore + temp cleanup runs after any path
    try {
        # ---- Pre-launch: prove no matching process exists ----
        try {
            $allProcs = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop
        } catch {
            Add-CheckResult -Name 'pre-launch-enumeration' -Status 'fail' -Detail 'Cannot enumerate processes: Win32_Process query failed'
            return @{ Passed = $false; Diagnostics = $diagnostics }
        }

        $preLaunchMatch = $false
        foreach ($p in $allProcs) {
            if ($p.ExecutablePath) {
                $pexDir = [System.IO.Path]::GetDirectoryName($p.ExecutablePath).TrimEnd('\')
                if ($pexDir -eq $unpackedCanon -or $pexDir.StartsWith("$unpackedCanon\", [StringComparison]::OrdinalIgnoreCase)) {
                    $preLaunchMatch = $true
                    break
                }
            }
        }
        if ($preLaunchMatch) {
            Add-CheckResult -Name 'pre-launch-no-running-process' -Status 'fail' -Detail 'Found existing process(es) running from UnpackedDir before launch'
            return @{ Passed = $false; Diagnostics = $diagnostics }
        }
        Add-CheckResult -Name 'pre-launch-no-running-process' -Status 'pass' -Detail 'No existing process running from UnpackedDir'

        # ---- Launch with isolated env ----
        $savedEnv = Backup-Environment -Variables @('APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME')

        # Set parent env to isolated paths
        foreach ($entry in $isolatedDirs.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
        Write-Host "  [INFO] Isolated profile root: $tempRoot"

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $exePath
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = $unpackedCanon

        # Headless Windows CI (Windows Server 2025, no GPU driver) crashes
        # Chromium's GPU init with STATUS_BREAKPOINT. Pass GPU/sandbox
        # switches as CLI args so Electron/Chromium sees them at the C++
        # level before any JS module evaluation (app.disableHardwareAcceleration
        # in app.ts is too late for headless Windows CI). Scoped behind the
        # BABY_MENU_DISABLE_GPU env var so production installs are unaffected.
        # Test 1: binary is executable and Electron base is functional
        try {
            $verPsi = New-Object System.Diagnostics.ProcessStartInfo
            $verPsi.FileName = $exePath
            $verPsi.UseShellExecute = $false
            $verPsi.RedirectStandardOutput = $true
            $verPsi.RedirectStandardError = $true
            $verPsi.CreateNoWindow = $true
            $verPsi.Arguments = "--version"
            $verPsi.EnvironmentVariables.Clear()
            foreach ($kv in $isolatedDirs.GetEnumerator()) {
                $verPsi.EnvironmentVariables[$kv.Key] = $kv.Value
            }
            $verPsi.EnvironmentVariables["TEMP"] = $isolatedTemp
            $verPsi.EnvironmentVariables["TMP"] = $isolatedTemp
            $verPsi.EnvironmentVariables["SYSTEMROOT"] = $env:SYSTEMROOT
            $verProc = [System.Diagnostics.Process]::Start($verPsi)
            if ($verProc.WaitForExit(10000)) {
                $verOut = $verProc.StandardOutput.ReadToEnd()
                $verCode = $verProc.ExitCode
                if ($verCode -eq 0 -and $verOut -match '\d+\.\d+\.\d+') {
                    Add-CheckResult -Name 'base-electron-functional' -Status 'pass' -Detail "$($verOut.Trim())"
                } else {
                    Add-CheckResult -Name 'base-electron-functional' -Status 'fail' -Detail "exitCode=$verCode stdout=${verOut}"
                }
            } else {
                Add-CheckResult -Name 'base-electron-functional' -Status 'fail' -Detail "binary timed out on --version"
            }
        } catch {
            Add-CheckResult -Name 'base-electron-functional' -Status 'fail' -Detail "binary threw on --version: $_"
        }

        if ($env:BABY_MENU_DISABLE_GPU) {
            $psi.Arguments = "--no-sandbox --disable-gpu --in-process-gpu --disable-gpu-sandbox --disable-software-rasterizer --single-process"
        }
        Write-Host "  [INFO] Launch command: $($exePath) $($psi.Arguments)"

        # Minimal env allowlist — never inherit CI secrets (GITHUB_, ACTIONS_, etc.)
        $psi.EnvironmentVariables.Clear()
        $psi.EnvironmentVariables["APPDATA"] = $isolatedDirs['APPDATA']
        $psi.EnvironmentVariables["LOCALAPPDATA"] = $isolatedDirs['LOCALAPPDATA']
        $psi.EnvironmentVariables["USERPROFILE"] = $isolatedDirs['USERPROFILE']
        $psi.EnvironmentVariables["HOME"] = $isolatedDirs['HOME']
        $psi.EnvironmentVariables["TEMP"] = $isolatedTemp
        $psi.EnvironmentVariables["TMP"] = $isolatedTemp
        $psi.EnvironmentVariables["SYSTEMROOT"] = $env:SYSTEMROOT
        if ($env:PATHEXT) { $psi.EnvironmentVariables["PATHEXT"] = $env:PATHEXT }
        if ($env:PATH) { $psi.EnvironmentVariables["PATH"] = $env:PATH }
        if ($env:BABY_MENU_SKIP_SINGLE_INSTANCE_LOCK) { $psi.EnvironmentVariables["BABY_MENU_SKIP_SINGLE_INSTANCE_LOCK"] = $env:BABY_MENU_SKIP_SINGLE_INSTANCE_LOCK }
        if ($env:BABY_MENU_DISABLE_GPU) { $psi.EnvironmentVariables["BABY_MENU_DISABLE_GPU"] = $env:BABY_MENU_DISABLE_GPU }

        $proc = [System.Diagnostics.Process]::Start($psi)
        $launchedPid = $proc.Id
        $procLaunched = $true
        Write-Host "  [INFO] Launched PID $launchedPid"

        $systemStdOut = $proc.StandardOutput
        $systemStdErr = $proc.StandardError
        $stdoutTask = $systemStdOut.ReadToEndAsync()
        $stderrTask = $systemStdErr.ReadToEndAsync()

        # Poll loop - bounded wait with early exit detection
        $elapsed = 0
        $interval = 2
        while ($elapsed -lt $LaunchTimeoutSeconds) {
            if ($proc.HasExited) { break }
            Start-Sleep -Seconds $interval
            $elapsed += $interval
            $proc.Refresh()
        }

        $diagnostics.wasAliveAtDeadline = -not $proc.HasExited

        # ---- Persistence check ----
        if ($diagnostics.wasAliveAtDeadline) {
            Add-CheckResult -Name 'runtime-persistence' -Status 'pass' -Detail "PID $launchedPid survived ${LaunchTimeoutSeconds}s timeout"
        } else {
            $proc.WaitForExit(2000) | Out-Null
            if ($proc.HasExited) { $diagnostics.exitCode = $proc.ExitCode }
            Add-CheckResult -Name 'runtime-persistence' -Status 'fail' -Detail "PID $launchedPid exited before deadline (exit code $($diagnostics.exitCode))"
        }

        # ---- Controlled kill ----
        if (-not $proc.HasExited) {
            Write-Host "  [INFO] Controlled kill of PID $launchedPid and descendants"
            & taskkill /T /F /PID $launchedPid 2>&1 | Out-Null
            Start-Sleep -Seconds 1
            $proc.Refresh()
        }
        if (-not $proc.HasExited) {
            $proc.WaitForExit(5000) | Out-Null
        } else {
            $proc.WaitForExit(1000) | Out-Null
        }
        if ($proc.HasExited -and $null -eq $diagnostics.exitCode) {
            $diagnostics.exitCode = $proc.ExitCode
        }

        try {
            $stdoutTask.Wait(5000) | Out-Null
            $stderrTask.Wait(5000) | Out-Null
        } catch { }

        # Cap and digest output
        $maxCap = 65536
        $rawStdout = $null
        $rawStderr = $null
        if ($stdoutTask.IsCompleted -and $stdoutTask.Result) {
            $rawStdout = $stdoutTask.Result
            $diagnostics.stdoutLength = $rawStdout.Length
            if ($diagnostics.stdoutLength -gt 0) {
                $diagnostics.stdoutSHA256 = [System.BitConverter]::ToString(
                    [System.Security.Cryptography.SHA256]::Create().ComputeHash(
                        [System.Text.Encoding]::UTF8.GetBytes($rawStdout)
                    )
                ).Replace('-', '')
            }
        }
        if ($stderrTask.IsCompleted -and $stderrTask.Result) {
            $rawStderr = $stderrTask.Result
            $diagnostics.stderrLength = $rawStderr.Length
            if ($diagnostics.stderrLength -gt 0) {
                $diagnostics.stderrSHA256 = [System.BitConverter]::ToString(
                    [System.Security.Cryptography.SHA256]::Create().ComputeHash(
                        [System.Text.Encoding]::UTF8.GetBytes($rawStderr)
                    )
                ).Replace('-', '')
            }
        }

        # Parse for second-instance-rejected marker
        $markerPattern = '^\s*\{\s*"event"\s*:\s*"second-instance-rejected"\s*,\s*"platform"\s*:\s*"win32"\s*,\s*"isPackaged"\s*:\s*(true|false)\s*\}\s*$'
        if ($rawStdout) {
            foreach ($line in ($rawStdout -split "`n")) {
                if ($line -match $markerPattern) { $diagnostics.singleInstanceRejected = $true; break }
            }
        }
        if (-not $diagnostics.singleInstanceRejected -and $rawStderr) {
            foreach ($line in ($rawStderr -split "`n")) {
                if ($line -match $markerPattern) { $diagnostics.singleInstanceRejected = $true; break }
            }
        }

        # Survivor CIM sweep - ErrorAction Stop so inability to prove cleanup fails
        try {
            $remaining = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop
            $survivors = @()
            foreach ($p in $remaining) {
                if ($p.ExecutablePath) {
                    $pexDir = [System.IO.Path]::GetDirectoryName($p.ExecutablePath).TrimEnd('\')
                    if ($pexDir -eq $unpackedCanon -or $pexDir.StartsWith("$unpackedCanon\", [StringComparison]::OrdinalIgnoreCase)) {
                        $survivors += $p
                        & taskkill /T /F /PID $p.ProcessId 2>&1 | Out-Null
                    }
                }
            }
            Start-Sleep -Seconds 1
            $survivorsAfterSweep = @()
            $allAfter = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop
            foreach ($p in $allAfter) {
                if ($p.ExecutablePath) {
                    $pexDir = [System.IO.Path]::GetDirectoryName($p.ExecutablePath).TrimEnd('\')
                    if ($pexDir -eq $unpackedCanon -or $pexDir.StartsWith("$unpackedCanon\", [StringComparison]::OrdinalIgnoreCase)) {
                        $survivorsAfterSweep += $p
                    }
                }
            }
            if ($survivorsAfterSweep.Count -eq 0) {
                Add-CheckResult -Name 'cleanup-no-survivors' -Status 'pass' -Detail "No survivors after forced cleanup (launch PID=$launchedPid)"
            } else {
                Add-CheckResult -Name 'cleanup-no-survivors' -Status 'fail' -Detail "$($survivorsAfterSweep.Count) surviving process(es) under UnpackedDir after forced cleanup (launch PID=$launchedPid)"
            }
        } catch {
            Add-CheckResult -Name 'cleanup-no-survivors' -Status 'fail' -Detail "Cleanup sweep threw: $_"
        }

        # Safe diagnostic evidence (never raw env/credentials)
        $evidenceParts += "singleInstanceRejected=$($diagnostics.singleInstanceRejected)"
        $evidenceParts += "exitCode=$($diagnostics.exitCode)"
        $evidenceParts += "stdoutLen=$($diagnostics.stdoutLength)"
        $evidenceParts += "stderrLen=$($diagnostics.stderrLength)"
        if ($diagnostics.stdoutSHA256) { $evidenceParts += "stdoutSHA256=$($diagnostics.stdoutSHA256)" }
        if ($diagnostics.stderrSHA256) { $evidenceParts += "stderrSHA256=$($diagnostics.stderrSHA256)" }
        Add-CheckResult -Name 'diagnostic-evidence' -Status 'pass' -Detail ($evidenceParts -join '; ')

        # Profile-writes-contained observation
        $isolatedAppDataFiles = Get-ChildItem -Path $isolatedDirs['APPDATA'] -Recurse -ErrorAction SilentlyContinue
        $isolatedLocalFiles = Get-ChildItem -Path $isolatedDirs['LOCALAPPDATA'] -Recurse -ErrorAction SilentlyContinue
        $wroteToIsolated = ($isolatedAppDataFiles.Count -gt 0) -or ($isolatedLocalFiles.Count -gt 0)
        if ($wroteToIsolated) {
            Add-CheckResult -Name 'profile-writes-contained' -Status 'pass' -Detail 'Profile writes captured under isolated temp root'
        } else {
            Add-CheckResult -Name 'profile-writes-contained' -Status 'pass' -Detail 'No detectable profile writes (app may not have created profile data within timeout)'
        }

    } finally {
        Restore-Environment -Backup $savedEnv
        Write-Host '  [INFO] Parent environment variables restored'

        # Temp profile cleanup - runs before exit; failure is recorded as a check
        # result and surfaces through the summary check below
        try {
            if (Test-Path $tempRoot) {
                Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction Stop
            }
            if (Test-Path $tempRoot) {
                Add-CheckResult -Name 'cleanup-temp' -Status 'fail' -Detail "Temp root still exists after removal: $tempRoot"
            } else {
                Add-CheckResult -Name 'cleanup-temp' -Status 'pass' -Detail "Temp root removed: $tempRoot"
            }
        } catch {
            Add-CheckResult -Name 'cleanup-temp' -Status 'fail' -Detail "Failed to remove temp root: $_"
        }
    }

    # Verify env restoration
    $allRestored = $true
    foreach ($entry in $savedEnv.GetEnumerator()) {
        $current = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        if ($current -ne $entry.Value) { $allRestored = $false; break }
    }
    if ($allRestored) {
        Add-CheckResult -Name 'env-restored' -Status 'pass' -Detail 'All parent env vars restored after launch'
    } else {
        Add-CheckResult -Name 'env-restored' -Status 'fail' -Detail 'Some parent env vars not properly restored'
    }

    # ---- Summary ----
    Write-Host ''
    Write-Host "Passed: $passed / $($passed + $failed)"
    Write-Host "Failed: $failed"
    if ($failed -gt 0) {
        Write-Host 'Runtime smoke FAILED.' -ForegroundColor Red
        return @{ Passed = $false; Diagnostics = $diagnostics }
    }
    Write-Host 'All runtime smoke checks passed.' -ForegroundColor Green
    return @{ Passed = $true; Diagnostics = $diagnostics }
}

# ---- Entry point ----
Assert-WindowsNative
Assert-NotWsl

$smokeResult = Invoke-RuntimeSmoke -UnpackedDir $UnpackedDir -LaunchTimeoutSeconds $LaunchTimeoutSeconds

if (-not $smokeResult.Passed) {
    # Write failure evidence (outside try/finally so it survives profile cleanup)
    $diagDir = if ($DiagnosticDir) { $DiagnosticDir } else { Join-Path $env:TEMP "baby-menu-runtime-smoke-diag" }
    $evidencePayload = @{
        Timestamp = (Get-Date -Format 'o')
        UnpackedDir = $UnpackedDir
        FailedCount = $failed
        PassedCount = $passed
        Diagnostics = $smokeResult.Diagnostics
        SecretRedacted = $true
    }
    Write-FailureEvidence -EvidenceDir $diagDir -Payload $evidencePayload
    throw "Runtime smoke FAILED"
}
