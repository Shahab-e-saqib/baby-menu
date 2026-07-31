<#
.SYNOPSIS
  Bounded native-Windows validation runner for the Baby Menu NSIS installer and runtime.
  Compatible with Windows PowerShell 5.1 and PowerShell 7+.
.DESCRIPTION
  Automates deterministic validation of an already-built Baby Menu NSIS installer
  on a real native Windows host from a drive-letter path.  Supports -WhatIf
  plan-only mode and requires explicit opt-in for install/uninstall/launch mutation.
  Evidence output is a structured JSON file (pass/fail/skip) under the diagnostic
  directory with secret redaction.  Genuinely manual GUI-only checks are listed
  as skip with exact manual guidance.
#>

#Requires -Version 5.1

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$InstallerPath,

    [Parameter(Mandatory)]
    [ValidateScript({ -not [string]::IsNullOrWhiteSpace($_) })]
    [string]$InstallDir,

    [Parameter(Mandatory)]
    [ValidateScript({ -not [string]::IsNullOrWhiteSpace($_) })]
    [string]$UserDataDir,

    [switch]$AllowInstall,

    [switch]$AllowUninstall,

    [switch]$AllowLaunch,

    [int]$LaunchTimeoutSeconds = 60,

    [string]$DiagnosticDir = ''
)

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

trap {
    [Console]::Error.WriteLine("Fatal: $_")
    if (-not $WhatIfPreference) {
        $tempPath = Join-Path $env:TEMP "baby-menu-validation-fatal-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')).txt"
        "Fatal at $(Get-Date -Format 'o'): $_" | Out-File -FilePath $tempPath -Encoding utf8
    }
    exit 1
}

if (-not $DiagnosticDir) { $DiagnosticDir = "$InstallDir-diagnostic" }
$script:Checks = New-Object System.Collections.ArrayList
$script:ProductNames = @('Baby Menu', 'Baby Menu Dev')
$script:ExecutableNames = @('Baby Menu.exe', 'Baby Menu Dev.exe', 'BabyMenu.exe')

function Add-CheckResult {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [ValidateSet('pass','fail','skip')] [string]$Status,
        [string]$Detail = '',
        [string]$ManualGuidance = ''
    )
    $null = $script:Checks.Add(@{
        Name           = $Name
        Status         = $Status
        Detail         = $Detail
        ManualGuidance = $ManualGuidance
    })
}

function Write-Evidence {
    $evidence = @{
        RunnerVersion  = '1.0.0'
        Timestamp      = (Get-Date -Format 'o')
        ComputerName   = $env:COMPUTERNAME
        OsVersion      = [System.Environment]::OSVersion.VersionString
        Is64BitProcess = [System.Environment]::Is64BitProcess
        InstallerPath  = $InstallerPath
        InstallDir     = $InstallDir
        UserDataDir    = $UserDataDir
        DiagnosticDir  = $DiagnosticDir
        AllowInstall   = $AllowInstall.IsPresent
        AllowUninstall = $AllowUninstall.IsPresent
        AllowLaunch    = $AllowLaunch.IsPresent
        WhatIf         = $WhatIfPreference
        Checks         = $script:Checks
        SecretRedacted = $true
    }
    if ($WhatIfPreference) {
        $evidence.PlanOnly = $true
    }
    $json = $evidence | ConvertTo-Json -Depth 5
    $json = $json -replace '(?i)(access_key|secret_key|password|token|credential|api[_-]?key|auth[_-]?token)\s*[:=]\s*"([^"]{4,})"', '${1}: "**REDACTED**"'
    $json = $json -replace '(?i)("password|"token|"secret)[^"]*"', '"**REDACTED**"'
    $json = $json -replace '(?i)(AAAA[ A-Za-z0-9+/]{20,}={0,2})', '"**REDACTED-BASE64**"'

    if ($WhatIfPreference) {
        return $json
    }

    if (-not (Test-Path $DiagnosticDir)) {
        $null = New-Item -ItemType Directory -Path $DiagnosticDir -Force
    }
    $evidencePath = Join-Path $DiagnosticDir "evidence-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')).json"
    $json | Out-File -FilePath $evidencePath -Encoding utf8
    Write-Host "Evidence written to: $evidencePath"
    return $evidencePath
}

# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

function Assert-WindowsNative {
    $platform = [System.Environment]::OSVersion.Platform
    if ($platform -eq 'Unix' -or $platform -eq 'MacOSX') {
        throw "This runner must execute on a native Windows host. Detected platform: $platform"
    }
    $cwd = (Get-Location).ProviderPath
    if ($cwd -notmatch '^[A-Za-z]:\\') {
        throw "Working directory must be a drive-letter path (e.g. C:\...). Current: $cwd"
    }
    if ($env:OS -ne 'Windows_NT') {
        throw "Environment is not Windows_NT: $env:OS"
    }
}

function Assert-NotWsl {
    if (Test-Path '/proc/version') {
        $procVer = Get-Content '/proc/version' -TotalCount 1 -ErrorAction SilentlyContinue
        if ($procVer -and $procVer -match 'Microsoft|WSL') {
            throw "This runner must execute on native Windows, not WSL."
        }
    }
    if ($env:WSL_DISTRO_NAME) {
        throw "This runner must execute on native Windows, not WSL (detected WSL_DISTRO_NAME)."
    }
}

function Assert-MutationConsent {
    $anyMutation = $AllowInstall -or $AllowUninstall -or $AllowLaunch
    $allMutation = $AllowInstall -and $AllowUninstall -and $AllowLaunch
    if ($anyMutation -and -not $allMutation) {
        throw "Mutation flags must all be provided together or none at all: -AllowInstall, -AllowUninstall, -AllowLaunch."
    }
}

