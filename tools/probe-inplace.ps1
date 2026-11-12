# Real-machine probe: a preview card rebuilds its content IN PLACE (no new process).
#
# 1. start a resident preview card with -Preview -PayloadFile, remember its pid;
# 2. rewrite the payload file with title+project switched off, wait 1.4s;
# 3. check the process is still alive (same pid), the window is the same hwnd, and
#    the window height changed (the body was really rebuilt).
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
    [string]$Script = (Join-Path (Split-Path -Parent $PSScriptRoot) 'lib/popup.ps1')
)

$ErrorActionPreference = 'Stop'

if (-not ('Reflow4.Native' -as [type])) {
    Add-Type -Namespace Reflow4 -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
'@
}

function Get-CardWindow {
    param([int]$ProcessId)
    $found = New-Object System.Collections.ArrayList
    $callback = [Reflow4.Native+EnumProc] {
        param($hwnd, $lparam)
        $owner = 0
        [void][Reflow4.Native]::GetWindowThreadProcessId($hwnd, [ref]$owner)
        if ($owner -eq $ProcessId -and [Reflow4.Native]::IsWindowVisible($hwnd)) { [void]$found.Add($hwnd) }
        return $true
    }
    [void][Reflow4.Native]::EnumWindows($callback, [IntPtr]::Zero)
    if ($found.Count -gt 0) { return $found[0] }
    return [IntPtr]::Zero
}

function New-Payload {
    param([bool]$AllOn)
    $visible = if ($AllOn) {
        @{ title = $true; project = $true; task = $true; status = $true; items = $true; more = $true; footer = $true }
    } else {
        @{ title = $false; project = $false; task = $true; status = $true; items = $true; more = $true; footer = $true }
    }
    return @{
        kind = 'completed'; label = 'done'; accent = '#2ECC71'; glyph = 'v'; count = 1
        items = @(); headline = 'in-place refresh probe with a headline long enough to wrap'
        headlineTint = '#2ECC71'; verdictKind = 'done'; verdictText = 'second line of the verdict block'
        context = 'dsh-nudge'; summary = 'probe'; overflow = 0; more = ''; footer = 'probe footer'
        clickToFocus = $true; clickThrough = $false; clipboardHeader = 'probe'
        theme = 'dark'; anchor = 'bottom-right'; width = 384; rememberPosition = $false
        visible = $visible
        at = '22:05'
    }
}

$file = Join-Path $env:TEMP 'nudge-inplace-payload.json'
$stop = Join-Path $env:TEMP 'nudge-inplace-stop.txt'
$log = Join-Path $env:TEMP 'nudge-inplace.log'
Remove-Item $file, $stop, $log -Force -ErrorAction SilentlyContinue

[System.IO.File]::WriteAllText($file, ((New-Payload -AllOn $true) | ConvertTo-Json -Compress -Depth 8), (New-Object System.Text.UTF8Encoding($false)))

$proc = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
    '-File', $Script, '-PayloadFile', $file, '-Preview', '-StopFile', $stop,
    '-StaySeconds', '60', '-Margin', '16', '-DsProcess', 'DeepSeek Harness'
) -RedirectStandardOutput $log

$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 80 -and $hwnd -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 100
    $hwnd = Get-CardWindow -ProcessId $proc.Id
}
if ($hwnd -eq [IntPtr]::Zero) { try { $proc.Kill() } catch { }; throw 'card never appeared' }
Start-Sleep -Milliseconds 800

$before = New-Object 'Reflow4.Native+RECT'
[void][Reflow4.Native]::GetWindowRect($hwnd, [ref]$before)
$beforeSize = '{0}x{1}' -f ($before.Right - $before.Left), ($before.Bottom - $before.Top)

# Rewrite the payload with title+project off: the body must reflow (shorter), and the
# process must NOT be replaced.
[System.IO.File]::WriteAllText($file, ((New-Payload -AllOn $false) | ConvertTo-Json -Compress -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Start-Sleep -Milliseconds 1400

$stillAlive = -not $proc.HasExited
$hwndAfter = Get-CardWindow -ProcessId $proc.Id
$after = New-Object 'Reflow4.Native+RECT'
if ($hwndAfter -ne [IntPtr]::Zero) { [void][Reflow4.Native]::GetWindowRect($hwndAfter, [ref]$after) }
$afterSize = '{0}x{1}' -f ($after.Right - $after.Left), ($after.Bottom - $after.Top)

try { $proc.Kill() } catch { }
Start-Sleep -Milliseconds 300
$shownCount = (Get-Content -LiteralPath $log -ErrorAction SilentlyContinue | Where-Object { $_ -match '"type":"shown"' }).Count
Remove-Item $file, $stop, $log -Force -ErrorAction SilentlyContinue

$result = [pscustomobject][ordered]@{
    sameProcess   = $stillAlive
    sameWindow    = ($hwnd -eq $hwndAfter)
    before        = $beforeSize
    after         = $afterSize
    heightChanged = (($before.Bottom - $before.Top) -ne ($after.Bottom - $after.Top))
    shownLines    = $shownCount
}
$result | Format-List

if ($result.sameProcess -and $result.sameWindow -and $result.heightChanged) {
    Write-Host 'PROBE OK: preview card rebuilt in place (same pid, same hwnd, new height).' -ForegroundColor Green
    exit 0
}
Write-Host 'PROBE FAILED' -ForegroundColor Red
exit 1
