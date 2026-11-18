#Requires -Version 5.1
<#
.SYNOPSIS
    Render the preset voice clips the nudge card can play.

.DESCRIPTION
    The card can speak through Windows' built-in SAPI voices, but those are the 2009
    concatenative ones (Microsoft Huihui on a Chinese system) and sound robotic. The
    "preset" source plays short sentences rendered ahead of time by a neural voice
    instead - which is why they sound like a person.

    The clips are NOT shipped in the package: the audio comes from Microsoft's neural
    voices and redistributing it is not something this project should do. So this script
    renders them on YOUR machine, into your own data directory:

        %LOCALAPPDATA%\dsh-nudge\voices\<voice>\<kind>.mp3

    It needs edge-tts (the same engine the dsh-voice plugin uses). If it is missing the
    script prints how to install it and exits 1 without touching anything.

.PARAMETER Voice
    Which voice sets to render. Default: xiaoxiao, yunxi, xiaoyi.

.PARAMETER Force
    Re-render clips that already exist.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\make-voice-presets.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\make-voice-presets.ps1 -Voice xiaoxiao -Force
#>
[CmdletBinding()]
param(
    [string[]]$Voice = @('xiaoxiao', 'yunxi', 'xiaoyi'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# voice key -> edge-tts voice id
$voiceIds = @{
    xiaoxiao = 'zh-CN-XiaoxiaoNeural'
    yunxi    = 'zh-CN-YunxiNeural'
    xiaoyi   = 'zh-CN-XiaoyiNeural'
}

# kind -> what gets spoken. Keep them short: a reminder should not talk for ten seconds.
$phrases = [ordered]@{
    completed    = '任务完成了'
    needs_choice = '需要你选一下'
    failed       = '执行失败了'
}

function Write-Step([string]$text) { Write-Host "==> $text" }
function Write-Next([string]$text) { Write-Host "    $text" }

# ---- where the clips live: same rule as lib/index.js presetVoiceDir() ----
$base = $env:LOCALAPPDATA
if ([string]::IsNullOrWhiteSpace($base)) {
    Write-Step 'LOCALAPPDATA is not set; cannot decide where to put the clips'
    exit 1
}
$root = Join-Path (Join-Path $base 'dsh-nudge') 'voices'
Write-Step "clips go to $root"

# ---- nothing to do when every clip is already there (and -Force was not asked) ----
if (-not $Force) {
    $missing = @()
    foreach ($key in $Voice) {
        if (-not $voiceIds.ContainsKey($key)) { continue }
        foreach ($kind in $phrases.Keys) {
            if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $root $key) ($kind + '.mp3')))) {
                $missing += ($key + '/' + $kind)
            }
        }
    }
    if ($missing.Count -eq 0) {
        Write-Step 'all requested clips are already there -- nothing to do'
        Write-Next 'Use -Force to render them again.'
        exit 0
    }
}

# ---- find edge-tts: python -m edge_tts first, then the CLI on PATH ----
$runner = $null
$python = Get-Command python -ErrorAction SilentlyContinue
if ($null -ne $python) {
    # python prints the traceback on stderr; with $ErrorActionPreference = 'Stop' the
    # first stderr line becomes a terminating NativeCommandError, so relax it here and
    # judge by exit code only.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $probe = & $python.Source -c "import edge_tts; print('ok')" 2>&1
        $probeOk = ($LASTEXITCODE -eq 0) -and ("$probe" -match 'ok')
    } catch {
        $probeOk = $false
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($probeOk) {
        $runner = @{ Kind = 'module'; Exe = $python.Source }
    }
}
if ($null -eq $runner) {
    $cli = Get-Command edge-tts -ErrorAction SilentlyContinue
    if ($null -ne $cli) { $runner = @{ Kind = 'cli'; Exe = $cli.Source } }
}
if ($null -eq $runner) {
    Write-Step 'edge-tts not found -- nothing was written'
    Write-Next 'Install it with:  python -m pip install edge-tts'
    Write-Next 'Then run this script again. The card keeps working without it:'
    Write-Next 'preset clips that are missing simply fall back to the system voice.'
    exit 1
}
Write-Step "edge-tts: $($runner.Kind) ($($runner.Exe))"

# ---- render ----
New-Item -ItemType Directory -Path $root -Force | Out-Null
$made = 0
$skipped = 0
$failed = 0

foreach ($key in $Voice) {
    if (-not $voiceIds.ContainsKey($key)) {
        Write-Step "unknown voice '$key' (expected: $($voiceIds.Keys -join ', '))"
        $failed += 1
        continue
    }
    $voiceId = $voiceIds[$key]
    $dir = Join-Path $root $key
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    foreach ($kind in $phrases.Keys) {
        $target = Join-Path $dir ($kind + '.mp3')
        if ((Test-Path -LiteralPath $target) -and -not $Force) {
            $skipped += 1
            continue
        }
        $text = $phrases[$kind]
        try {
            if ($runner.Kind -eq 'module') {
                & $runner.Exe -m edge_tts --voice $voiceId --text $text --write-media $target 2>$null | Out-Null
            } else {
                & $runner.Exe --voice $voiceId --text $text --write-media $target 2>$null | Out-Null
            }
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $target)) { throw 'edge-tts failed' }
            $size = (Get-Item -LiteralPath $target).Length
            Write-Next ("{0}/{1}.mp3  {2} bytes" -f $key, $kind, $size)
            $made += 1
        } catch {
            Write-Next ("{0}/{1}.mp3  FAILED: {2}" -f $key, $kind, $_.Exception.Message)
            $failed += 1
        }
    }
}

Write-Step "done: $made rendered, $skipped already there, $failed failed"
Write-Next 'In the plugin: 设置 → 提醒弹窗 → 语音 → 声音来源 = 预制语音'
if ($failed -gt 0) { exit 1 }
exit 0
