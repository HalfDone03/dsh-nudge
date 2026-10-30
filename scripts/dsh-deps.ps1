#Requires -Version 5.1
<#
    Shared helper for install.ps1 / uninstall.ps1: locate the node + pnpm pair
    that ships inside DSH.

    DSH bundles its own node and pnpm so these scripts never need one on PATH,
    but the layout moved between builds:

        desktop app:      <install root>\resources\runtime\primary-runtime\dependencies
        portable / older: %DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies
        older still:      %DSH_HOME%\dsh-runtimes\primary-runtime\dependencies

    Instead of trusting one hard-coded path we derive install roots from
    DSH_NUDGE_INSTALL_ROOT, the running app's own executable, and the uninstall
    registry keys, then probe every plausible layout under each of them.

    Dot-source it; the file only defines functions.
#>

function Test-DependenciesRoot {
    param([string]$Root)
    if ([string]::IsNullOrWhiteSpace($Root)) { return $null }
    $nodeCandidate = Join-Path $Root 'node\bin\node.exe'
    $pnpmCandidate = Join-Path $Root 'pnpm\bin\pnpm.cjs'
    if ((Test-Path -LiteralPath $nodeCandidate) -and (Test-Path -LiteralPath $pnpmCandidate)) {
        return [pscustomobject]@{ Node = $nodeCandidate; Pnpm = $pnpmCandidate; Root = $Root }
    }
    return $null
}

function Get-DshInstallRoots {
    $roots = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_NUDGE_INSTALL_ROOT)) { $roots.Add($env:DSH_NUDGE_INSTALL_ROOT) }

    # 1. the running app knows where it lives; match on the name prefix because the
    #    desktop build puts a space in its process name ("DeepSeek Runtime")
    foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(DeepSeek|dsh)' })) {
        try {
            if (-not [string]::IsNullOrWhiteSpace($proc.Path)) { $roots.Add((Split-Path -Parent $proc.Path)) }
        } catch { }
    }

    # 2. the installer recorded the location in an uninstall key
    foreach ($key in @(
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
        )) {
        foreach ($item in @(Get-ItemProperty $key -ErrorAction SilentlyContinue)) {
            if (-not ($item.DisplayName -match '^(DeepSeek|DSH)')) { continue }
            if (-not [string]::IsNullOrWhiteSpace($item.InstallLocation)) { $roots.Add($item.InstallLocation) }
            if (-not [string]::IsNullOrWhiteSpace($item.DisplayIcon)) {
                $roots.Add((Split-Path -Parent ($item.DisplayIcon -replace ',\s*-?\d+\s*$', '')))
            }
        }
    }
    return $roots
}

function Get-DshDependencyCandidates {
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($root in @(Get-DshInstallRoots)) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $candidates.Add((Join-Path $root 'resources\runtime\primary-runtime\dependencies'))
        $candidates.Add((Join-Path $root 'runtime\primary-runtime\dependencies'))
        $candidates.Add((Join-Path $root 'resources\runtime\dsh-primary-runtime\dependencies'))
        $candidates.Add((Join-Path $root 'dsh-runtimes\dsh-primary-runtime\dependencies'))
    }
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
        $candidates.Add((Join-Path $env:DSH_HOME 'dsh-runtimes\dsh-primary-runtime\dependencies'))
        $candidates.Add((Join-Path $env:DSH_HOME 'dsh-runtimes\primary-runtime\dependencies'))
    }
    return $candidates
}

function Find-DshDependencies {
    <#
        Returns the first node + pnpm pair that exists as
        [pscustomobject]@{ Node; Pnpm; Root }, or $null when nothing matches.
        Get-DshDependencyCandidates lists what was probed (for error messages).
    #>
    foreach ($dir in @(Get-DshDependencyCandidates)) {
        $found = Test-DependenciesRoot $dir
        if ($null -ne $found) { return $found }
    }
    return $null
}

function Get-DshPnpmOnPath {
    return @(Get-Command 'pnpm' -CommandType Application -ErrorAction SilentlyContinue) | Select-Object -First 1
}
