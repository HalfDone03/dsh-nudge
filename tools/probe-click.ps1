# Real-machine probe: a "no jump" card must close on click without focusing anything.
#
# Posts WM_LBUTTONDOWN / WM_LBUTTONUP into the card window (no real mouse movement,
# no focus stealing by the probe itself), then reads the helper's status line:
#   reason=clicked-nojump, clipboard=false, and the foreground window unchanged.
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
    [string]$Script = (Join-Path (Split-Path -Parent $PSScriptRoot) 'lib/popup.ps1')
)

$ErrorActionPreference = 'Stop'

if (-not ('Probe2.Native' -as [type])) {
    Add-Type -Namespace Probe2 -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
}

function Get-WindowsOf {
    param([int]$ProcessId)
    $found = New-Object System.Collections.ArrayList
    $callback = [Probe2.Native+EnumProc] {
        param($hwnd, $lparam)
        $owner = 0
        [void][Probe2.Native]::GetWindowThreadProcessId($hwnd, [ref]$owner)
        if ($owner -eq $ProcessId -and [Probe2.Native]::IsWindowVisible($hwnd)) { [void]$found.Add($hwnd) }
        return $true
    }
    [void][Probe2.Native]::EnumWindows($callback, [IntPtr]::Zero)
    return $found
}

$payload = @{
    kind = 'completed'; label = 'done'; accent = '#2ECC71'; glyph = 'v'; count = 1
    items = @(); headline = 'click probe'; headlineTint = '#2ECC71'; verdictKind = 'done'; verdictText = ''
    context = 'dsh-nudge'; summary = 'click probe'; overflow = 0; more = ''; footer = 'probe'
    clickToFocus = $false; clickThrough = $false
    clipboardHeader = 'probe'
    theme = 'dark'; anchor = 'bottom-right'; width = 384; rememberPosition = $false
    at = (Get-Date).ToString('HH:mm')
}
$json = $payload | ConvertTo-Json -Compress -Depth 6
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
$out = Join-Path $env:TEMP ("nudge-click-{0}.log" -f [guid]::NewGuid().ToString('n'))

$before = [Probe2.Native]::GetForegroundWindow()
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
if ($hwnd -eq [IntPtr]::Zero) { try { $proc.Kill() } catch { }; throw 'card never appeared' }

# Past the 320ms press grace and the 180ms fade-in.
Start-Sleep -Milliseconds 1200

# A posted WM_LBUTTONDOWN is not enough: WPF's mouse provider routes real device
# input, so the click has to be real. Park the cursor on the card centre, click,
# then put the cursor back where it was - the card eats the click, nothing else sees it.
$saved = New-Object 'Probe2.Native+POINT'
[void][Probe2.Native]::GetCursorPos([ref]$saved)
$rect = New-Object 'Probe2.Native+RECT'
[void][Probe2.Native]::GetWindowRect($hwnd, [ref]$rect)
$cx = [int](($rect.Left + $rect.Right) / 2)
$cy = [int](($rect.Top + $rect.Bottom) / 2)
[void][Probe2.Native]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 150
[Probe2.Native]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
[Probe2.Native]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
[void][Probe2.Native]::SetCursorPos($saved.X, $saved.Y)

$closed = $false
for ($i = 0; $i -lt 40 -and -not $closed; $i++) {
    Start-Sleep -Milliseconds 100
    $closed = $proc.HasExited
}
$after = [Probe2.Native]::GetForegroundWindow()
$lines = Get-Content -LiteralPath $out -ErrorAction SilentlyContinue | Where-Object { $_ -match '"type"' }
$closedLine = $lines | Where-Object { $_ -match '"closed"' }
if (-not $closed) { try { $proc.Kill() } catch { } }
Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue

$result = [pscustomobject][ordered]@{
    cardClosed       = $closed
    reason           = if ($closedLine -match '"reason":"([^"]+)"') { $Matches[1] } else { '' }
    clipboard        = if ($closedLine -match '"clipboard":(\w+)') { $Matches[1] } else { '' }
    foregroundBefore = $before.ToInt64()
    foregroundAfter  = $after.ToInt64()
    focusUnchanged   = ($before -eq $after)
    status           = ($lines -join ' | ')
}
$result | Format-List

if ($result.cardClosed -and $result.reason -eq 'clicked-nojump' -and $result.clipboard -eq 'false' -and $result.focusUnchanged) {
    Write-Host 'PROBE OK: click closes the card, no jump, no clipboard write, foreground untouched.' -ForegroundColor Green
    exit 0
}
Write-Host 'PROBE FAILED' -ForegroundColor Red
exit 1
