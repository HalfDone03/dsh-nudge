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

    It also removes a node_modules\dsh-nudge junction left behind by the old
    install script: pnpm never recorded that entry, so `pnpm install` and the
    plugin manager both leave it pointing at the source directory.

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
    . (Join-Path $PSScriptRoot 'dsh-deps.ps1')
    $bundled = Find-DshDependencies
    $pathPnpm = Get-DshPnpmOnPath
    $pnpmExe = $null
    $pnpmArgs = @()
    if ($null -ne $bundled) {
        Write-Step "pnpm install (prune, bundled pnpm: $($bundled.Root))"
        $pnpmExe = $bundled.Node
        $pnpmArgs = @($bundled.Pnpm, 'install', '--dir', $ProfileDir)
    }
    elseif ($null -ne $pathPnpm) {
        Write-Step "pnpm install (prune, pnpm from PATH: $($pathPnpm.Source))"
        $pnpmExe = $pathPnpm.Source
        $pnpmArgs = @('install', '--dir', $ProfileDir)
    }
    else {
        Write-Host 'No bundled pnpm and none on PATH -- node_modules left untouched.'
        Write-Host 'Leftovers there are harmless: dsh.profile.bundles decides what DSH loads.'
        Write-Host "Run this after quitting DSH if you want it pruned: pnpm install --dir `"$ProfileDir`""
    }
    if ($null -ne $pnpmExe) {
        # see install.ps1: PS 5.1 turns the first stderr line into a terminating
        # NativeCommandError under 'Stop', so judge the result by the exit code
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $pnpmOutput = & $pnpmExe @pnpmArgs 2>&1 }
        finally { $ErrorActionPreference = $previousEap }
        if ($LASTEXITCODE -ne 0) {
            Write-Host (($pnpmOutput | Select-Object -Last 10) -join [Environment]::NewLine)
            Write-Host "pnpm install failed; package.json is already updated (backup: $backupPath)"
            Write-Host "Run manually after quitting DSH: pnpm install --dir `"$ProfileDir`""
        }
        else {
            Write-Step 'node_modules pruned'
        }
    }
}

# ---- drop the junction pnpm never knew about ----
# The old install script linked node_modules\dsh-nudge straight at the source
# checkout. pnpm has no record of that entry (not in pnpm-lock.yaml, not in
# .modules.yaml), so `pnpm install` ignores it and the plugin manager cannot
# see it either -- the link stays behind pointing at the repo. Remove the link
# only: [System.IO.Directory]::Delete without recursion never touches the target.
if ($SkipPnpm) {
    Write-Step 'node_modules left alone (-SkipPnpm)'
}
else {
    $modulesDir = Join-Path $ProfileDir 'node_modules'
    $linkItem = $null
    if (Test-Path -LiteralPath $modulesDir) {
        $linkItem = @(Get-ChildItem -LiteralPath $modulesDir -Filter $packageName -Force -ErrorAction SilentlyContinue) |
            Select-Object -First 1
    }
    if ($null -eq $linkItem) {
        Write-Step 'node_modules: no leftover entry'
    }
    elseif (($linkItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        Write-Step 'node_modules: real directory left alone'
    }
    else {
        try {
            [System.IO.Directory]::Delete($linkItem.FullName, $false)
            Write-Step 'node_modules: manual junction removed'
        }
        catch {
            Write-Host "Could not remove $($linkItem.FullName): $($_.Exception.Message)"
            Write-Host 'Delete that link by hand if DSH complains -- it points at the plugin source.'
        }
    }
}

Write-Host ''
Write-Host 'Restart DeepSeek Harness to unload the plugin.'
Write-Host "Rollback: copy $backupPath back over package.json."
