#Requires -Version 5.1
<#
.SYNOPSIS
    Install the dsh-nudge plugin into a DSH profile.

.DESCRIPTION
    Three steps, all reversible:
      1. register the bundle in the profile package.json
         (a "file:" dependency plus an entry in dsh.profile.bundles)
      2. materialise node_modules with the pnpm that ships inside DSH, so the
         Host loader can resolve the package by name
      3. verify that node_modules\<package>\package.json is readable

    The script never edits the profile's cordis.patch.yml (that file holds
    deployment secrets) and never restarts DSH. Quit DeepSeek Harness before
    running it: pnpm rewrites node_modules and fails on files the app holds open.

    Safe to run repeatedly. A timestamped backup of package.json is written
    before any change and restored automatically if the update fails.

.PARAMETER ProfileDir
    DSH profile directory. Defaults to %DSH_HOME%\profiles\desktop.

.PARAMETER DryRun
    Print the planned changes and exit without writing anything.

.PARAMETER SkipPnpm
    Only edit package.json and leave node_modules alone.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DryRun

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = (Join-Path $env:DSH_HOME 'profiles\desktop'),
    [switch]$DryRun,
    [switch]$SkipPnpm
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-nudge'
$packageRoot = Split-Path -Parent $PSScriptRoot

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message"
}

function Write-Next {
    param([string]$Message)
    Write-Host "    $Message"
}

# ---- 1. validate the package itself ----
foreach ($relative in @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\popup.ps1')) {
    $full = Join-Path $packageRoot $relative
    if (-not (Test-Path -LiteralPath $full)) {
        throw "package is incomplete: missing $full"
    }
}
Write-Step "package: $packageRoot"

# ---- 2. validate the profile ----
if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
    throw 'profile directory not given and DSH_HOME is not set; pass -ProfileDir'
}
$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "not a DSH profile (no package.json): $ProfileDir"
}
Write-Step "profile: $ProfileDir"

# ---- 3. read + plan ----
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $manifest.dependencies) {
    $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $manifest.dsh -or $null -eq $manifest.dsh.profile) {
    throw "profile manifest has no dsh.profile section: $manifestPath"
}
if ($null -eq $manifest.dsh.profile.bundles) {
    $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}

$dependencySpec = 'file:' + ($packageRoot -replace '\\', '/')
$existingDependency = $manifest.dependencies.PSObject.Properties[$packageName]
$bundles = @($manifest.dsh.profile.bundles)
$hasBundle = $bundles -contains $packageName
$linked = Test-Path -LiteralPath (Join-Path $ProfileDir "node_modules\$packageName\package.json")

$needsDependency = ($null -eq $existingDependency) -or ($existingDependency.Value -ne $dependencySpec)
$needsBundle = -not $hasBundle

Write-Step "dependency: $packageName -> $dependencySpec"
Write-Step "bundle list: $(if ($needsBundle) { 'append' } else { 'unchanged' })"
Write-Step "node_modules: $(if ($linked) { 'already present' } else { 'needs pnpm install' })"

if (-not $needsDependency -and -not $needsBundle -and ($linked -or $SkipPnpm)) {
    Write-Step 'already installed -- nothing to do'
    Write-Host ''
    Write-Host "Plugin '$packageName' is registered. Restart DeepSeek Harness if it is not running yet."
    exit 0
}

if ($DryRun) {
    Write-Step 'dry run -- no files were written, pnpm was not started'
    exit 0
}

# ---- 4. backup, then edit package.json ----
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = "$manifestPath.bak-$stamp"
Copy-Item -LiteralPath $manifestPath -Destination $backupPath -Force
Write-Step "backup: $backupPath"

try {
    if ($needsDependency) {
        $manifest.dependencies | Add-Member -NotePropertyName $packageName -NotePropertyValue $dependencySpec -Force
    }
    if ($needsBundle) {
        $manifest.dsh.profile.bundles = @($bundles + $packageName)
    }
    $json = $manifest | ConvertTo-Json -Depth 12
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, $utf8NoBom)
} catch {
    Copy-Item -LiteralPath $backupPath -Destination $manifestPath -Force
    throw "install failed, package.json restored from backup: $($_.Exception.Message)"
}

$check = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not (@($check.dsh.profile.bundles) -contains $packageName)) {
    Copy-Item -LiteralPath $backupPath -Destination $manifestPath -Force
    throw 'install failed verification, package.json restored from backup'
}
Write-Step 'package.json updated'

# ---- 5. materialise node_modules with the pnpm DSH ships ----
if ($SkipPnpm) {
    Write-Step 'pnpm skipped (-SkipPnpm)'
    Write-Next "Run this before starting DSH: pnpm install --dir `"$ProfileDir`""
    exit 0
}

$runtime = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $null } else { Join-Path $env:DSH_HOME 'dsh-runtimes\dsh-primary-runtime\dependencies' }
$nodeEntry = if ($null -eq $runtime) { $null } else { Join-Path $runtime 'node\bin\node.exe' }
$pnpmEntry = if ($null -eq $runtime) { $null } else { Join-Path $runtime 'pnpm\bin\pnpm.cjs' }

if ($null -eq $pnpmEntry -or -not (Test-Path -LiteralPath $pnpmEntry) -or -not (Test-Path -LiteralPath $nodeEntry)) {
    Write-Step 'bundled pnpm not found'
    Write-Next 'Run this before starting DSH (needs a pnpm on PATH):'
    Write-Next "  pnpm install --dir `"$ProfileDir`""
    exit 0
}

Write-Step 'pnpm install (bundled pnpm)'
$pnpmOutput = & $nodeEntry $pnpmEntry install --dir $ProfileDir 2>&1
$pnpmCode = $LASTEXITCODE
if ($pnpmCode -ne 0) {
    $tail = ($pnpmOutput | Select-Object -Last 15) -join [Environment]::NewLine
    Write-Host $tail
    throw "pnpm install failed (exit $pnpmCode). Quit DeepSeek Harness and retry; package.json is already updated (backup: $backupPath)."
}

# ---- 6. verify the link the loader will resolve ----
$resolved = Join-Path $ProfileDir "node_modules\$packageName\package.json"
if (-not (Test-Path -LiteralPath $resolved)) {
    throw "pnpm finished but $resolved is missing; the Host loader would not find the plugin"
}
$linkedManifest = Get-Content -LiteralPath $resolved -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Step "linked: node_modules\$packageName (version $($linkedManifest.version))"

Write-Step 'installed'
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Start DeepSeek Harness (the plugin runs inside the Host process).'
Write-Host '  2. Run a session turn; the card should appear above the taskbar, bottom right.'
Write-Host '  3. If nothing shows up, see VERIFY.md.'
Write-Host ''
Write-Host "Rollback: copy $backupPath back over package.json, then rerun pnpm install."
