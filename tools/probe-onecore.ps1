# Probe: can PowerShell 5.1 use the OneCore (WinRT) speech engine, and what voices
# does it expose? SAPI5 (System.Speech) only sees the old Huihui-class voices; OneCore
# carries the newer ones (Xiaoxiao / Yunxi / Yunjian ...), which sound far less robotic.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI, so any
# literal CJK here would corrupt the script (that is also why lib/popup.ps1 is ASCII and
# takes all Chinese text from the UTF-8 JSON payload).
$ErrorActionPreference = 'Continue'

Write-Host '=== SAPI5 voices (System.Speech) ==='
try {
    Add-Type -AssemblyName System.Speech -ErrorAction Stop
    $sapi = New-Object System.Speech.Synthesis.SpeechSynthesizer
    foreach ($v in $sapi.GetInstalledVoices()) {
        Write-Host ('  ' + $v.VoiceInfo.Name + '  [' + $v.VoiceInfo.Culture + ']')
    }
    $sapi.Dispose()
} catch {
    Write-Host ('  SAPI5 failed: ' + $_.Exception.Message)
}

Write-Host ''
Write-Host '=== OneCore voices (Windows.Media.SpeechSynthesis) ==='
$oneCore = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    [void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType = WindowsRuntime]
    $voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
    Write-Host ('  count = ' + $voices.Count)
    foreach ($v in $voices) {
        Write-Host ('  ' + $v.DisplayName + ' | ' + $v.Language + ' | ' + $v.Id)
    }
    $oneCore = $voices
} catch {
    Write-Host ('  OneCore enumeration failed: ' + $_.Exception.Message)
}

if ($null -eq $oneCore -or $oneCore.Count -eq 0) {
    Write-Host ''
    Write-Host 'RESULT: no OneCore voices'
    exit 1
}

Write-Host ''
Write-Host '=== Synthesize a short clip with the first Chinese OneCore voice ==='
$target = $oneCore | Where-Object { $_.Language -like 'zh*' } | Select-Object -First 1
if ($null -eq $target) { $target = $oneCore[0] }
Write-Host ('  voice: ' + $target.DisplayName)

try {
    $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
    $synth.Voice = $target
    # Await a WinRT IAsyncOperation<T> from PowerShell 5.1: grab the generic AsTask.
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
    # ASCII text on purpose (see the header): the engine is what is being probed here.
    $op = $synth.SynthesizeTextToStreamAsync('Task completed. Build script finished.')
    $task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($op))
    [void]$task.Wait(15000)
    $stream = $task.Result
    $size = [int]$stream.Size
    Write-Host ('  stream size = ' + $size + ' bytes')
    $out = Join-Path $env:TEMP 'onecore-probe.wav'
    $reader = New-Object Windows.Storage.Streams.DataReader $stream.GetInputStreamAt(0)
    $loadOp = $reader.LoadAsync([uint32]$size)
    $loadTask = $asTask.MakeGenericMethod([uint32]).Invoke($null, @($loadOp))
    [void]$loadTask.Wait(15000)
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    [System.IO.File]::WriteAllBytes($out, $bytes)
    Write-Host ('  wrote ' + $out + ' bytes=' + (Get-Item $out).Length)
    Write-Host 'RESULT: OneCore OK'
    exit 0
} catch {
    Write-Host ('  synthesize failed: ' + $_.Exception.Message)
    Write-Host 'RESULT: OneCore enumerate-only'
    exit 2
}
