# Real-machine probe: the card has no per-block dragging left, and its content
# reflows with the window size (the only thing the user can still change).
#
# 1) show a card, list every window handle it owns -> only one (the card itself)
# 2) read its rect, then set two widths through SetWindowPos and compare heights:
#    a narrower card must wrap more lines and end up TALLER than a wide one.
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
    [string]$Script = (Join-Path (Split-Path -Parent $PSScriptRoot) 'lib/popup.ps1')
)

$ErrorActionPreference = 'Stop'

if (-not ('Probe3.Native' -as [type])) {
    Add-Type -Namespace Probe3 -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
'@
}

function Get-WindowsOf {
    param([int]$ProcessId)
    $found = New-Object System.Collections.ArrayList
    $callback = [Probe3.Native+EnumProc] {
        param($hwnd, $lparam)
        $owner = 0
        [void][Probe3.Native]::GetWindowThreadProcessId($hwnd, [ref]$owner)
        if ($owner -eq $ProcessId -and [Probe3.Native]::IsWindowVisible($hwnd)) { [void]$found.Add($hwnd) }
        return $true
    }
    [void][Probe3.Native]::EnumWindows($callback, [IntPtr]::Zero)
    return $found
}

# A long detail makes the wrapping visible: at 260 wide it needs many more lines
# than at 520, so the measured height has to grow when the card is narrowed.
$payload = @{
    kind = 'failed'; label = 'failed'; accent = '#E74C3C'; glyph = 'x'; count = 1
    items = @()
    headline = 'reflow probe with a headline long enough to wrap on a narrow card'
    headlineTint = '#E74C3C'; verdictKind = 'failed'
    verdictText = 'vite build exited with code 1 while resolving the entry module of the desktop bundle'
    context = 'dsh-nudge'; summary = 'reflow probe'; overflow = 0; more = ''
    footer = 'probe'
    clickToFocus = $true; clickThrough = $false
    clipboardHeader = 'probe'
    theme = 'dark'; anchor = 'bottom-right'; width = 384; rememberPosition = $false
    at = (Get-Date).ToString('HH:mm')
}
$json = $payload | ConvertTo-Json -Compress -Depth 6
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
$out = Join-Path $env:TEMP ("nudge-reflow-{0}.log" -f [guid]::NewGuid().ToString('n'))

$proc = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
    '-File', $Script, '-PayloadB64', $b64, '-StaySeconds', '60', '-Margin', '16',
    '-DsProcess', 'DeepSeek Harness'
) -RedirectStandardOutput $out

$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 60 -and $hwnd -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 100
    $windows = Get-WindowsOf -ProcessId $proc.Id
    if ($windows.Count -gt 0) { $hwnd = $windows[0] }
}
if ($hwnd -eq [IntPtr]::Zero) { try { $proc.Kill() } catch { }; throw 'card never appeared' }

$windowCount = (Get-WindowsOf -ProcessId $proc.Id).Count
Start-Sleep -Milliseconds 900

$rect = New-Object 'Probe3.Native+RECT'
[void][Probe3.Native]::GetWindowRect($hwnd, [ref]$rect)

function Measure-At {
    param([int]$Width)
    # SWP_NOMOVE(0x2) | SWP_NOZORDER(0x4) | SWP_NOACTIVATE(0x10); size is NOT ignored.
    [void][Probe3.Native]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, $Width, 0, 0x0002 -bor 0x0004 -bor 0x0010)
    Start-Sleep -Milliseconds 450
    $r = New-Object 'Probe3.Native+RECT'
    [void][Probe3.Native]::GetWindowRect($hwnd, [ref]$r)
    return [pscustomobject]@{ width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
}

$sweep = @()
foreach ($w in 560, 480, 400, 340, 300, 260) { $sweep += Measure-At -Width $w }
$wide = $sweep[0]
$narrow = $sweep[-1]
$again = Measure-At -Width 560

try { $proc.Kill() } catch { }
Start-Sleep -Milliseconds 250
$status = (Get-Content -LiteralPath $out -ErrorAction SilentlyContinue | Where-Object { $_ -match '"type"' }) -join ' | '
Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue

$result = [pscustomobject][ordered]@{
    windowsOwned = $windowCount
    sweep        = (($sweep | ForEach-Object { "{0}x{1}" -f $_.width, $_.height }) -join "  ")
    distinctHeights = (@($sweep | ForEach-Object { $_.height } | Sort-Object -Unique)).Count
    at560        = ("{0}x{1}" -f $wide.width, $wide.height)
    at260        = ("{0}x{1}" -f $narrow.width, $narrow.height)
    at560again   = ("{0}x{1}" -f $again.width, $again.height)
    backToSameHeight = ($again.height -eq $wide.height)
    status       = $status
}
$result | Format-List

# Height must react to width (a fixed height would mean the card just clips or
# stretches), and the same width must always give the same height back.
if ($result.windowsOwned -eq 1 -and $result.distinctHeights -ge 3 -and $result.backToSameHeight) {
    Write-Host 'PROBE OK: one window only; height follows width (>=3 distinct heights) and is deterministic.' -ForegroundColor Green
    exit 0
}
Write-Host 'PROBE FAILED' -ForegroundColor Red
exit 1
