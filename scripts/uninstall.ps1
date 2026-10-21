#Requires -Version 5.1
<#
.SYNOPSIS
    Remove the dsh-nudge plugin from a DSH profile.

.DESCRIPTION
    Reverses install.ps1: drops the "file:" dependency and the
    dsh.profile.bundles entry from the profile package.json.

    Idempotent: an unregistered profile is left unchanged. A timestamped backup
    is written before any change and restored automatically if the update fails.
    The script never restarts DSH.

.PARAMETER ProfileDir
    DSH profile directory. Defaults to %DSH_HOME%\profiles\desktop.

.PARAMETER DryRun
    Print the planned changes and exit without writing anything.

.PARAMETER SkipPnpm
    Only edit package.json and leave node_modules alone.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = (Join-Path $env:DSH_HOME 'profiles\desktop'),
    [switch]$DryRun,
    [switch]$SkipPnpm
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-nudge'

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message"
}

if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
    throw 'profile directory not given and DSH_HOME is not set; pass -ProfileDir'
}
$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "not a DSH profile (no package.json): $ProfileDir"
}
Write-Step "profile: $ProfileDir"

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$hasDependency = $null -ne $manifest.dependencies -and $null -ne $manifest.dependencies.PSObject.Properties[$packageName]
$bundles = @()
if ($null -ne $manifest.dsh -and $null -ne $manifest.dsh.profile -and $null -ne $manifest.dsh.profile.bundles) {
    $bundles = @($manifest.dsh.profile.bundles)
}
$hasBundle = $bundles -contains $packageName

if (-not $hasDependency -and -not $hasBundle) {
    Write-Step 'not installed -- nothing to do'
    exit 0
}

Write-Step "dependency present: $hasDependency"
Write-Step "bundle entry present: $hasBundle"

if ($DryRun) {
    Write-Step 'dry run -- no files were written'
    exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = "$manifestPath.bak-$stamp"
Copy-Item -LiteralPath $manifestPath -Destination $backupPath -Force
Write-Step "backup: $backupPath"

try {
    if ($hasDependency) {
        $manifest.dependencies.PSObject.Properties.Remove($packageName)
    }
    if ($hasBundle) {
        $manifest.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $packageName })
    }
    $json = $manifest | ConvertTo-Json -Depth 12
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, $utf8NoBom)
} catch {
    Copy-Item -LiteralPath $backupPath -Destination $manifestPath -Force
    throw "uninstall failed, package.json restored from backup: $($_.Exception.Message)"
}

$check = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (@($check.dsh.profile.bundles) -contains $packageName) {
    Copy-Item -LiteralPath $backupPath -Destination $manifestPath -Force
    throw 'uninstall failed verification, package.json restored from backup'
}

Write-Step 'uninstalled'

# ---- prune node_modules with the pnpm that ships inside DSH ----
if ($SkipPnpm) {
    Write-Step 'pnpm skipped (-SkipPnpm)'
    Write-Host "Run this before starting DSH: pnpm install --dir `"$ProfileDir`""
} else {
    $runtime = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $null } else { Join-Path $env:DSH_HOME 'dsh-runtimes\dsh-primary-runtime\dependencies' }
    $nodeEntry = if ($null -eq $runtime) { $null } else { Join-Path $runtime 'node\bin\node.exe' }
    $pnpmEntry = if ($null -eq $runtime) { $null } else { Join-Path $runtime 'pnpm\bin\pnpm.cjs' }
    if ($null -ne $pnpmEntry -and (Test-Path -LiteralPath $pnpmEntry) -and (Test-Path -LiteralPath $nodeEntry)) {
        Write-Step 'pnpm install (prune)'
        $pnpmOutput = & $nodeEntry $pnpmEntry install --dir $ProfileDir 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host (($pnpmOutput | Select-Object -Last 10) -join [Environment]::NewLine)
            Write-Host "pnpm install failed; package.json is already updated (backup: $backupPath)"
            Write-Host "Run manually after quitting DSH: pnpm install --dir `"$ProfileDir`""
        } else {
            Write-Step "node_modules pruned"
        }
    } else {
        Write-Host "Bundled pnpm not found; run this after quitting DSH: pnpm install --dir `"$ProfileDir`""
    }
}

Write-Host ''
Write-Host 'Restart DeepSeek Harness to unload the plugin.'
Write-Host "Rollback: copy $backupPath back over package.json."
