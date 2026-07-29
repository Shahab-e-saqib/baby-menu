<#
.SYNOPSIS
  Smoke test for New-DirectoryManifest and Compare-DirectoryManifest helpers.
  Compatible with Windows PowerShell 5.1 and PowerShell 7+.
.DESCRIPTION
  Creates temporary directory trees with known content, generates manifests,
  and exercises Compare-DirectoryManifest in 12 scenarios including edge
  cases for SHA256 presence mismatch, type consistency, and real I/O.
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

# ---- Summary ----
Write-Host ''
Write-Host "Passed: $passed / $($passed + $failed)"
Write-Host "Failed: $failed"
if ($failed -gt 0) {
    Write-Host 'Smoke tests FAILED.' -ForegroundColor Red
    exit 1
}
Write-Host 'All helper smoke tests passed.' -ForegroundColor Green
