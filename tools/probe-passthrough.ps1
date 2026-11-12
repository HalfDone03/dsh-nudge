# Real-machine probe: prove that a clickThrough card really cannot be clicked.
#
# Checking the extended style bits alone is not enough (whether WS_EX_TRANSPARENT
# actually wins depends on the window being layered and on WPF not painting over
# it). So ask the system directly with WindowFromPoint: the point in the middle of
# the card must resolve to whatever is BEHIND the card, not to the card.
#
# Usage: powershell -File tools/probe-passthrough.ps1
# Shows three cards in turn (plain / through / no-jump), checks each, closes it.
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
    [string]$Script = (Join-Path (Split-Path -Parent $PSScriptRoot) 'lib/popup.ps1')
)

$ErrorActionPreference = 'Stop'

if (-not ('Probe.Native' -as [type])) {
    Add-Type -Namespace Probe -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
'@
}

function Get-WindowsOf {
    param([int]$ProcessId)
    $found = New-Object System.Collections.ArrayList
    $callback = [Probe.Native+EnumProc] {
        param($hwnd, $lparam)
        $owner = 0
        [void][Probe.Native]::GetWindowThreadProcessId($hwnd, [ref]$owner)
        if ($owner -eq $ProcessId -and [Probe.Native]::IsWindowVisible($hwnd)) { [void]$found.Add($hwnd) }
        return $true
    }
    [void][Probe.Native]::EnumWindows($callback, [IntPtr]::Zero)
    return $found
}

function New-Payload {
    param([bool]$ClickThrough, [bool]$ClickToFocus)
    # The footer text is irrelevant here (the host computes it), so keep it ASCII.
    return @{
        kind = 'completed'; label = 'done'; accent = '#2ECC71'; glyph = 'v'; count = 1
        items = @(); headline = 'passthrough probe'; headlineTint = '#2ECC71'; verdictKind = 'done'; verdictText = ''
        context = 'dsh-nudge'; summary = 'passthrough probe'; overflow = 0; more = ''; footer = 'probe'
        clickToFocus = $ClickToFocus; clickThrough = $ClickThrough
        clipboardHeader = 'probe'
        theme = 'dark'; anchor = 'bottom-right'; width = 384; rememberPosition = $false
        at = (Get-Date).ToString('HH:mm')
    }
}

function Invoke-Probe {
    param([bool]$ClickThrough, [bool]$ClickToFocus)
    $json = New-Payload -ClickThrough $ClickThrough -ClickToFocus $ClickToFocus | ConvertTo-Json -Compress -Depth 6
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $out = Join-Path $env:TEMP ("nudge-probe-{0}.log" -f [guid]::NewGuid().ToString('n'))
    $proc = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', $Script, '-PayloadB64', $b64, '-StaySeconds', '25', '-Margin', '16',
        '-DsProcess', 'DeepSeek Harness'
    ) -RedirectStandardOutput $out

    $hwnd = [IntPtr]::Zero
    for ($i = 0; $i -lt 60 -and $hwnd -eq [IntPtr]::Zero; $i++) {
        Start-Sleep -Milliseconds 100
        $windows = Get-WindowsOf -ProcessId $proc.Id
        if ($windows.Count -gt 0) { $hwnd = $windows[0] }
    }
    if ($hwnd -eq [IntPtr]::Zero) {
        try { $proc.Kill() } catch { }
        throw ("probe window never appeared (pid {0})" -f $proc.Id)
    }
    # 180ms fade-in, then give the layout one more beat.
    Start-Sleep -Milliseconds 700

    $rect = New-Object 'Probe.Native+RECT'
    [void][Probe.Native]::GetWindowRect($hwnd, [ref]$rect)
    $point = New-Object 'Probe.Native+POINT'
    $point.X = [int](($rect.Left + $rect.Right) / 2)
    $point.Y = [int](($rect.Top + $rect.Bottom) / 2)
    $hit = [Probe.Native]::WindowFromPoint($point)
    $ex = [Probe.Native]::GetWindowLong($hwnd, -20)

    $status = (Get-Content -LiteralPath $out -ErrorAction SilentlyContinue | Where-Object { $_ -match '"type"' }) -join ' | '
    $result = [pscustomobject][ordered]@{
        clickThrough = $ClickThrough
        clickToFocus = $ClickToFocus
        hwnd         = $hwnd.ToInt64()
        exStyle      = ('0x{0:X8}' -f $ex)
        transparent  = [bool]($ex -band 0x00000020)
        layered      = [bool]($ex -band 0x00080000)
        noActivate   = [bool]($ex -band 0x08000000)
        center       = ("{0},{1}" -f $point.X, $point.Y)
        hitHwnd      = $hit.ToInt64()
        hitIsCard    = ($hit -eq $hwnd)
        passedThru   = ($hit -ne $hwnd)
        status       = $status
    }

    try { $proc.Kill() } catch { }
    Start-Sleep -Milliseconds 300
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    return $result
}

$plain = Invoke-Probe -ClickThrough $false -ClickToFocus $true
$thru = Invoke-Probe -ClickThrough $true -ClickToFocus $true
$nojump = Invoke-Probe -ClickThrough $false -ClickToFocus $false

$plain, $thru, $nojump | Format-List

$ok = ($plain.hitIsCard -eq $true) -and
    ($thru.passedThru -eq $true) -and ($thru.transparent -eq $true) -and ($thru.layered -eq $true) -and
    ($plain.transparent -eq $false) -and ($nojump.transparent -eq $false)
if (-not $ok) { Write-Host 'PROBE FAILED' -ForegroundColor Red; exit 1 }
Write-Host 'PROBE OK: plain card keeps the click; click-through card resolves to the window behind it.' -ForegroundColor Green
exit 0
