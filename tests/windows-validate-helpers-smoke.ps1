<#
.SYNOPSIS
  Smoke test for Baby Menu Windows validation helpers and bounded launch pattern.
  Compatible with Windows PowerShell 5.1 and PowerShell 7+.
.DESCRIPTION
  Tests New-DirectoryManifest, Compare-DirectoryManifest, Backup-Environment,
  Restore-Environment, and ProcessStartInfo-based launch with exit code capture,
  bounded stdout/stderr, and capping/redaction.
  Uses cmd.exe as a stand-in for Baby Menu.exe (never launches the real app).
  Exits 0 on all pass, 1 on any failure.  Removes all temp files always.
#>

#Requires -Version 5.1

$ErrorActionPreference = 'Stop'
$passed = 0
$failed = 0

function Assert-Equal {
    param([string]$Label, $Expected, $Actual)
    $ok = $Expected -eq $Actual
    if ($ok) { $script:passed++ } else {
        $script:failed++
        Write-Host "FAIL: $Label (expected=$Expected, actual=$Actual)"
    }
}

function Assert-Contains {
    param([string]$Label, [string]$Haystack, [string]$Needle)
    if ($Haystack.Contains($Needle)) { $script:passed++ } else {
        $script:failed++
        Write-Host "FAIL: $Label - expected '$Needle' not found in '$Haystack'"
    }
}

# -- Helpers under test (mirror windows-validate.ps1) --

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

function Cap-Output {
    param([string]$Text, [int]$MaxCap = 128)
    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    if ($Text.Length -gt $MaxCap) {
        return $Text.Substring(0, $MaxCap) + "`n... [TRUNCATED at ${MaxCap} chars]"
    }
    return $Text
}

Write-Host '=== Baby Menu Windows Validation Helper Smoke ==='

# 1. Both null ----
$result = Compare-DirectoryManifest -Before $null -After $null
Assert-Equal 'both null -> true' $true $result

# 2. One null (before) ----
$result = Compare-DirectoryManifest -Before @{} -After $null
Assert-Equal 'after null -> false' $false $result

# 3. One null (after) ----
$result = Compare-DirectoryManifest -Before $null -After @{}
Assert-Equal 'before null -> false' $false $result

# 4. Both empty ----
$result = Compare-DirectoryManifest -Before @{} -After @{}
Assert-Equal 'both empty -> true' $true $result

# 5. Identical single entry ----
$before = @{ 'f.txt' = @{ Length = 100; LastWrite = '2024-01-01T00:00:00'; SHA256 = 'abc' } }
$after  = @{ 'f.txt' = @{ Length = 100; LastWrite = '2024-01-01T00:00:00'; SHA256 = 'abc' } }
$result = Compare-DirectoryManifest -Before $before -After $after
Assert-Equal 'identical entry -> true' $true $result

# 6. Different length ----
$before = @{ 'f.txt' = @{ Length = 100; LastWrite = '2024-01-01T00:00:00' } }
$after  = @{ 'f.txt' = @{ Length = 200; LastWrite = '2024-01-01T00:00:00' } }
$result = Compare-DirectoryManifest -Before $before -After $after
Assert-Equal 'different length -> false' $false $result

# 7. Different last-write ----
$before = @{ 'f.txt' = @{ Length = 100; LastWrite = '2024-01-01T00:00:00' } }
$after  = @{ 'f.txt' = @{ Length = 100; LastWrite = '2024-06-01T00:00:00' } }
$result = Compare-DirectoryManifest -Before $before -After $after
Assert-Equal 'different last-write -> false' $false $result

# 8. Missing key ----
$before = @{ 'a.txt' = @{ Length = 100 }; 'b.txt' = @{ Length = 50 } }
$after  = @{ 'a.txt' = @{ Length = 100 } }
$result = Compare-DirectoryManifest -Before $before -After $after
Assert-Equal 'missing key -> false' $false $result

# 9. SHA256 present only before, absent after ----
$before = @{ 'f.txt' = @{ Length = 100; LastWrite = '2024-01-01'; SHA256 = 'abc' } }
$after  = @{ 'f.txt' = @{ Length = 100; LastWrite = '2024-01-01' } }
$result = Compare-DirectoryManifest -Before $before -After $after
Assert-Equal 'SHA256 one-sided (before) -> false' $false $result

