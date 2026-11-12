# Real-machine probe: a remembered card height must NOT leave empty space when blocks
# are switched off. Before this fix a card pinned at 210px stayed 210px tall while its
# content only needed ~164px, so the bottom ~46px were blank.
#
# 1. write a placement.json with sized=true and height=210 (what a dragged card leaves);
# 2. show a card with title+project off (content needs ~164);
# 3. the window must be ~164+28, not ~210+28.
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
    [string]$Script = (Join-Path (Split-Path -Parent $PSScriptRoot) 'lib/popup.ps1')
)

$ErrorActionPreference = 'Stop'

if (-not ('Rem5.Native' -as [type])) {
    Add-Type -Namespace Rem5 -Name Native -MemberDefinition @'
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
    $callback = [Rem5.Native+EnumProc] {
        param($hwnd, $lparam)
        $owner = 0
        [void][Rem5.Native]::GetWindowThreadProcessId($hwnd, [ref]$owner)
        if ($owner -eq $ProcessId -and [Rem5.Native]::IsWindowVisible($hwnd)) { [void]$found.Add($hwnd) }
        return $true
    }
    [void][Rem5.Native]::EnumWindows($callback, [IntPtr]::Zero)
    if ($found.Count -gt 0) { return $found[0] }
    return [IntPtr]::Zero
}

function Show-Card {
    param([string]$PayloadFile, [string]$PlacementFile, [int]$WaitMs = 1200)
    $log = [System.IO.Path]::GetTempFileName()
    $proc = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', $Script, '-PayloadFile', $PayloadFile, '-StaySeconds', '20', '-Margin', '16',
        '-DsProcess', 'DeepSeek Harness'
    ) -RedirectStandardOutput $log
    $hwnd = [IntPtr]::Zero
    for ($i = 0; $i -lt 80 -and $hwnd -eq [IntPtr]::Zero; $i++) {
        Start-Sleep -Milliseconds 100
        $hwnd = Get-CardWindow -ProcessId $proc.Id
    }
    if ($hwnd -eq [IntPtr]::Zero) { try { $proc.Kill() } catch { }; throw 'card never appeared' }
    Start-Sleep -Milliseconds $WaitMs
    $rect = New-Object 'Rem5.Native+RECT'
    [void][Rem5.Native]::GetWindowRect($hwnd, [ref]$rect)
    $size = @{ width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
    try { $proc.Kill() } catch { }
    Start-Sleep -Milliseconds 200
    Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
    return $size
}

$dir = Join-Path $env:TEMP 'nudge-remembered'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$placement = Join-Path $dir 'placement.json'
$payloadAll = Join-Path $dir 'all.json'
$payloadShort = Join-Path $dir 'short.json'

# height 210 is what "all blocks on" measures; sized=true + base=384 makes it apply.
'{"width":406,"height":210,"sized":true,"left":2164,"base":384,"anchor":"bottom-right","top":1200}' |
    Set-Content -LiteralPath $placement -Encoding UTF8

$common = @{
    kind = 'completed'; label = 'done'; accent = '#2ECC71'; glyph = 'v'; count = 1
    items = @(); headline = 'remembered height probe'; headlineTint = '#2ECC71'
    verdictKind = 'done'; verdictText = 'one line of the verdict block'
    context = 'dsh-nudge'; summary = 'probe'; overflow = 0; more = ''; footer = 'probe footer'
    clickToFocus = $true; clickThrough = $false; clipboardHeader = 'probe'
    theme = 'dark'; anchor = 'bottom-right'; width = 384; rememberPosition = $true
    placementFile = $placement
    at = '22:40'
}
$all = $common.Clone()
$all.visible = @{ title = $true; project = $true; task = $true; status = $true; items = $true; more = $true; footer = $true }
[System.IO.File]::WriteAllText($payloadAll, ($all | ConvertTo-Json -Compress -Depth 8), (New-Object System.Text.UTF8Encoding($false)))

$short = $common.Clone()
$short.visible = @{ title = $false; project = $false; task = $true; status = $true; items = $true; more = $true; footer = $true }
[System.IO.File]::WriteAllText($payloadShort, ($short | ConvertTo-Json -Compress -Depth 8), (New-Object System.Text.UTF8Encoding($false)))

$full = Show-Card -PayloadFile $payloadAll -PlacementFile $placement
Start-Sleep -Milliseconds 300
$small = Show-Card -PayloadFile $payloadShort -PlacementFile $placement

$result = [pscustomobject][ordered]@{
    allBlocks   = ('{0}x{1}' -f $full.width, $full.height)
    twoOff      = ('{0}x{1}' -f $small.width, $small.height)
    widthKept   = ($full.width -eq $small.width)
    shrunk      = ($small.height -lt $full.height - 20)
}
$result | Format-List
Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue

if ($result.widthKept -and $result.shrunk) {
    Write-Host 'PROBE OK: remembered width kept, height follows content (no blank space).' -ForegroundColor Green
    exit 0
}
Write-Host 'PROBE FAILED' -ForegroundColor Red
exit 1