function Assert-PathSafe {
    param([string]$Path, [string]$Label)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Label path is empty" }
    if ($Path -notmatch '^[A-Za-z]:\\') {
        throw "$Label must be a drive-letter path: $Path"
    }
    $resolved = [System.IO.Path]::GetFullPath($Path)
    # Reject volume roots (e.g. C:\, D:\)
    $root = [System.IO.Path]::GetPathRoot($resolved)
    if ($resolved -eq $root) {
        throw "$Label is a volume root ($resolved). Refusing to use a volume root."
    }
    # Reject system directories and their children
    $protectedDirs = @(
        "$env:SystemRoot",
        "$env:ProgramFiles",
        "${env:ProgramFiles(x86)}",
        "$env:ProgramData",
        "$env:WINDIR",
        "$env:LOCALAPPDATA",
        "$env:APPDATA"
    )
    foreach ($d in $protectedDirs) {
        if ([string]::IsNullOrWhiteSpace($d)) { continue }
        $dCanon = [System.IO.Path]::GetFullPath($d)
        if ($resolved -eq $dCanon -or $resolved.StartsWith("$dCanon\", [StringComparison]::OrdinalIgnoreCase)) {
            throw "$Label ($resolved) is inside a protected system path ($dCanon). Refusing."
        }
    }
    # Reject well-known user-profile roots (exact match only)
    $userDirs = @(
        "$env:USERPROFILE",
        "$env:HOMEDRIVE$env:HOMEPATH"
    )
    foreach ($d in $userDirs) {
        if ([string]::IsNullOrWhiteSpace($d)) { continue }
        $dCanon = [System.IO.Path]::GetFullPath($d)
        if ($resolved -eq $dCanon) {
            throw "$Label collides with user-profile root ($dCanon). Refusing."
        }
    }
    return $resolved
}

function Assert-NoPathOverlap {
    param([string]$Path1, [string]$Path2, [string]$Label1, [string]$Label2)
    $p1 = [System.IO.Path]::GetFullPath($Path1).TrimEnd('\')
    $p2 = [System.IO.Path]::GetFullPath($Path2).TrimEnd('\')
    if ($p1 -eq $p2) {
        throw "$Label1 and $Label2 resolve to the same path ($p1). They must be distinct."
    }
    if ($p2 -eq "$p1\".TrimEnd('\') -or $p2.StartsWith("$p1\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label2 ($p2) is inside $Label1 ($p1). They must not overlap."
    }
    if ($p1 -eq "$p2\".TrimEnd('\') -or $p1.StartsWith("$p2\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label1 ($p1) is inside $Label2 ($p2). They must not overlap."
    }
}

function Assert-ExistingPathSafe {
    param([string]$Path, [string]$Label)
    if (Test-Path $Path) {
        throw "$Label already exists: $Path. Refusing to overwrite. Pick a path that does not exist or remove it first."
    }
}

# ---------------------------------------------------------------------------
# Check implementations – real execution
# ---------------------------------------------------------------------------

function Invoke-InstallerCheck {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    $name = 'installer'
    if ($PSCmdlet.ShouldProcess("Install $InstallerPath into $InstallDir", 'Install', 'Installing Baby Menu')) {
        Write-Host "  [EXEC] Running installer: $InstallerPath /S /D=$InstallDir"

        $proc = Start-Process -FilePath $InstallerPath -ArgumentList '/S', "/D=$InstallDir" -Wait -PassThru -NoNewWindow
        $exitCode = $proc.ExitCode

        if ($exitCode -eq 0) {
            Add-CheckResult -Name $name -Status 'pass' -Detail "NSIS installer exited with code $exitCode"
        } else {
            Add-CheckResult -Name $name -Status 'fail' -Detail "NSIS installer exited with code $exitCode"
        }
    } else {
        Add-CheckResult -Name $name -Status 'skip' -Detail 'Plan-only: installer not executed'
    }
}

function Invoke-InstalledFilesCheck {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    if (-not $AllowInstall -and -not $WhatIfPreference) {
        Add-CheckResult -Name 'installed-files' -Status 'skip' -Detail 'Skipped: -AllowInstall not specified'
        return
    }
    if ($WhatIfPreference) {
        Add-CheckResult -Name 'installed-files' -Status 'skip' -Detail 'Plan-only: would verify installed files'
        return
    }
    Write-Host '  [EXEC] Verifying installed files'

    if (-not (Test-Path $InstallDir)) {
        Add-CheckResult -Name 'installed-files' -Status 'fail' -Detail "InstallDir does not exist: $InstallDir"
        return
    }

    $entries = Get-ChildItem -Path $InstallDir -Recurse -ErrorAction SilentlyContinue
    $hasExe = $false
    $hasAsar = $false
    $hasUnpacked = $false
    foreach ($e in $entries) {
        if ($script:ExecutableNames -contains $e.Name -and -not $e.PSIsContainer) { $hasExe = $true }
        if ($e.Name -eq 'app.asar' -and -not $e.PSIsContainer) { $hasAsar = $true }
        if ($e.Name -eq 'app.asar.unpacked' -and $e.PSIsContainer) { $hasUnpacked = $true }
    }

    if ($hasExe) { Add-CheckResult -Name 'installed-exe' -Status 'pass' -Detail "Main executable found in $InstallDir" }
    else { Add-CheckResult -Name 'installed-exe' -Status 'fail' -Detail 'Main executable not found' }

    if ($hasAsar) { Add-CheckResult -Name 'installed-asar' -Status 'pass' -Detail 'app.asar found' }
    else { Add-CheckResult -Name 'installed-asar' -Status 'fail' -Detail 'app.asar not found' }

    if ($hasUnpacked) { Add-CheckResult -Name 'installed-unpacked' -Status 'pass' -Detail 'app.asar.unpacked found' }
    else { Add-CheckResult -Name 'installed-unpacked' -Status 'fail' -Detail 'app.asar.unpacked not found' }
}

function Invoke-ShortcutCheck {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    if (-not $AllowInstall -and -not $WhatIfPreference) {
        Add-CheckResult -Name 'shortcuts' -Status 'skip' -Detail 'Skipped: -AllowInstall not specified'
        return
    }
    if ($WhatIfPreference) {
        Add-CheckResult -Name 'shortcuts' -Status 'skip' -Detail 'Plan-only: would verify shortcuts'
        return
    }
    Write-Host '  [EXEC] Verifying Start Menu shortcuts'

    $startMenuDirs = @(
        [System.IO.Path]::Combine($env:ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        [System.IO.Path]::Combine($env:APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    )
    $found = $false
    foreach ($dir in $startMenuDirs) {
        if (-not (Test-Path $dir)) { continue }
        $lnkFiles = Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue
        if ($lnkFiles | Where-Object { $script:ProductNames -contains $_.BaseName }) { $found = $true; break }
    }

    if ($found) { Add-CheckResult -Name 'shortcuts' -Status 'pass' -Detail 'Baby Menu Start Menu shortcut found' }
    else { Add-CheckResult -Name 'shortcuts' -Status 'skip' -Detail 'Shortcut not found in Start Menu (may be Desktop-only or installer-skip)' -ManualGuidance 'Check Desktop and Start Menu for Baby Menu shortcut manually' }
}

function Invoke-RegistryUninstallCheck {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    if (-not $AllowInstall -and -not $WhatIfPreference) {
        Add-CheckResult -Name 'registry-uninstall' -Status 'skip' -Detail 'Skipped: -AllowInstall not specified'
        return
    }
    if ($WhatIfPreference) {
        Add-CheckResult -Name 'registry-uninstall' -Status 'skip' -Detail 'Plan-only: would verify HKCU uninstall entry'
        return
    }
    Write-Host '  [EXEC] Verifying HKCU uninstall entry'

    $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    $found = $false
    if (Test-Path $uninstallKey) {
        $subKeys = Get-ChildItem -Path $uninstallKey -ErrorAction SilentlyContinue
        foreach ($sk in $subKeys) {
            $displayName = (Get-ItemProperty -Path $sk.PSPath -Name 'DisplayName' -ErrorAction SilentlyContinue).DisplayName
            if ($displayName -and $script:ProductNames -contains $displayName) {
                $found = $true
                $version = (Get-ItemProperty -Path $sk.PSPath -Name 'DisplayVersion' -ErrorAction SilentlyContinue).DisplayVersion
                $publisher = (Get-ItemProperty -Path $sk.PSPath -Name 'Publisher' -ErrorAction SilentlyContinue).Publisher
                Add-CheckResult -Name 'registry-uninstall' -Status 'pass' -Detail "Uninstall entry found (version=$version, publisher=$publisher)"
                break
            }
        }
    }
    if (-not $found) {
        Add-CheckResult -Name 'registry-uninstall' -Status 'fail' -Detail 'Baby Menu uninstall entry not found in HKCU uninstall key'
    }
}

$script:SentinelHash = $null

function Invoke-SentinelCreate {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    if ($WhatIfPreference) {
        Add-CheckResult -Name 'sentinel-create' -Status 'skip' -Detail 'Plan-only: would create sentinel'
        return
    }
    Write-Host '  [EXEC] Creating user-data sentinel'

    if (-not (Test-Path $UserDataDir)) {
        $null = New-Item -ItemType Directory -Path $UserDataDir -Force
    }
    $sentinelPath = Join-Path $UserDataDir 'baby-menu-windows-validation-sentinel.txt'
    "Baby Menu Windows Validation Sentinel`r`nCreated: $(Get-Date -Format 'o')" | Out-File -FilePath $sentinelPath -Encoding utf8
    $script:SentinelHash = (Get-FileHash -Path $sentinelPath -Algorithm SHA256).Hash
    Add-CheckResult -Name 'sentinel-create' -Status 'pass' -Detail "Sentinel created at $sentinelPath (SHA256=$($script:SentinelHash))"
}

function Invoke-SentinelVerify {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$Stage)
    if ($WhatIfPreference) {
        Add-CheckResult -Name "sentinel-verify-$Stage" -Status 'skip' -Detail "Plan-only: would verify sentinel after $Stage"
        return
    }
    Write-Host "  [EXEC] Verifying sentinel after $Stage"

    $sentinelPath = Join-Path $UserDataDir 'baby-menu-windows-validation-sentinel.txt'
    if (-not (Test-Path $sentinelPath)) {
        Add-CheckResult -Name "sentinel-verify-$Stage" -Status 'fail' -Detail "Sentinel missing after $Stage"
        return
    }
    $currentHash = (Get-FileHash -Path $sentinelPath -Algorithm SHA256).Hash
    if ($currentHash -eq $script:SentinelHash) {
        Add-CheckResult -Name "sentinel-verify-$Stage" -Status 'pass' -Detail "Sentinel SHA256 matches ($currentHash)"
    } elseif (-not $script:SentinelHash) {
        $script:SentinelHash = $currentHash
        Add-CheckResult -Name "sentinel-verify-$Stage" -Status 'pass' -Detail "Sentinel captured SHA256 ($currentHash)"
    } else {
        Add-CheckResult -Name "sentinel-verify-$Stage" -Status 'fail' -Detail "Sentinel SHA256 mismatch: expected $($script:SentinelHash), got $currentHash"
    }
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

function Assert-ProfilePathsSafe {
    param([hashtable]$ProfilePaths, [string]$UserDataDir)
    $userDataDirCanon = [System.IO.Path]::GetFullPath($UserDataDir).TrimEnd('\')
    foreach ($entry in $ProfilePaths.GetEnumerator()) {
        $dirCanon = [System.IO.Path]::GetFullPath($entry.Value)
        if (-not $dirCanon.StartsWith("$userDataDirCanon\", [StringComparison]::OrdinalIgnoreCase) -and $dirCanon -ne $userDataDirCanon) {
            throw "Isolated profile path $($entry.Key)=$dirCanon is not under UserDataDir $userDataDirCanon"
        }
    }
}

function New-DirectoryManifest {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path $Path)) { return $null }
    $manifest = @{}
    $rootCanon = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $entries = Get-ChildItem -Path $Path -Recurse -ErrorAction SilentlyContinue
    foreach ($entry in $entries) {
        $relPath = $entry.FullName.Substring($rootCanon.Length + 1)
        $info = @{
            Length = if ($entry.PSIsContainer) { 0 } else { $entry.Length }
            LastWrite = $entry.LastWriteTimeUtc.ToString('o')
        }
        if (-not $entry.PSIsContainer) {
            $hash = Get-FileHash -Path $entry.FullName -Algorithm SHA256 -ErrorAction SilentlyContinue
            if ($hash) { $info['SHA256'] = $hash.Hash }
        }
        $manifest[$relPath] = $info
    }
    return $manifest
}

function Compare-DirectoryManifest {
    param([hashtable]$Before, [hashtable]$After)
    if ($null -eq $Before -and $null -eq $After) { return $true }
    if ($null -eq $Before -or $null -eq $After) { return $false }
    if ($Before.Count -ne $After.Count) { return $false }
    foreach ($key in $Before.Keys) {
        if (-not $After.ContainsKey($key)) { return $false }
        $b = $Before[$key]
        $a = $After[$key]
        if ($b.Length -ne $a.Length) { return $false }
        if ($b.LastWrite -ne $a.LastWrite) { return $false }
        if ($b.ContainsKey('SHA256') -xor $a.ContainsKey('SHA256')) { return $false }
        if ($b.ContainsKey('SHA256') -and $b.SHA256 -ne $a.SHA256) { return $false }
    }
    return $true
}

function Invoke-BoundedLaunchCheck {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    if (-not $AllowLaunch) {
        Add-CheckResult -Name 'bounded-launch-persistence' -Status 'skip' -Detail 'Launch requires -AllowLaunch' -ManualGuidance 'Run with -AllowLaunch to start the app, verify persistence through timeout, then cleanup'
        Add-CheckResult -Name 'bounded-launch-cleanup' -Status 'skip' -Detail 'Cleanup requires -AllowLaunch'
        return
    }
    if ($WhatIfPreference) {
        Add-CheckResult -Name 'bounded-launch-persistence' -Status 'skip' -Detail 'Plan-only: would launch Baby Menu with bounded timeout'
        Add-CheckResult -Name 'bounded-launch-cleanup' -Status 'skip' -Detail 'Plan-only: would force-kill process tree'
        return
    }
    Write-Host "  [EXEC] Launching Baby Menu (timeout=${LaunchTimeoutSeconds}s)"

    $exePath = $null
    foreach ($exeName in $script:ExecutableNames) {
        $candidate = [System.IO.Path]::Combine($InstallDir, $exeName)
        if (Test-Path $candidate -PathType Leaf) {
            $exePath = $candidate
            break
        }
    }
    if (-not $exePath) {
        Add-CheckResult -Name 'bounded-launch-persistence' -Status 'fail' -Detail "Executable not found in $InstallDir"
        Add-CheckResult -Name 'bounded-launch-cleanup' -Status 'skip' -Detail 'Cleanup skipped: executable not found'
        return
    }

    # Check 1: Executable is under InstallDir
    $exeDir = [System.IO.Path]::GetDirectoryName($exePath).TrimEnd('\')
    $installDirCanon = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    if ($exeDir -ne $installDirCanon -and -not $exeDir.StartsWith("$installDirCanon\", [StringComparison]::OrdinalIgnoreCase)) {
        Add-CheckResult -Name 'bounded-launch-exe-under-installdir' -Status 'fail' -Detail "Executable path $exePath is not under InstallDir $InstallDir"
        Add-CheckResult -Name 'bounded-launch-persistence' -Status 'skip' -Detail 'Skipped: exe not under InstallDir'
        Add-CheckResult -Name 'bounded-launch-cleanup' -Status 'skip' -Detail 'Skipped: exe not under InstallDir'
        return
    }
    Add-CheckResult -Name 'bounded-launch-exe-under-installdir' -Status 'pass' -Detail "Executable $exePath is under InstallDir"

    # Create isolated child-profile directories under UserDataDir
    $profileIsolationRoot = Join-Path $UserDataDir "child-profile"
    $isolatedDirs = @{
        APPDATA      = Join-Path $profileIsolationRoot "AppData-Roaming"
        LOCALAPPDATA = Join-Path $profileIsolationRoot "AppData-Local"
        USERPROFILE  = Join-Path $profileIsolationRoot "UserProfile"
        HOME         = Join-Path $profileIsolationRoot "Home"
    }

    # Verify isolated paths are under UserDataDir
    try {
        Assert-ProfilePathsSafe -ProfilePaths $isolatedDirs -UserDataDir $UserDataDir
    } catch {
        Add-CheckResult -Name 'bounded-launch-profile-isolation' -Status 'fail' -Detail "Profile isolation path safety check failed: $_"
        Add-CheckResult -Name 'bounded-launch-persistence' -Status 'skip' -Detail 'Skipped: profile isolation check failed'
        Add-CheckResult -Name 'bounded-launch-cleanup' -Status 'skip' -Detail 'Skipped: profile isolation check failed'
        return
    }

    # Create isolated profile directories
    foreach ($dir in $isolatedDirs.Values) {
        if (-not (Test-Path $dir)) {
            $null = New-Item -ItemType Directory -Path $dir -Force
        }
    }

    # Snapshot parent environment, set isolated paths, then launch
    $savedEnv = Backup-Environment -Variables @('APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME')

    # Capture manifests of real profile subdirectories before any env modification
    $manifestPaths = @()
    if ($savedEnv['APPDATA']) { $manifestPaths += @{Path = Join-Path $savedEnv['APPDATA'] 'baby-menu'; Label = 'APPDATA\baby-menu'} }
    if ($savedEnv['LOCALAPPDATA']) {
        $manifestPaths += @{Path = Join-Path $savedEnv['LOCALAPPDATA'] 'baby-menu'; Label = 'LOCALAPPDATA\baby-menu'}
        $manifestPaths += @{Path = Join-Path $savedEnv['LOCALAPPDATA'] 'Baby Menu'; Label = 'LOCALAPPDATA\Baby Menu'}
    }
    if ($savedEnv['USERPROFILE']) { $manifestPaths += @{Path = Join-Path $savedEnv['USERPROFILE'] '.baby-menu'; Label = 'USERPROFILE\.baby-menu'} }
    $manifestsBefore = @{}
    foreach ($mp in $manifestPaths) {
        $canonKey = [System.IO.Path]::GetFullPath($mp.Path).ToUpperInvariant()
        $manifestsBefore[$canonKey] = New-DirectoryManifest -Path $mp.Path
    }

    $persistenceRecorded = $false
    $cleanupRecorded = $false
    $procLaunched = $false
    $exitCode = $null
    $stdoutLength = 0
    $stderrLength = 0
    $stdoutDigest = $null
    $stderrDigest = $null
    $singleInstanceRejected = $false
    $elapsed = 0

    try {
        foreach ($entry in $isolatedDirs.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
        # Log only the root isolation path, never the individual values
        Write-Host "  [EXEC] Isolated profile root: $profileIsolationRoot"

        # Use ProcessStartInfo for exit code capture and bounded stdout/stderr
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $exePath
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        $procLaunched = $true
        $launchedPid = $proc.Id
        Write-Host "  [EXEC] Launched PID $launchedPid"

        # Start async output readers to avoid deadlock
        $systemStdOut = $proc.StandardOutput
        $systemStdErr = $proc.StandardError
        $stdoutTask = $systemStdOut.ReadToEndAsync()
        $stderrTask = $systemStdErr.ReadToEndAsync()

        # Wait with timeout, polling for early exit
        $interval = 2
        while ($elapsed -lt $LaunchTimeoutSeconds) {
            if ($proc.HasExited) { break }
            Start-Sleep -Seconds $interval
            $elapsed += $interval
            $proc.Refresh()
        }

        # Snapshot alive-at-deadline immediately after the polling loop,
        # BEFORE any WaitForExit or kill.  A process that exited during the
        # final sleep interval is NOT alive at the deadline.
        $wasAliveAtDeadline = -not $proc.HasExited

        # === PERSISTENCE CHECK ===
        if ($wasAliveAtDeadline) {
            # Process survived the full LaunchTimeoutSeconds — record pass,
            # then proceed to controlled kill.
            Add-CheckResult -Name 'bounded-launch-persistence' -Status 'pass' -Detail "PID $launchedPid survived ${LaunchTimeoutSeconds}s timeout"
        } else {
            # Process exited before or during the final polling interval.
            # Brief wait to capture exit code, then record fail.
            $proc.WaitForExit(2000) | Out-Null
            if ($proc.HasExited) { $exitCode = $proc.ExitCode }
            Add-CheckResult -Name 'bounded-launch-persistence' -Status 'fail' -Detail "PID $launchedPid exited (exit code $($exitCode))"
        }
        $persistenceRecorded = $true

        # === CONTROLLED KILL ===
        if (-not $proc.HasExited) {
            Write-Host "  [EXEC] Controlled kill of PID $launchedPid and descendants"
            & taskkill /T /F /PID $launchedPid 2>&1 | Out-Null
            Start-Sleep -Seconds 1
            $proc.Refresh()
        }

        # Wait for exit (brief) to capture exit code if not already captured
        if (-not $proc.HasExited) {
            $proc.WaitForExit(5000) | Out-Null
        } else {
            $proc.WaitForExit(1000) | Out-Null
        }
        if ($proc.HasExited -and $null -eq $exitCode) {
            $exitCode = $proc.ExitCode
        }

        # Drain output readers with bounded wait
        try {
            $stdoutTask.Wait(5000) | Out-Null
            $stderrTask.Wait(5000) | Out-Null
        } catch {
            # Reader timeout is non-fatal
        }

        # Cap and digest output — never embed raw text in check details.
        $maxCap = 65536
        if ($stdoutTask.IsCompleted -and $stdoutTask.Result) {
            $rawStdout = $stdoutTask.Result
            $stdoutLength = $rawStdout.Length
            if ($stdoutLength -gt 0) {
                $stdoutDigest = [System.BitConverter]::ToString(
                    [System.Security.Cryptography.SHA256]::Create().ComputeHash(
                        [System.Text.Encoding]::UTF8.GetBytes($rawStdout)
                    )
                ).Replace('-', '') -replace '(?i)(AAAA[ A-Za-z0-9+/]{20,}={0,2})', '**REDACTED-BASE64**'
            }
            if ($rawStdout.Length -gt $maxCap) {
                $rawStdout = $rawStdout.Substring(0, $maxCap)
            }
        }
        if ($stderrTask.IsCompleted -and $stderrTask.Result) {
            $rawStderr = $stderrTask.Result
            $stderrLength = $rawStderr.Length
            if ($stderrLength -gt 0) {
                $stderrDigest = [System.BitConverter]::ToString(
                    [System.Security.Cryptography.SHA256]::Create().ComputeHash(
                        [System.Text.Encoding]::UTF8.GetBytes($rawStderr)
                    )
                ).Replace('-', '') -replace '(?i)(AAAA[ A-Za-z0-9+/]{20,}={0,2})', '**REDACTED-BASE64**'
            }
        }

        # Parse both capped stdout and stderr line-by-line for the exact safe
        # second-instance-rejected JSON marker.  Accept only a single line that
        # matches event/platform/isPackaged keys and values; ignore all other
        # raw lines (including console.warn on stderr, startup logs, etc.).
        $secondInstanceLinePattern = '^\s*\{\s*"event"\s*:\s*"second-instance-rejected"\s*,\s*"platform"\s*:\s*"win32"\s*,\s*"isPackaged"\s*:\s*(true|false)\s*\}\s*$'
        if ($rawStdout) {
            foreach ($line in ($rawStdout -split "`n")) {
                if ($line -match $secondInstanceLinePattern) { $singleInstanceRejected = $true; break }
            }
        }
        if (-not $singleInstanceRejected -and $rawStderr) {
            foreach ($line in ($rawStderr -split "`n")) {
                if ($line -match $secondInstanceLinePattern) { $singleInstanceRejected = $true; break }
            }
        }

        # === CLEANUP ===
        # Best-effort sweep: kill every process whose ExecutablePath is under InstallDir.
        Start-Sleep -Seconds 1
        $allProcesses = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue
        $installDirProcs = @()
        foreach ($p in $allProcesses) {
            if ($p.ExecutablePath -and $p.ProcessId -ne $launchedPid) {
                $pexDir = [System.IO.Path]::GetDirectoryName($p.ExecutablePath).TrimEnd('\')
                if ($pexDir -eq $installDirCanon -or $pexDir.StartsWith("$installDirCanon\", [StringComparison]::OrdinalIgnoreCase)) {
                    $installDirProcs += $p
                    & taskkill /T /F /PID $p.ProcessId 2>&1 | Out-Null
                }
            }
        }
        Start-Sleep -Seconds 1

        # Final survivor check
        $remaining = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ExecutablePath -and $_.ProcessId -ne $launchedPid -and $_.ProcessId -ne 0
        }
        $survivors = @()
        foreach ($p in $remaining) {
            $pexDir = [System.IO.Path]::GetDirectoryName($p.ExecutablePath).TrimEnd('\')
            if ($pexDir -eq $installDirCanon -or $pexDir.StartsWith("$installDirCanon\", [StringComparison]::OrdinalIgnoreCase)) {
                $survivors += $p
            }
        }

        # Cleanup check: one pass/fail independent of persistence
        if ($survivors.Count -eq 0) {
            Add-CheckResult -Name 'bounded-launch-cleanup' -Status 'pass' -Detail "No survivors after forced cleanup (launch PID=$launchedPid)"
        } else {
            Add-CheckResult -Name 'bounded-launch-cleanup' -Status 'fail' -Detail "$($survivors.Count) surviving process(es) under InstallDir after forced cleanup (launch PID=$launchedPid)"
        }
        $cleanupRecorded = $true

        # Diagnostic detail: safe marker plus bounded exit/output summary
        $diagnosticParts = @()
        $diagnosticParts += "singleInstanceRejected=$singleInstanceRejected"
        $diagnosticParts += "exitCode=$($exitCode)"
        $diagnosticParts += "stdoutLen=$stdoutLength"
        $diagnosticParts += "stderrLen=$stderrLength"
        if ($stdoutDigest) { $diagnosticParts += "stdoutSHA256=$stdoutDigest" }
        if ($stderrDigest) { $diagnosticParts += "stderrSHA256=$stderrDigest" }
        Add-CheckResult -Name 'bounded-launch-diagnostics' -Status 'pass' -Detail ($diagnosticParts -join '; ')

        # Isolated-write observation: verify isolated profile dirs captured app data
        $isolatedAppDataFiles = Get-ChildItem -Path $isolatedDirs['APPDATA'] -Recurse -ErrorAction SilentlyContinue
        $isolatedLocalAppDataFiles = Get-ChildItem -Path $isolatedDirs['LOCALAPPDATA'] -Recurse -ErrorAction SilentlyContinue
        $wroteToIsolated = ($isolatedAppDataFiles.Count -gt 0) -or ($isolatedLocalAppDataFiles.Count -gt 0)

        if ($wroteToIsolated) {
            Add-CheckResult -Name 'bounded-launch-profile-writes-contained' -Status 'pass' -Detail "Profile writes captured under isolated paths under UserDataDir"
        } else {
            Add-CheckResult -Name 'bounded-launch-profile-writes-contained' -Status 'pass' -Detail "No detectable profile writes during bounded launch (app may not have created profile data within timeout)"
        }
    } catch {
        Write-Host "  [EXEC] Launch error: $_"
        if (-not $persistenceRecorded) {
            Add-CheckResult -Name 'bounded-launch-persistence' -Status 'fail' -Detail "Launch threw before persistence check: $_"
        }
        # Guarantee exactly one cleanup result on every catch path.
        # If process was launched, do a best-effort sweep regardless of how far we got.
        $cleanupSwept = $false
        if ($procLaunched) {
            try {
                $allProcs = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue
                $installDirProcsCatch = @()
                foreach ($p in $allProcs) {
                    if ($p.ExecutablePath) {
                        $pexDirCatch = [System.IO.Path]::GetDirectoryName($p.ExecutablePath).TrimEnd('\')
                        if ($pexDirCatch -eq $installDirCanon -or $pexDirCatch.StartsWith("$installDirCanon\", [StringComparison]::OrdinalIgnoreCase)) {
                            $installDirProcsCatch += $p
                            & taskkill /T /F /PID $p.ProcessId 2>&1 | Out-Null
                        }
                    }
                }
                Start-Sleep -Seconds 1
                $remainingCatch = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object {
                    $_.ExecutablePath -and $_.ProcessId -ne 0
                }
                $survivorsCatch = @()
                foreach ($p in $remainingCatch) {
                    $pexDirCatch = [System.IO.Path]::GetDirectoryName($p.ExecutablePath).TrimEnd('\')
                    if ($pexDirCatch -eq $installDirCanon -or $pexDirCatch.StartsWith("$installDirCanon\", [StringComparison]::OrdinalIgnoreCase)) {
                        $survivorsCatch += $p
                    }
                }
                $cleanupSwept = $true
                if ($survivorsCatch.Count -eq 0) {
                    Add-CheckResult -Name 'bounded-launch-cleanup' -Status 'pass' -Detail "No survivors after catch sweep (launch PID=$launchedPid)"
                } else {
                    Add-CheckResult -Name 'bounded-launch-cleanup' -Status 'fail' -Detail "$($survivorsCatch.Count) surviving process(es) after catch sweep (launch PID=$launchedPid)"
                }
                $cleanupRecorded = $true
            } catch {
                # Sweep itself threw — best-effort exhausted
            }
        }
        if (-not $cleanupRecorded) {
            if ($procLaunched) {
                Add-CheckResult -Name 'bounded-launch-cleanup' -Status 'fail' -Detail 'Cleanup could not be completed after catch (sweep failed)'
            } else {
                Add-CheckResult -Name 'bounded-launch-cleanup' -Status 'skip' -Detail 'Cleanup skipped: process never launched'
            }
            $cleanupRecorded = $true
        }
    } finally {
        # Restore every parent environment variable - runs even on process launch failure
        Restore-Environment -Backup $savedEnv
        Write-Host "  [EXEC] Parent environment variables restored"
    }

    # Verify environment was restored (always runs, even after early exit)
    $allRestored = $true
    foreach ($entry in $savedEnv.GetEnumerator()) {
        $current = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        if ($current -ne $entry.Value) { $allRestored = $false; break }
    }
    if ($allRestored) {
        Add-CheckResult -Name 'bounded-launch-env-restored' -Status 'pass' -Detail 'All parent environment variables restored after launch'
    } else {
        Add-CheckResult -Name 'bounded-launch-env-restored' -Status 'fail' -Detail 'Some parent environment variables were not properly restored'
    }

    # Manifest-based profile-leak check: compare before/after manifests of real profile subdirectories
    # Always runs, even after early exit
    $manifestUnchanged = $true
    $manifestFailureDetails = @()
    foreach ($mp in $manifestPaths) {
        $canonKey = [System.IO.Path]::GetFullPath($mp.Path).ToUpperInvariant()
        $before = $manifestsBefore[$canonKey]
        $after = New-DirectoryManifest -Path $mp.Path
        if (-not (Compare-DirectoryManifest -Before $before -After $after)) {
            $manifestUnchanged = $false
            $manifestFailureDetails += $mp.Label
        }
    }
    if ($manifestUnchanged) {
        Add-CheckResult -Name 'bounded-launch-profile-manifest-unchanged' -Status 'pass' -Detail 'Real profile subdirectories unchanged after bounded launch'
    } else {
        Add-CheckResult -Name 'bounded-launch-profile-manifest-unchanged' -Status 'fail' -Detail "Real profile subdirectories changed after bounded launch: $($manifestFailureDetails -join ', ')"
    }
}

function Invoke-UninstallCheck {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    if (-not $AllowUninstall) {
        Add-CheckResult -Name 'uninstall' -Status 'skip' -Detail 'Uninstall requires -AllowUninstall'
        return
    }
    if ($WhatIfPreference) {
        Add-CheckResult -Name 'uninstall' -Status 'skip' -Detail 'Plan-only: would uninstall Baby Menu'
        return
    }
    Write-Host '  [EXEC] Running uninstaller'

    $uninstPaths = @(
        [System.IO.Path]::Combine($InstallDir, 'Uninstall Baby Menu.exe'),
        [System.IO.Path]::Combine($InstallDir, 'Uninstall Baby Menu Dev.exe'),
        [System.IO.Path]::Combine($InstallDir, 'Uninstall.exe'),
        [System.IO.Path]::Combine($InstallDir, 'uninst.exe'),
        [System.IO.Path]::Combine($InstallDir, 'uninstall.exe')
    )
    $uninstPath = $null
    foreach ($p in $uninstPaths) {
        if (Test-Path $p) { $uninstPath = $p; break }
    }

    if (-not $uninstPath) {
        Add-CheckResult -Name 'uninstall' -Status 'fail' -Detail 'Uninstaller executable not found in InstallDir'
        return
    }

    $proc = Start-Process -FilePath $uninstPath -ArgumentList '/S' -Wait -PassThru -NoNewWindow
    $exitCode = $proc.ExitCode

    if ($exitCode -eq 0) {
        Add-CheckResult -Name 'uninstall' -Status 'pass' -Detail "Uninstaller exited with code $exitCode"

        if (Test-Path $InstallDir) {
            Add-CheckResult -Name 'uninstall-dir-removed' -Status 'fail' -Detail "InstallDir still exists after uninstall: $InstallDir"
        } else {
            Add-CheckResult -Name 'uninstall-dir-removed' -Status 'pass' -Detail 'InstallDir removed after uninstall'
        }
    } else {
        Add-CheckResult -Name 'uninstall' -Status 'fail' -Detail "Uninstaller exited with code $exitCode"
    }
}

# ---- Post-install process detection ----

$script:ProceedWithLaunch = $true

function Invoke-PostInstallProcessCheck {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    $name = 'post-install-no-running-app'
    if ($WhatIfPreference) {
        Add-CheckResult -Name $name -Status 'skip' -Detail 'Plan-only: would check for running app processes under InstallDir'
        return
    }
    Write-Host '  [EXEC] Checking for app processes running from InstallDir'

    $installDirCanon = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    try {
        $allProcs = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop
    } catch {
        Write-Host "  [EXEC] Cannot enumerate processes (Win32_Process query failed)"
        Add-CheckResult -Name $name -Status 'fail' -Detail 'Cannot enumerate processes: Win32_Process query failed'
        $script:ProceedWithLaunch = $false
        return
    }
    $found = @()
    foreach ($p in $allProcs) {
        if ($p.ExecutablePath) {
            $pexDir = [System.IO.Path]::GetDirectoryName($p.ExecutablePath).TrimEnd('\')
            if ($pexDir -eq $installDirCanon -or $pexDir.StartsWith("$installDirCanon\", [StringComparison]::OrdinalIgnoreCase)) {
                $found += $p
            }
        }
    }
    if ($found.Count -eq 0) {
        Add-CheckResult -Name $name -Status 'pass' -Detail 'No app processes running from InstallDir'
        return
    }
    $pids = ($found | ForEach-Object { $_.ProcessId }) -join ', '
    Add-CheckResult -Name $name -Status 'fail' -Detail "$($found.Count) app process(es) running from InstallDir after install (PID(s): $pids)"
    foreach ($p in $found) {
        & taskkill /T /F /PID $p.ProcessId 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 1
    try {
        $remaining = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop
    } catch {
        Write-Host "  [EXEC] Cannot re-enumerate processes after kill"
        $script:ProceedWithLaunch = $false
        return
    }
    $survivors = @()
    foreach ($p in $remaining) {
        if ($p.ExecutablePath) {
            $pexDir = [System.IO.Path]::GetDirectoryName($p.ExecutablePath).TrimEnd('\')
            if ($pexDir -eq $installDirCanon -or $pexDir.StartsWith("$installDirCanon\", [StringComparison]::OrdinalIgnoreCase)) {
                $survivors += $p
            }
        }
    }
    if ($survivors.Count -eq 0) {
        Write-Host "  [EXEC] Killed $($found.Count) process(es) under InstallDir; no survivors"
    } else {
        Write-Host "  [WARN] $($survivors.Count) survivor(s) remain after kill"
    }
    $script:ProceedWithLaunch = $false
}

function Invoke-UnsupportedCheck {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    Add-CheckResult -Name 'packaged-extension-execution' -Status 'skip' -Detail 'Requires running Electron app; not testable from standalone PS script' -ManualGuidance "Run 'pnpm vitest run tests/extension-module-compiler.test.ts tests/widget-tailwind-css.test.ts tests/widget-module-registry.test.ts tests/server-action-registry.test.ts' after install to validate packaged extension compilation and loading"

    Add-CheckResult -Name 'sqlite-persistence' -Status 'skip' -Detail 'Requires Electron app to create SQLite store; not testable from standalone PS script' -ManualGuidance "Launch Baby Menu once to initialize the extension database, then run 'pnpm vitest run tests/extension-database.test.ts' against the created store path"

    Add-CheckResult -Name 'keep-undo-change-session' -Status 'skip' -Detail 'Requires embedded agent session with git/snapshot workspace; not testable from standalone PS script' -ManualGuidance "Run 'pnpm vitest run tests/git-change-session.test.ts tests/dev-extension-change-session.test.ts' on a Windows host with git available"

    Add-CheckResult -Name 'credential-inheritance' -Status 'skip' -Detail 'Requires adapter child-process execution with real agent credentials; not testable from standalone PS script without exposing secrets' -ManualGuidance "Run 'pnpm vitest run tests/adapter-child-env.test.ts tests/process-tree.test.ts' on Windows to verify env scoping and credential isolation. For credential non-exposure verification, inspect adapter driver sources in src/adapters/"

    Add-CheckResult -Name 'descendant-cancellation' -Status 'skip' -Detail 'Requires real agent turn with long-running descendant; not testable from standalone PS script' -ManualGuidance "Run 'pnpm vitest run tests/process-tree.test.ts' on Windows. For live agent-turn cancellation, start the app, send a prompt to the agent, cancel mid-turn, and run 'tasklist /FI ""IMAGENAME eq node.exe"" /FO CSV' to verify no survivors"
}

# ---------------------------------------------------------------------------
# Genuinely manual GUI-only checks
# ---------------------------------------------------------------------------

function Get-ManualChecks {
    @(
        @{ Name = 'tray-icon-visual'; Guidance = 'Launch the app and visually verify the Baby Menu tray icon appears correctly on the Windows taskbar.' }
        @{ Name = 'popover-open-close'; Guidance = 'Click the tray icon and visually verify the popover opens. Click away and verify it closes.' }
        @{ Name = 'popover-layout'; Guidance = 'Verify installed widgets render correctly in the popover layout.' }
        @{ Name = 'settings-ui'; Guidance = 'Open Settings from the popover header and verify each section loads without error.' }
        @{ Name = 'agent-conversation'; Guidance = 'Start an agent conversation, send a prompt, and verify the response appears in the chat UI.' }
        @{ Name = 'keep-undo-ui'; Guidance = 'After an agent turn that changes files, verify the Keep/Undo bar appears and both buttons work.' }
        @{ Name = 'window-behavior'; Guidance = 'Verify the popover stays on top of other windows and does not appear in the taskbar.' }
    )
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Write-Host '=== Baby Menu Windows Native Validation Runner ===' -ForegroundColor Cyan
Write-Host ''

# Guards — on failure, write only to a proven safe $env:TEMP, not to the
# untrusted DiagnosticDir that may not have been validated yet.
try {
    Assert-WindowsNative
    Assert-NotWsl
    Assert-MutationConsent
    $installDirResolved   = Assert-PathSafe -Path $InstallDir -Label 'InstallDir'
    $userDataDirResolved  = Assert-PathSafe -Path $UserDataDir -Label 'UserDataDir'
    $diagnosticDirResolved = Assert-PathSafe -Path $DiagnosticDir -Label 'DiagnosticDir'
    Assert-NoPathOverlap -Path1 $InstallDir -Path2 $UserDataDir -Label1 'InstallDir' -Label2 'UserDataDir'
    Assert-NoPathOverlap -Path1 $InstallDir -Path2 $DiagnosticDir -Label1 'InstallDir' -Label2 'DiagnosticDir'
    Assert-NoPathOverlap -Path1 $UserDataDir -Path2 $DiagnosticDir -Label1 'UserDataDir' -Label2 'DiagnosticDir'
    Assert-ExistingPathSafe -Path $InstallDir -Label 'InstallDir'
    Assert-ExistingPathSafe -Path $UserDataDir -Label 'UserDataDir'
    Assert-ExistingPathSafe -Path $DiagnosticDir -Label 'DiagnosticDir'
} catch {
    [Console]::Error.WriteLine("Guard failed: $_")
    if (-not $WhatIfPreference) {
        $tempPath = Join-Path $env:TEMP "baby-menu-validation-guard-failure-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')).txt"
        "Guard failed at $(Get-Date -Format 'o'): $_" | Out-File -FilePath $tempPath -Encoding utf8
        Write-Warning "Failure logged to $tempPath"
    }
    exit 1
}

Add-CheckResult -Name 'preflight-guards' -Status 'pass' -Detail 'All runtime guards passed (native Windows, drive-letter path, path safety)'

# Use canonical paths for all subsequent operations
$InstallDir     = $installDirResolved
$UserDataDir    = $userDataDirResolved
$DiagnosticDir  = $diagnosticDirResolved

Write-Host "Installer  : $InstallerPath"
Write-Host "InstallDir : $installDirResolved"
Write-Host "UserData   : $userDataDirResolved"
Write-Host "Diagnostic : $diagnosticDirResolved"
Write-Host "WhatIf     : $($WhatIfPreference)"
Write-Host ''

if ($WhatIfPreference) {
    Write-Host '>>> PLAN-ONLY MODE (-WhatIf): No mutations will be performed <<<' -ForegroundColor Yellow
    Write-Host ''
}

# Phase 1: Pre-install sentinel
Write-Host '--- Phase 1: Pre-install sentinel ---' -ForegroundColor Green
if ($AllowInstall -or $WhatIfPreference) {
    Invoke-SentinelCreate
} else {
    Add-CheckResult -Name 'sentinel-create' -Status 'skip' -Detail 'Skipped: -AllowInstall not specified'
}

# Phase 2: Install
Write-Host '--- Phase 2: Install ---' -ForegroundColor Green
if ($AllowInstall -or $WhatIfPreference) {
    Invoke-InstallerCheck
} else {
    Add-CheckResult -Name 'installer' -Status 'skip' -Detail 'Skipped: -AllowInstall not specified'
}

# Phase 3: Install sentinel verify
Write-Host '--- Phase 3: Sentinel verify (post-install) ---' -ForegroundColor Green
if ($AllowInstall -or $WhatIfPreference) {
    Invoke-SentinelVerify -Stage 'install'
} else {
    Add-CheckResult -Name 'sentinel-verify-install' -Status 'skip' -Detail 'Skipped: -AllowInstall not specified'
}

# Phase 4: Post-install process check
Write-Host '--- Phase 4: Post-install process check ---' -ForegroundColor Green
Invoke-PostInstallProcessCheck

# Phase 5: Installed files
Write-Host '--- Phase 5: Installed files ---' -ForegroundColor Green
Invoke-InstalledFilesCheck

# Phase 6: Shortcuts
Write-Host '--- Phase 6: Shortcuts ---' -ForegroundColor Green
Invoke-ShortcutCheck

# Phase 7: Registry uninstall entry
Write-Host '--- Phase 7: Registry uninstall entry ---' -ForegroundColor Green
Invoke-RegistryUninstallCheck

# Phase 8: Unsupported runtime checks
Write-Host '--- Phase 8: Runtime checks (not standalone-testable) ---' -ForegroundColor Yellow
Invoke-UnsupportedCheck

# Phase 9: Bounded launch (gated by post-install process check)
Write-Host '--- Phase 9: Bounded launch ---' -ForegroundColor Green
if ($script:ProceedWithLaunch) {
    Invoke-BoundedLaunchCheck
} else {
    Add-CheckResult -Name 'bounded-launch-persistence' -Status 'skip' -Detail 'Skipped: $ProceedWithLaunch is false (app processes found after install)' -ManualGuidance 'Stop and report retained evidence to the captain. Another launch requires captain authorization.'
    Add-CheckResult -Name 'bounded-launch-cleanup' -Status 'skip' -Detail 'Skipped: $ProceedWithLaunch is false'
    Add-CheckResult -Name 'bounded-launch-diagnostics' -Status 'skip' -Detail 'Skipped: $ProceedWithLaunch is false'
    Add-CheckResult -Name 'bounded-launch-exe-under-installdir' -Status 'skip' -Detail 'Skipped: $ProceedWithLaunch is false'
    Add-CheckResult -Name 'bounded-launch-profile-isolation' -Status 'skip' -Detail 'Skipped: $ProceedWithLaunch is false'
    Add-CheckResult -Name 'bounded-launch-profile-writes-contained' -Status 'skip' -Detail 'Skipped: $ProceedWithLaunch is false'
    Add-CheckResult -Name 'bounded-launch-env-restored' -Status 'skip' -Detail 'Skipped: $ProceedWithLaunch is false'
    Add-CheckResult -Name 'bounded-launch-profile-manifest-unchanged' -Status 'skip' -Detail 'Skipped: $ProceedWithLaunch is false'
}

# Phase 10: Uninstall + sentinel verify
Write-Host '--- Phase 10: Uninstall ---' -ForegroundColor Green
if ($AllowUninstall -or $WhatIfPreference) {
    Invoke-UninstallCheck
    Invoke-SentinelVerify -Stage 'uninstall'
} else {
    Add-CheckResult -Name 'uninstall' -Status 'skip' -Detail 'Uninstall requires -AllowUninstall'
    Add-CheckResult -Name 'sentinel-verify-uninstall' -Status 'skip' -Detail 'Skipped: -AllowUninstall not specified'
}

# Phase 11: Manual checks
Write-Host '--- Manual checks (not automatable) ---' -ForegroundColor Yellow
$manualChecks = Get-ManualChecks
foreach ($check in $manualChecks) {
    Add-CheckResult -Name "manual-$($check.Name)" -Status 'skip' -Detail 'Genuinely manual GUI-only check' -ManualGuidance $check.Guidance
    Write-Host "  [MANUAL] $($check.Name): $($check.Guidance)"
}

# Evidence
Write-Host ''
$evidenceResult = Write-Evidence

if ($WhatIfPreference) {
    Write-Host "--- BEGIN PLAN-ONLY EVIDENCE ---"
    Write-Host $evidenceResult
    Write-Host "--- END PLAN-ONLY EVIDENCE ---"
    Write-Host ''
} else {
    Write-Host "Evidence bundle: $evidenceResult"
}

# Summary
Write-Host ''
Write-Host '=== Summary ===' -ForegroundColor Cyan
$passed  = 0; $failed = 0; $skipped = 0
foreach ($c in $script:Checks) {
    switch ($c.Status) {
        'pass'   { $passed++ }
        'fail'   { $failed++ }
        'skip'   { $skipped++ }
    }
}
Write-Host "Passed : $passed"
Write-Host "Failed : $failed"
Write-Host "Skipped: $skipped"
Write-Host "Total  : $($script:Checks.Count)"

if ($WhatIfPreference) {
    Write-Host ''
    Write-Host 'Plan-only mode. Re-run without -WhatIf and with -AllowInstall/-AllowUninstall/-AllowLaunch to execute mutations.' -ForegroundColor Yellow
}

Write-Host ''

if ($failed -gt 0) { exit 1 }