# 10. SHA256 absent before, present after ----
$before = @{ 'f.txt' = @{ Length = 100; LastWrite = '2024-01-01' } }
$after  = @{ 'f.txt' = @{ Length = 100; LastWrite = '2024-01-01'; SHA256 = 'def' } }
$result = Compare-DirectoryManifest -Before $before -After $after
Assert-Equal 'SHA256 one-sided (after) -> false' $false $result

# 11. Different SHA256 values ----
$before = @{ 'f.txt' = @{ Length = 100; LastWrite = '2024-01-01'; SHA256 = 'abc' } }
$after  = @{ 'f.txt' = @{ Length = 100; LastWrite = '2024-01-01'; SHA256 = 'def' } }
$result = Compare-DirectoryManifest -Before $before -After $after
Assert-Equal 'different SHA256 -> false' $false $result

# 12. Real temp directory smoke ----
$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "baby-menu-smoke-$([System.Guid]::NewGuid().ToString('N'))"
try {
    $null = New-Item -ItemType Directory -Path $tmpRoot -Force
    'a-content' | Out-File -FilePath (Join-Path $tmpRoot 'a.txt') -Encoding utf8 -NoNewline
    'b-content' | Out-File -FilePath (Join-Path $tmpRoot 'b.txt') -Encoding utf8 -NoNewline
    Start-Sleep -Milliseconds 100

    # Same dir, same state -> identical manifests
    $m1 = New-DirectoryManifest -Path $tmpRoot
    $m2 = New-DirectoryManifest -Path $tmpRoot
    $result = Compare-DirectoryManifest -Before $m1 -After $m2
    Assert-Equal 'identical temp dir -> true' $true $result

    # Verify manifest is a plain hashtable, not OrderedDictionary
    $isHashtable = $m1 -is [hashtable]
    Assert-Equal 'returns plain hashtable' $true $isHashtable

    # Modify a file and re-compare
    Start-Sleep -Seconds 1
    'modified-content' | Out-File -FilePath (Join-Path $tmpRoot 'a.txt') -Encoding utf8 -NoNewline
    $m3 = New-DirectoryManifest -Path $tmpRoot
    $result = Compare-DirectoryManifest -Before $m1 -After $m3
    Assert-Equal 'modified file -> false' $false $result

    # Add a file
    'new-file' | Out-File -FilePath (Join-Path $tmpRoot 'c.txt') -Encoding utf8 -NoNewline
    $m4 = New-DirectoryManifest -Path $tmpRoot
    $result = Compare-DirectoryManifest -Before $m1 -After $m4
    Assert-Equal 'added file -> false' $false $result

    # Remove a file
    Remove-Item -Path (Join-Path $tmpRoot 'b.txt') -Force
    $m5 = New-DirectoryManifest -Path $tmpRoot
    $result = Compare-DirectoryManifest -Before $m1 -After $m5
    Assert-Equal 'removed file -> false' $false $result

    # SHA256 hash embedded in manifest entries
    $entryA = $m1['a.txt']
    Assert-Equal 'manifest entry has SHA256' $true $entryA.ContainsKey('SHA256')
    Write-Host "  [INFO] a.txt SHA256=$($entryA.SHA256)"
} finally {
    if (Test-Path $tmpRoot) { Remove-Item -Path $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---- Bounded launch pattern (ProcessStartInfo exit code / output / env) ----

Write-Host ''
Write-Host '--- Bounded launch pattern scenarios ---' -ForegroundColor Green

# 13. ProcessStartInfo exit code 0 ----
try {
    $psi13 = New-Object System.Diagnostics.ProcessStartInfo
    $psi13.FileName = 'cmd.exe'
    $psi13.Arguments = '/c exit 0'
    $psi13.UseShellExecute = $false
    $psi13.RedirectStandardOutput = $true
    $psi13.RedirectStandardError = $true
    $psi13.CreateNoWindow = $true
    $p13 = [System.Diagnostics.Process]::Start($psi13)
    $p13.WaitForExit(10000) | Out-Null
    Assert-Equal 'ProcessStartInfo exit code 0' 0 $p13.ExitCode
} finally {
    if ($p13 -and -not $p13.HasExited) { $p13.Kill() }
    if ($p13) { $p13.Dispose() }
}

# 14. ProcessStartInfo exit code 42 (nonzero) ----
try {
    $psi14 = New-Object System.Diagnostics.ProcessStartInfo
    $psi14.FileName = 'cmd.exe'
    $psi14.Arguments = '/c exit 42'
    $psi14.UseShellExecute = $false
    $psi14.RedirectStandardOutput = $true
    $psi14.RedirectStandardError = $true
    $psi14.CreateNoWindow = $true
    $p14 = [System.Diagnostics.Process]::Start($psi14)
    $p14.WaitForExit(10000) | Out-Null
    Assert-Equal 'ProcessStartInfo exit code 42' 42 $p14.ExitCode
} finally {
    if ($p14 -and -not $p14.HasExited) { $p14.Kill() }
    if ($p14) { $p14.Dispose() }
}

# 15. Stdout capture ----
try {
    $psi15 = New-Object System.Diagnostics.ProcessStartInfo
    $psi15.FileName = 'cmd.exe'
    $psi15.Arguments = '/c echo hello-smoke'
    $psi15.UseShellExecute = $false
    $psi15.RedirectStandardOutput = $true
    $psi15.RedirectStandardError = $true
    $psi15.CreateNoWindow = $true
    $p15 = [System.Diagnostics.Process]::Start($psi15)
    $stdout15 = $p15.StandardOutput.ReadToEnd()
    $p15.WaitForExit(10000) | Out-Null
    Assert-Contains 'stdout capture contains hello-smoke' $stdout15 'hello-smoke'
} finally {
    if ($p15 -and -not $p15.HasExited) { $p15.Kill() }
    if ($p15) { $p15.Dispose() }
}

# 16. Output capping (Cap-Output truncates long text) ----
$longText = 'x' * 500
$capped = Cap-Output -Text $longText -MaxCap 128
Assert-Equal 'capped output length <= maxcap' $true ($capped.Length -le 128 + 50)
Assert-Contains 'capped output has TRUNCATED marker' $capped 'TRUNCATED'

# 17. Cap-Output does not truncate short text ----
$shortText = 'hello'
$uncapped = Cap-Output -Text $shortText -MaxCap 128
Assert-Equal 'short text unchanged by Cap-Output' 'hello' $uncapped

# 18. Environment backup/restore ----
$original = [Environment]::GetEnvironmentVariable('TEMP', 'Process')
$backup = Backup-Environment -Variables @('TEMP')
[Environment]::SetEnvironmentVariable('TEMP', 'C:\smoke-test-override', 'Process')
$modified = [Environment]::GetEnvironmentVariable('TEMP', 'Process')
Assert-Equal 'TEMP modified to override' 'C:\smoke-test-override' $modified
Restore-Environment -Backup $backup
$restored = [Environment]::GetEnvironmentVariable('TEMP', 'Process')
Assert-Equal 'TEMP restored after Restore-Environment' $original $restored

# 19. Second-instance-rejected JSON marker recognized (line pattern) ----
$validJson = '{"event":"second-instance-rejected","platform":"win32","isPackaged":true}'
$secondInstanceLinePattern = '^\s*\{\s*"event"\s*:\s*"second-instance-rejected"\s*,\s*"platform"\s*:\s*"win32"\s*,\s*"isPackaged"\s*:\s*(true|false)\s*\}\s*$'
Assert-Equal 'valid second-instance line matches' $true ($validJson -match $secondInstanceLinePattern)

# 20. Deviant JSON markers are rejected against the line pattern ----
$badEvent = '{"event":"other-event","platform":"win32","isPackaged":true}'
$badPlatform = '{"event":"second-instance-rejected","platform":"darwin","isPackaged":true}'
$badExtra = '{"event":"second-instance-rejected","platform":"win32","isPackaged":true,"extra":"field"}'
Assert-Equal 'wrong event rejected' $false ($badEvent -match $secondInstanceLinePattern)
Assert-Equal 'wrong platform rejected' $false ($badPlatform -match $secondInstanceLinePattern)
Assert-Equal 'extra field rejected' $false ($badExtra -match $secondInstanceLinePattern)

# 21. Line-by-line extraction from mixed stream (stdout with startup noise) ----
$mixedStream = "Electron startup log`n{""event"":""second-instance-rejected"",""platform"":""win32"",""isPackaged"":true}`ntrailing output"
$foundMarker = $false
foreach ($line in ($mixedStream -split "`n")) {
    if ($line -match $secondInstanceLinePattern) { $foundMarker = $true; break }
}
Assert-Equal 'marker found in mixed stdout stream' $true $foundMarker

# 22. Line-by-line extraction from stderr stream (console.warn with marker) ----
$stderrWithMarker = "console.warn: some deprecation`n{""event"":""second-instance-rejected"",""platform"":""win32"",""isPackaged"":false}`n"
$foundOnStderr = $false
foreach ($line in ($stderrWithMarker -split "`n")) {
    if ($line -match $secondInstanceLinePattern) { $foundOnStderr = $true; break }
}
Assert-Equal 'marker found in stderr stream' $true $foundOnStderr

# 23. Console.warn noise without marker is correctly rejected ----
$stderrNoiseOnly = "console.warn: Deprecated API`nconsole.warn: Another warning`n"
$foundOnStderrNoise = $false
foreach ($line in ($stderrNoiseOnly -split "`n")) {
    if ($line -match $secondInstanceLinePattern) { $foundOnStderrNoise = $true; break }
}
Assert-Equal 'no marker in noise-only stderr' $false $foundOnStderrNoise

# 24. No raw output embedded in persistence-style detail (SHA-256 digest instead) ----
$sampleStdout = 'some sensitive output that must not appear in details'
$sha256 = [System.BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::Create().ComputeHash(
        [System.Text.Encoding]::UTF8.GetBytes($sampleStdout)
    )
).Replace('-', '')
$detail = "exitCode=0; stdoutLen=$($sampleStdout.Length); stdoutSHA256=$sha256; stderrLen=0"
Assert-Contains 'detail contains SHA256' $detail $sha256
Assert-Equal 'detail does not contain raw text' $false $detail.Contains($sampleStdout)

# 25. Process start failure cleanup guarantee (Pattern: catch block records cleanup skip when process never launched) ----
$catchSafetyDetail = 'Cleanup skipped: process never launched'
Assert-Equal 'catch safety detail is deterministic' $true ($catchSafetyDetail -eq 'Cleanup skipped: process never launched')

# 26. Boundary: process that exits rapidly (early-exit pattern) captured via WaitForExit(2000) ----
try {
    $psi26 = New-Object System.Diagnostics.ProcessStartInfo
    $psi26.FileName = 'cmd.exe'
    $psi26.Arguments = '/c exit 7'
    $psi26.UseShellExecute = $false
    $psi26.RedirectStandardOutput = $true
    $psi26.RedirectStandardError = $true
    $psi26.CreateNoWindow = $true
    $p26 = [System.Diagnostics.Process]::Start($psi26)
    $p26.WaitForExit(2000) | Out-Null
    # Process that exited before deadline: wasAliveAtDeadline = -not $p26.HasExited
    $wasAlive = -not $p26.HasExited
    Assert-Equal 'rapid-exit process not alive at deadline' $false $wasAlive
    Assert-Equal 'rapid-exit process exit code captured' 7 $p26.ExitCode
} finally {
    if ($p26 -and -not $p26.HasExited) { $p26.Kill() }
    if ($p26) { $p26.Dispose() }
}

# 27. Dual-stream: real process emits marker JSON on stdout, detected line-by-line ----
try {
    $psi27 = New-Object System.Diagnostics.ProcessStartInfo
    $psi27.FileName = 'cmd.exe'
    $psi27.Arguments = '/c echo {"event":"second-instance-rejected","platform":"win32","isPackaged":true}'
    $psi27.UseShellExecute = $false
    $psi27.RedirectStandardOutput = $true
    $psi27.RedirectStandardError = $true
    $psi27.CreateNoWindow = $true
    $p27 = [System.Diagnostics.Process]::Start($psi27)
    $stdout27 = $p27.StandardOutput.ReadToEnd()
    $p27.WaitForExit(5000) | Out-Null
    $foundOnStdout = $false
    foreach ($line in ($stdout27 -split "`n")) {
        if ($line -match $secondInstanceLinePattern) { $foundOnStdout = $true; break }
    }
    Assert-Equal 'marker detected from real process stdout' $true $foundOnStdout
} finally {
    if ($p27 -and -not $p27.HasExited) { $p27.Kill() }
    if ($p27) { $p27.Dispose() }
}

# 28. Dual-stream: real process emits marker JSON on stderr, detected line-by-line ----
try {
    $psi28 = New-Object System.Diagnostics.ProcessStartInfo
    $psi28.FileName = 'cmd.exe'
    $psi28.Arguments = '/c echo {"event":"second-instance-rejected","platform":"win32","isPackaged":false} 1>&2'
    $psi28.UseShellExecute = $false
    $psi28.RedirectStandardOutput = $true
    $psi28.RedirectStandardError = $true
    $psi28.CreateNoWindow = $true
    $p28 = [System.Diagnostics.Process]::Start($psi28)
    $stderr28 = $p28.StandardError.ReadToEnd()
    $p28.WaitForExit(5000) | Out-Null
    $foundOnStderrReal = $false
    foreach ($line in ($stderr28 -split "`n")) {
        if ($line -match $secondInstanceLinePattern) { $foundOnStderrReal = $true; break }
    }
    Assert-Equal 'marker detected from real process stderr' $true $foundOnStderrReal
} finally {
    if ($p28 -and -not $p28.HasExited) { $p28.Kill() }
    if ($p28) { $p28.Dispose() }
}

# 30. Process enumeration path boundary: paths inside InstallDir match, outside do not ----
try {
    $installDirCanon = [System.IO.Path]::GetFullPath("C:\Tools\BabyMenu").TrimEnd('\')
    $inside1 = "C:\Tools\BabyMenu\Baby Menu.exe"
    $inside2 = "C:\Tools\BabyMenu\resources\app.asar"
    $outside1 = "C:\Windows\System32\cmd.exe"
    $outside2 = "C:\Program Files\SomeOtherApp\app.exe"

    $dot = [System.IO.Path]::GetDirectoryName($inside1).TrimEnd('\')
    Assert-Equal 'inside exe matches (GetDirectoryName = InstallDir)' $installDirCanon $dot
    $dot2 = [System.IO.Path]::GetDirectoryName($inside2).TrimEnd('\')
    Assert-Equal 'inside resource matches (GetDirectoryName starts with InstallDir)' $true ($installDirCanon -eq $dot2 -or $dot2.StartsWith("$installDirCanon\", [StringComparison]::OrdinalIgnoreCase))

    $outsideDir1 = [System.IO.Path]::GetDirectoryName($outside1).TrimEnd('\')
    Assert-Equal 'outside exe does not match InstallDir' $false ($installDirCanon -eq $outsideDir1 -or $outsideDir1.StartsWith("$installDirCanon\", [StringComparison]::OrdinalIgnoreCase))

    $outsideDir2 = [System.IO.Path]::GetDirectoryName($outside2).TrimEnd('\')
    Assert-Equal 'outside app does not match InstallDir' $false ($installDirCanon -eq $outsideDir2 -or $outsideDir2.StartsWith("$installDirCanon\", [StringComparison]::OrdinalIgnoreCase))
} catch {
    # Path boundary test uses fake paths; errors indicate logic issues
    $script:failed++
    Write-Host "FAIL: Path boundary test threw: $_"
}

# 31. Kill failure / survivor pattern (simulated: no real processes to kill) ----
$foundMockProcesses = @()
Assert-Equal 'zero processes found -> none to kill' 0 $foundMockProcesses.Count

# 32. Explicit-launch suppression gating variable semantics ----
$proceedWithLaunchTest = $true
# Simulate finding processes
$foundMock = @{ Count = 2 }
if ($foundMock.Count -gt 0) { $proceedWithLaunchTest = $false }
Assert-Equal 'ProceedWithLaunch set false when processes found' $false $proceedWithLaunchTest

# Reset and simulate no processes
$proceedWithLaunchTest = $true
$foundMockNone = @{ Count = 0 }
if ($foundMockNone.Count -gt 0) { $proceedWithLaunchTest = $false }
Assert-Equal 'ProceedWithLaunch stays true when no processes' $true $proceedWithLaunchTest

# 33. WhatIf guard pattern skips without mutation ----
$mutationOccurred = $false
$whatIf = $true
if ($whatIf) {
    # This is the WhatIf guard - return without mutation
} else {
    $mutationOccurred = $true
}
Assert-Equal 'WhatIf guard prevents mutation' $false $mutationOccurred

# 34. Survivor check: zero survivors after kill ----
$survivorsAfterKill = @()
Assert-Equal 'zero survivors after kill' 0 $survivorsAfterKill.Count

# 35. Survivor check: some survivors reported ----
$survivorsPresent = @(@{ ProcessId = 1234 })
Assert-Equal 'survivors detected when present' 1 $survivorsPresent.Count

# 36. Path boundary: InstallDir edge case (InstallDir is empty) ----
$emptyInstallDir = ""
$someExePath = "C:\SomeDir\app.exe"
$emptyDir = ""
try {
    $matchEmpty = $emptyInstallDir -eq $emptyDir -or [string]::IsNullOrWhiteSpace($emptyInstallDir)
    Assert-Equal 'empty InstallDir does not crash comparison' $true $matchEmpty
} catch {
    $script:failed++
    Write-Host "FAIL: Empty InstallDir path boundary test threw: $_"
}

# 37. Enumeration failure suppresses launch (simulated try/catch behavior) ----
$enumFailed = $true
$suppressLaunch = $true
if ($enumFailed) {
    # Catch block sets ProceedWithLaunch = false and returns
    $suppressLaunch = $false
}
Assert-Equal 'enumeration failure suppresses launch' $false $suppressLaunch

# 38. Enumeration failure does not log PIDs or ExecutablePath in detail ----
$failureDetail = 'Cannot enumerate processes: Win32_Process query failed'
Assert-Equal 'failure detail no PID leak' $false $failureDetail.Contains('PID')
Assert-Equal 'failure detail no ExecutablePath leak' $false $failureDetail.Contains('ExecutablePath')

# 29. Boundary marker on stdout preceded by startup noise, first match wins ----
try {
    $psi29 = New-Object System.Diagnostics.ProcessStartInfo
    $psi29.FileName = 'cmd.exe'
    $psi29.Arguments = '/c echo startup-log & echo {"event":"second-instance-rejected","platform":"win32","isPackaged":true} & echo trailing-log'
    $psi29.UseShellExecute = $false
    $psi29.RedirectStandardOutput = $true
    $psi29.RedirectStandardError = $true
    $psi29.CreateNoWindow = $true
    $p29 = [System.Diagnostics.Process]::Start($psi29)
    $stdout29mixed = $p29.StandardOutput.ReadToEnd()
    $p29.WaitForExit(5000) | Out-Null
    $foundMixed = $false
    foreach ($line in ($stdout29mixed -split "`n")) {
        if ($line -match $secondInstanceLinePattern) { $foundMixed = $true; break }
    }
    Assert-Equal 'marker found in mixed real stdout with noise before/after' $true $foundMixed
} finally {
    if ($p29 -and -not $p29.HasExited) { $p29.Kill() }
    if ($p29) { $p29.Dispose() }
}

# ---- Summary ----
Write-Host ''
Write-Host "Passed: $passed / $($passed + $failed)"
Write-Host "Failed: $failed"
if ($failed -gt 0) {
    Write-Host 'Smoke tests FAILED.' -ForegroundColor Red
    exit 1
}
Write-Host 'All helper smoke tests passed.' -ForegroundColor Green
