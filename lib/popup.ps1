# dsh-nudge popup helper (Windows PowerShell 5.1, STA required)
#
# Modes:
#   1. one-shot (default): renders ONE card, writes status to stdout, then exits
#      on timeout or click. Payload is passed on the command line:
#        -PayloadB64 <base64 UTF-8 JSON> | -PayloadFile <path>
#      plus -StaySeconds, -Margin, and optional -SuppressWhenForeground /
#      -SuppressWhenFullscreen.
#      The process is deliberately short-lived: Windows PowerShell 5.1's
#      [Console]::In over a redirected pipe can stall for seconds, so a
#      daemon/stdin protocol is not used.
#   2. snapshot: -Snapshot <out.png> (-PayloadB64 <b64> | -PayloadFile <path>)
#      Renders the same card offline (no window) so layout can be verified in
#      automated tests and headless runs.
#
# stdout protocol (one JSON per line):
#   {"type":"shown","count":N,"slot":"owner|replaced|parallel","theme":"dark|light"}
#   {"type":"closed","reason":"clicked|dismissed|timeout|replaced|watchdog","clipboard":bool}
#   {"type":"suppressed","reason":"foreground|fullscreen","state":N,"theme":"dark|light"}
#   {"type":"error","message":"..."}
#   {"type":"snapshot","path":"..."}
#
# Only one card may be up at a time: a per-session named mutex elects the owner and
# a newer helper asks the resident card to step aside (see Initialize-CardSlot).
#
# This script stays ASCII-only on purpose: Windows PowerShell 5.1 reads non-BOM
# scripts as ANSI, so any literal CJK here would be mojibake.

param(
    [int]$StaySeconds = 15,
    [int]$Margin = 16,
    [switch]$SuppressWhenForeground,
    [switch]$SuppressWhenFullscreen,
    [string]$DsProcess = 'DeepSeek Harness',
    [string]$Theme = '',
    [string]$Snapshot = '',
    [string]$PayloadFile = '',
    [string]$PayloadB64 = '',
    [int]$SnapshotWidth = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace Native -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder name, int maxCount);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool ReleaseCapture();
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int nNewLong);
[DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
[DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
[DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
public static int[] WorkAreaOf(IntPtr monitor) {
    if (monitor == IntPtr.Zero) return null;
    MONITORINFO info = new MONITORINFO();
    info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(monitor, ref info)) return null;
    return new int[] { info.rcWork.Left, info.rcWork.Top, info.rcWork.Right, info.rcWork.Bottom };
}
public static int[] WorkAreaOfWindow(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return null;
    return WorkAreaOf(MonitorFromWindow(hWnd, 2));
}
public static int[] WorkAreaOfCursor() {
    POINT pt;
    if (!GetCursorPos(out pt)) return null;
    return WorkAreaOf(MonitorFromPoint(pt, 2));
}
// Physical monitor rect (rcMonitor), unlike WorkAreaOf which excludes the taskbar.
public static int[] MonitorBoundsOf(IntPtr monitor) {
    if (monitor == IntPtr.Zero) return null;
    MONITORINFO info = new MONITORINFO();
    info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(monitor, ref info)) return null;
    return new int[] { info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Right, info.rcMonitor.Bottom };
}
// Monitor that owns a physical point; used to check a remembered card rect still
// lands on a screen before trusting it.
public static int[] MonitorBoundsOfPoint(int x, int y) {
    POINT pt = new POINT();
    pt.X = x;
    pt.Y = y;
    return MonitorBoundsOf(MonitorFromPoint(pt, 2));
}
// Read-only shell query: is this a bad moment to interrupt (fullscreen app, slide
// show, locked screen)? It only returns a state number; nothing is hooked or grabbed.
[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
[DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
[DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
[DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
public static IntPtr MonitorOfWindow(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return IntPtr.Zero;
    return MonitorFromWindow(hWnd, 2);
}
public static IntPtr MonitorOfCursor() {
    POINT pt;
    if (!GetCursorPos(out pt)) return IntPtr.Zero;
    return MonitorFromPoint(pt, 2);
}
// Effective DPI of one monitor: 96 on failure, so callers can always divide.
public static int DpiOf(IntPtr monitor) {
    if (monitor == IntPtr.Zero) return 96;
    uint dx;
    uint dy;
    if (GetDpiForMonitor(monitor, 0, out dx, out dy) == 0 && dx > 0) return (int)dx;
    return 96;
}
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
[DllImport("kernel32.dll")] public static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
[DllImport("kernel32.dll")] public static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr hObject);
[StructLayout(LayoutKind.Sequential)]
public struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
}
// Ancestor pid chain, nearest first, read from one process snapshot (~1 ms).
// A single CIM query per level costs ~500 ms, which is too much on the click path.
public static int[] AncestorChain(uint startPid, int maxDepth) {
    var parentOf = new System.Collections.Generic.Dictionary<uint, uint>();
    IntPtr snap = CreateToolhelp32Snapshot(0x00000002, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return new int[0];
    try {
        PROCESSENTRY32 entry = new PROCESSENTRY32();
        entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        if (Process32First(snap, ref entry)) {
            do {
                parentOf[entry.th32ProcessID] = entry.th32ParentProcessID;
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            } while (Process32Next(snap, ref entry));
        }
    } finally {
        CloseHandle(snap);
    }
    var chain = new System.Collections.Generic.List<int>();
    uint cursor = startPid;
    for (int i = 0; i < maxDepth; i++) {
        uint parent;
        if (!parentOf.TryGetValue(cursor, out parent)) break;
        if (parent == 0 || parent == cursor) break;
        chain.Add((int)parent);
        cursor = parent;
    }
    return chain.ToArray();
}
'@

function Enable-DpiAwareness {
    # Monitor work areas come back in physical pixels, but WPF positions windows in
    # device-independent units: on a 150% secondary monitor the two disagree and the
    # card lands off the corner (or off the screen). Per-monitor-v2 makes both sides
    # agree per monitor. Older Windows falls back one step at a time.
    # NOTE: if the host manifest already pinned the awareness level, every call below
    # fails and the mode stays 'system' -- that is the pre-0.2.2 behaviour, still fine
    # on a single 100% screen because scale is then 1.0 anyway.
    try { if ([Native.Win]::SetProcessDpiAwarenessContext([IntPtr](-4))) { return 'per-monitor-v2' } } catch { }
    try { if ([Native.Win]::SetProcessDpiAwareness(2) -eq 0) { return 'per-monitor' } } catch { }
    try { [void][Native.Win]::SetProcessDPIAware(); return 'system' } catch { }
    return 'none'
}

$script:DpiMode = Enable-DpiAwareness
$script:DpiPerMonitor = ($script:DpiMode -eq 'per-monitor-v2' -or $script:DpiMode -eq 'per-monitor')

$script:DsExeName = if ([string]::IsNullOrWhiteSpace($DsProcess)) { 'DeepSeek Harness' } else { $DsProcess }

function Write-Status {
    param([hashtable]$Status)
    try {
        $json = $Status | ConvertTo-Json -Compress -Depth 4
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json + [Environment]::NewLine)
        $stream = [Console]::OpenStandardOutput()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    } catch { }
}

function ConvertFrom-Base64Payload {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $bytes = [Convert]::FromBase64String($Text)
    $json = [System.Text.Encoding]::UTF8.GetString($bytes)
    return $json | ConvertFrom-Json
}

function Read-Payload {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    return $text | ConvertFrom-Json
}

function Resolve-Payload {
    param([string]$B64, [string]$File)
    if (-not [string]::IsNullOrWhiteSpace($B64)) {
        try { return ConvertFrom-Base64Payload $B64 } catch { return $null }
    }
    return Read-Payload $File
}

$script:CardWidth = 384
$script:ShadowPad = 14
$script:CardRadius = 12
$script:FontStack = 'Microsoft YaHei UI, Microsoft YaHei, Segoe UI, Arial'
$script:IconFont = 'Segoe MDL2 Assets'

# Palette: two surfaces (dark glass / light glass) sharing one token list, so
# every colour below is referenced from here and switching theme never needs a
# second code path. Values are filled in by Set-CardTheme before the first card
# is built; the assignments here are the dark defaults plus a documented fallback
# in case anything runs before theming.
$script:CardTop = '#F8212530'
$script:CardBottom = '#F8181B24'
$script:CardEdge = '#2BFFFFFF'
$script:CardEdgeHover = '#5CFFFFFF'
$script:TextPrimary = '#FFFFFFFF'
$script:TextBody = '#F0FFFFFF'
$script:TextMuted = '#8AFFFFFF'
$script:TextFaint = '#5CFFFFFF'
$script:TextGhost = '#4DFFFFFF'
$script:RuleColor = '#1FFFFFFF'
$script:VerdictText = '#DCFFFFFF'
$script:MoreText = '#75FFFFFF'
$script:FooterText = '#59FFFFFF'
$script:FrameBg = '#FF1F1F1F'
$script:EdgeFailed = '#4DE74C3C'
$script:EdgeChoice = '#45F5A623'
$script:ShadowOpacity = 0.42

function Set-CardTheme {
    param([string]$Name)
    switch ($Name) {
        'light' {
            # Light glass: near-white surface, ink text ramp, and a much softer
            # shadow - a 0.42 black halo on a white card looks like dirt.
            $script:ThemeName = 'light'
            $script:CardTop = '#F7FBFCFE'
            $script:CardBottom = '#F4ECEEF3'
            $script:CardEdge = '#22000000'
            $script:CardEdgeHover = '#40000000'
            $script:TextPrimary = '#FF14171C'
            $script:TextBody = '#FF23282F'
            $script:TextMuted = '#FF5B6472'
            $script:TextFaint = '#FF8A929E'
            $script:TextGhost = '#FFA8AFB9'
            $script:RuleColor = '#14000000'
            $script:VerdictText = '#E014171C'
            $script:MoreText = '#FF6E7686'
            $script:FooterText = '#FF8A929E'
            $script:FrameBg = '#FFF0F2F5'
            $script:ShadowOpacity = 0.18
        }
        default {
            $script:ThemeName = 'dark'
            $script:CardTop = '#F8212530'
            $script:CardBottom = '#F8181B24'
            $script:CardEdge = '#2BFFFFFF'
            $script:CardEdgeHover = '#5CFFFFFF'
            $script:TextPrimary = '#FFFFFFFF'
            $script:TextBody = '#F0FFFFFF'
            $script:TextMuted = '#8AFFFFFF'
            $script:TextFaint = '#5CFFFFFF'
            $script:TextGhost = '#4DFFFFFF'
            $script:RuleColor = '#1FFFFFFF'
            $script:VerdictText = '#DCFFFFFF'
            $script:MoreText = '#75FFFFFF'
            $script:FooterText = '#59FFFFFF'
            $script:FrameBg = '#FF1F1F1F'
            $script:ShadowOpacity = 0.42
        }
    }
}

# "auto" means: follow the Windows setting for app surfaces
# (Settings > Personalization > Colors > Choose your default app mode).
# Anything unreadable falls back to dark, which is what the card shipped with.
function Resolve-Theme {
    param([string]$Requested, [string]$FromPayload)
    $want = $Requested
    if ([string]::IsNullOrWhiteSpace($want)) { $want = $FromPayload }
    if ([string]::IsNullOrWhiteSpace($want)) { $want = 'auto' }
    $want = $want.Trim().ToLowerInvariant()
    if ($want -eq 'dark' -or $want -eq 'light') { return $want }
    try {
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
        $light = (Get-ItemProperty -Path $key -Name 'AppsUseLightTheme' -ErrorAction Stop).AppsUseLightTheme
        if ($light -eq 1) { return 'light' }
        if ($light -eq 0) { return 'dark' }
    } catch { }
    return 'dark'
}

function New-Brush {
    param([string]$Hex)
    $color = [System.Windows.Media.ColorConverter]::ConvertFromString($Hex)
    $brush = New-Object System.Windows.Media.SolidColorBrush $color
    $brush.Freeze()
    return $brush
}
function New-Text {
    param(
        [string]$Text,
        [double]$Size = 12,
        [string]$Color = '#F2FFFFFF',
        [string]$Weight = 'Normal'
    )
    $block = New-Object System.Windows.Controls.TextBlock
    $block.Text = $Text
    $block.FontFamily = New-Object System.Windows.Media.FontFamily $script:FontStack
    $block.FontSize = $Size
    $block.FontWeight = $Weight
    $block.Foreground = New-Brush $Color
    $block.VerticalAlignment = 'Center'
    $block.SnapsToDevicePixels = $true
    $block.UseLayoutRounding = $true
    [System.Windows.Media.TextOptions]::SetTextFormattingMode($block, [System.Windows.Media.TextFormattingMode]::Display)
    [System.Windows.Media.TextOptions]::SetTextRenderingMode($block, [System.Windows.Media.TextRenderingMode]::ClearType)
    return $block
}

function Get-KindAccent {
    param([string]$Kind)
    switch ($Kind) {
        'failed' { return '#E74C3C' }
        'needs_choice' { return '#F5A623' }
        default { return '#2ECC71' }
    }
}

function Measure-Card {
    param($Card)
    $Card.Measure([System.Windows.Size]::new([double]::PositiveInfinity, [double]::PositiveInfinity))
    return @{
        Width  = [int][Math]::Ceiling($Card.DesiredSize.Width)
        Height = [int][Math]::Ceiling($Card.DesiredSize.Height)
    }
}

function New-VerticalGradient {
    param([string]$Top, [string]$Bottom)
    $brush = New-Object System.Windows.Media.LinearGradientBrush
    $brush.StartPoint = New-Object System.Windows.Point 0.5, 0
    $brush.EndPoint = New-Object System.Windows.Point 0.5, 1
    $topStop = New-Object System.Windows.Media.GradientStop ([System.Windows.Media.ColorConverter]::ConvertFromString($Top)), 0
    $bottomStop = New-Object System.Windows.Media.GradientStop ([System.Windows.Media.ColorConverter]::ConvertFromString($Bottom)), 1
    [void]$brush.GradientStops.Add($topStop)
    [void]$brush.GradientStops.Add($bottomStop)
    $brush.Freeze()
    return $brush
}

function New-Badge {
    param([string]$Accent, [string]$Glyph)
    # A soft tinted disc instead of a solid accent blob: the glyph keeps the
    # accent colour, so the card carries less visual weight.
    $disc = New-Object System.Windows.Controls.Border
    $disc.Width = 22
    $disc.Height = 22
    $disc.CornerRadius = New-Object System.Windows.CornerRadius 11
    $disc.Background = New-Brush ('#2E' + $Accent.Substring(1))
    $disc.VerticalAlignment = 'Center'
    $disc.Margin = New-Object System.Windows.Thickness 0,0,10,0
    $disc.SnapsToDevicePixels = $true

    $glyphText = $null
    if ($Glyph -eq ([string][char]0x2713) -or $Glyph -eq ([string][char]0x2714)) {
        # Check mark from the icon font keeps the same optical weight as the
        # punctuation glyphs used by the other two states.
        $glyphText = New-Text -Text ([string][char]0xE73E) -Size 11 -Color $Accent -Weight 'Normal'
        $glyphText.FontFamily = New-Object System.Windows.Media.FontFamily $script:IconFont
    } else {
        $glyphText = New-Text -Text $Glyph -Size 13 -Color $Accent -Weight 'Bold'
    }
    $glyphText.HorizontalAlignment = 'Center'
    $glyphText.TextAlignment = 'Center'
    $glyphText.Margin = New-Object System.Windows.Thickness 0,0,0,1
    $disc.Child = $glyphText
    return $disc
}

function New-CountPill {
    param([int]$Count, [string]$Accent)
    $pill = New-Object System.Windows.Controls.Border
    $pill.Height = 17
    $pill.CornerRadius = New-Object System.Windows.CornerRadius 8.5
    $pill.Background = New-Brush ('#24' + $Accent.Substring(1))
    $pill.BorderBrush = New-Brush ('#38' + $Accent.Substring(1))
    $pill.BorderThickness = New-Object System.Windows.Thickness 1
    $pill.Padding = New-Object System.Windows.Thickness 7,0,7,0
    $pill.Margin = New-Object System.Windows.Thickness 8,0,0,0
    $pill.VerticalAlignment = 'Center'
    $pill.SnapsToDevicePixels = $true
    $pill.Child = (New-Text -Text ([string]$Count) -Size 10 -Color $Accent -Weight 'SemiBold')
    return $pill
}

function New-ItemRow {
    param($Item)
    $accent = Get-KindAccent ([string]$Item.kind)
    $row = New-Object System.Windows.Controls.Grid
    $row.Margin = New-Object System.Windows.Thickness 0,10,0,0
    $colDot = New-Object System.Windows.Controls.ColumnDefinition
    $colDot.Width = [System.Windows.GridLength]::Auto
    $colText = New-Object System.Windows.Controls.ColumnDefinition
    $colText.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $colTime = New-Object System.Windows.Controls.ColumnDefinition
    $colTime.Width = [System.Windows.GridLength]::Auto
    [void]$row.ColumnDefinitions.Add($colDot)
    [void]$row.ColumnDefinitions.Add($colText)
    [void]$row.ColumnDefinitions.Add($colTime)

    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 6
    $dot.Height = 6
    $dot.Fill = New-Brush $accent
    $dot.VerticalAlignment = 'Top'
    $dot.Margin = New-Object System.Windows.Thickness 1,6,9,0
    [System.Windows.Controls.Grid]::SetColumn($dot, 0)
    [void]$row.Children.Add($dot)

    $stack = New-Object System.Windows.Controls.StackPanel
    [System.Windows.Controls.Grid]::SetColumn($stack, 1)

    $suffix = ''
    if ([int]$Item.count -gt 1) { $suffix = "  x$([int]$Item.count)" }
    # Reading ladder, largest type first: the project folder says "where", the
    # task name says "what ran", and the detail underneath is the reported
    # problem. A glance at the card has to answer "where" first, so the project
    # owns the biggest line of the row. No leading glyph here either: the name
    # leads on size alone, and the 16px the icon took is now text width.
    $rowProject = [string]$Item.rowProject
    if (-not [string]::IsNullOrWhiteSpace($rowProject)) {
        $projectLabel = New-Text -Text $rowProject -Size 15 -Color $script:TextPrimary -Weight 'SemiBold'
        $projectLabel.TextTrimming = 'CharacterEllipsis'
        $projectLabel.TextWrapping = 'NoWrap'
        $projectLabel.HorizontalAlignment = 'Left'
        [void]$stack.Children.Add($projectLabel)
    }

    $title = New-Text -Text ("$($Item.title)$suffix") -Size 12.5 -Color $script:TextBody
    $title.TextTrimming = 'CharacterEllipsis'
    $title.TextWrapping = 'NoWrap'
    $title.HorizontalAlignment = 'Left'
    if (-not [string]::IsNullOrWhiteSpace($rowProject)) {
        $title.Margin = New-Object System.Windows.Thickness 0,2,0,0
    }
    [void]$stack.Children.Add($title)

    # The reported problem is the smallest rung of the ladder on purpose: you
    # read it only after the project and the task told you whether you care.
    # The wrapping TextBlock needs a constrained width, which the vertical stack
    # already passes down (infinite height, finite width).
    $metaText = [string]$Item.detail
    if (-not [string]::IsNullOrWhiteSpace($metaText)) {
        $detail = New-Text -Text $metaText -Size 10.5 -Color $script:TextMuted
        $detail.TextWrapping = 'Wrap'
        $detail.LineHeight = 15
        $detail.LineStackingStrategy = 'BlockLineHeight'
        # Fold at six lines: a very long error on a narrow card would
        # otherwise make the card taller than the screen. 90 = 6 * LineHeight,
        # so the cut lands on a line boundary instead of slicing a glyph.
        $detail.MaxHeight = 90
        $detail.VerticalAlignment = 'Top'
        $detail.Margin = New-Object System.Windows.Thickness 0,3,0,0
        [void]$stack.Children.Add($detail)
    }
    [void]$row.Children.Add($stack)

    # The kind word is spelled out next to the timestamp, in the same accent as
    # the dot: a 6 px dot alone is a weak cue when four notices are stacked.
    # Stacked, not side by side: on a 260 px card "pending 21:19" in one line is
    # wide enough to squeeze the task name into the card edge.
    $timeBox = New-Object System.Windows.Controls.StackPanel
    $timeBox.Orientation = 'Vertical'
    $timeBox.VerticalAlignment = 'Top'
    $timeBox.HorizontalAlignment = 'Right'
    $timeBox.Margin = New-Object System.Windows.Thickness 10,1,0,0
    $kindWord = [string]$Item.rowKind
    if (-not [string]::IsNullOrWhiteSpace($kindWord)) {
        $kindText = New-Text -Text $kindWord -Size 9.5 -Color $accent
        $kindText.HorizontalAlignment = 'Right'
        [void]$timeBox.Children.Add($kindText)
    }
    $time = New-Text -Text ([string]$Item.at) -Size 10 -Color $script:TextGhost
    $time.HorizontalAlignment = 'Right'
    $time.Margin = New-Object System.Windows.Thickness 0,1,0,0
    [void]$timeBox.Children.Add($time)
    [System.Windows.Controls.Grid]::SetColumn($timeBox, 2)
    [void]$row.Children.Add($timeBox)
    return $row
}

function New-Card {
    param($Payload, [int]$Width = $script:CardWidth)
    $accent = [string]$Payload.accent
    if ([string]::IsNullOrWhiteSpace($accent)) { $accent = Get-KindAccent ([string]$Payload.kind) }
    $items = @($Payload.items | Where-Object { $null -ne $_ })

    $card = New-Object System.Windows.Controls.Border
    if ($Width -gt 0) {
        $card.Width = $Width
    } else {
        $card.HorizontalAlignment = 'Stretch'
        $card.VerticalAlignment = 'Stretch'
    }
    $card.CornerRadius = New-Object System.Windows.CornerRadius $script:CardRadius
    $card.Background = New-VerticalGradient -Top $script:CardTop -Bottom $script:CardBottom
    # A failed batch tints the whole outline red, so the card reads as "something
    # broke" from the corner of your eye before you parse a single word.
    $script:cardEdgeNow = $script:CardEdge
    $kindName = [string]$Payload.kind
    if ($kindName -eq 'failed') { $script:cardEdgeNow = $script:EdgeFailed }
    elseif ($kindName -eq 'needs_choice') { $script:cardEdgeNow = $script:EdgeChoice }
    $card.BorderBrush = New-Brush $script:cardEdgeNow
    $card.BorderThickness = New-Object System.Windows.Thickness 1
    $card.Margin = New-Object System.Windows.Thickness $script:ShadowPad
    $card.Cursor = [System.Windows.Input.Cursors]::Hand
    $card.SnapsToDevicePixels = $true

    # Blur 14 with depth 3 reaches about 10 px, so the 12 px margin cannot
    # clip the halo the way the previous 16 px blur did.
    $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
    $shadow.BlurRadius = 14
    $shadow.ShadowDepth = 3
    $shadow.Direction = 270
    $shadow.Opacity = $script:ShadowOpacity
    $shadow.Color = [System.Windows.Media.Colors]::Black
    $card.Effect = $shadow

    $outer = New-Object System.Windows.Controls.Grid
    $colStrip = New-Object System.Windows.Controls.ColumnDefinition
    $colStrip.Width = [System.Windows.GridLength]::Auto
    $colBody = New-Object System.Windows.Controls.ColumnDefinition
    $colBody.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    [void]$outer.ColumnDefinitions.Add($colStrip)
    [void]$outer.ColumnDefinitions.Add($colBody)

    $strip = New-Object System.Windows.Controls.Border
    $strip.Width = 3
    $strip.Background = New-Brush $accent
    $strip.CornerRadius = New-Object System.Windows.CornerRadius 1.5
    $strip.Margin = New-Object System.Windows.Thickness 1,13,0,13
    $strip.SnapsToDevicePixels = $true
    [System.Windows.Controls.Grid]::SetColumn($strip, 0)
    [void]$outer.Children.Add($strip)

    $body = New-Object System.Windows.Controls.StackPanel
    $body.Margin = New-Object System.Windows.Thickness 16,14,16,14
    [System.Windows.Controls.Grid]::SetColumn($body, 1)

    $header = New-Object System.Windows.Controls.Grid
    $colHead = New-Object System.Windows.Controls.ColumnDefinition
    $colHead.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $colHeadTime = New-Object System.Windows.Controls.ColumnDefinition
    $colHeadTime.Width = [System.Windows.GridLength]::Auto
    [void]$header.ColumnDefinitions.Add($colHead)
    [void]$header.ColumnDefinitions.Add($colHeadTime)

    # Badge + label + count pill as a grid: the label owns the star column so a
    # narrow card trims it instead of shoving the timestamp off the edge.
    $titleLine = New-Object System.Windows.Controls.Grid
    $colBadge = New-Object System.Windows.Controls.ColumnDefinition
    $colBadge.Width = [System.Windows.GridLength]::Auto
    $colLabel = New-Object System.Windows.Controls.ColumnDefinition
    $colLabel.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $colPill = New-Object System.Windows.Controls.ColumnDefinition
    $colPill.Width = [System.Windows.GridLength]::Auto
    [void]$titleLine.ColumnDefinitions.Add($colBadge)
    [void]$titleLine.ColumnDefinitions.Add($colLabel)
    [void]$titleLine.ColumnDefinitions.Add($colPill)
    $badge = New-Badge -Accent $accent -Glyph ([string]$Payload.glyph)
    $badge.VerticalAlignment = 'Center'
    [System.Windows.Controls.Grid]::SetColumn($badge, 0)
    [void]$titleLine.Children.Add($badge)
    $labelText = New-Text -Text ([string]$Payload.label) -Size 14 -Color $script:TextPrimary -Weight 'SemiBold'
    $labelText.TextTrimming = 'CharacterEllipsis'
    $labelText.TextWrapping = 'NoWrap'
    $labelText.VerticalAlignment = 'Center'
    [System.Windows.Controls.Grid]::SetColumn($labelText, 1)
    [void]$titleLine.Children.Add($labelText)
    if ([int]$Payload.count -gt 1) {
        $pill = New-CountPill -Count ([int]$Payload.count) -Accent $accent
        $pill.VerticalAlignment = 'Center'
        [System.Windows.Controls.Grid]::SetColumn($pill, 2)
        [void]$titleLine.Children.Add($pill)
    }
    [System.Windows.Controls.Grid]::SetColumn($titleLine, 0)
    [void]$header.Children.Add($titleLine)

    $newest = ''
    if ($items.Count -gt 0) { $newest = [string]$items[0].at }
    if ([string]::IsNullOrWhiteSpace($newest)) { $newest = [string]$Payload.at }
    if (-not [string]::IsNullOrWhiteSpace($newest)) {
        $headTime = New-Text -Text $newest -Size 10 -Color $script:TextFaint
        $headTime.VerticalAlignment = 'Center'
        $headTime.Margin = New-Object System.Windows.Thickness 8,0,0,0
        [System.Windows.Controls.Grid]::SetColumn($headTime, 1)
        [void]$header.Children.Add($headTime)
    }
    [void]$body.Children.Add($header)

    # Reading order, top to bottom: WHERE (the project folder, biggest), then WHICH
    # task, then why it stopped. You triage a reminder by project first: the folder
    # name is what tells you from across the desk whether this one is even yours.
    # No leading glyph: at 15.5px the name is already the loudest thing on the card,
    # and an icon-font square in front of it just read as a box and stole width.
    $contextText = [string]$Payload.context
    if ($items.Count -eq 0 -and -not [string]::IsNullOrWhiteSpace($contextText)) {
        $contextLabel = New-Text -Text $contextText -Size 15.5 -Color $script:TextPrimary -Weight 'SemiBold'
        $contextLabel.TextTrimming = 'CharacterEllipsis'
        $contextLabel.TextWrapping = 'NoWrap'
        $contextLabel.HorizontalAlignment = 'Left'
        $contextLabel.Margin = New-Object System.Windows.Thickness 0,7,0,0
        [void]$body.Children.Add($contextLabel)
    }

    # One rung down: which task inside that project.
    $headlineText = [string]$Payload.headline
    if (-not [string]::IsNullOrWhiteSpace($headlineText)) {
        $headlineBlock = New-Text -Text $headlineText -Size 12.5 -Color $script:TextBody
        $headlineBlock.TextWrapping = 'Wrap'
        $headlineBlock.TextTrimming = 'CharacterEllipsis'
        $headlineBlock.LineHeight = 18
        $headlineBlock.LineStackingStrategy = 'BlockLineHeight'
        $headlineBlock.MaxHeight = 54
        $headlineBlock.HorizontalAlignment = 'Left'
        $headlineBlock.Margin = New-Object System.Windows.Thickness 0,2,0,0
        [void]$body.Children.Add($headlineBlock)
    }

    # Third line, the smallest rung: what was reported. It is read only after the
    # project and the task told you whether you care.
    $verdictKind = [string]$Payload.verdictKind
    $verdictText = [string]$Payload.verdictText
    if (-not [string]::IsNullOrWhiteSpace($verdictKind) -or -not [string]::IsNullOrWhiteSpace($verdictText)) {
        $verdictRow = New-Object System.Windows.Controls.Grid
        $colVerdictLabel = New-Object System.Windows.Controls.ColumnDefinition
        $colVerdictLabel.Width = [System.Windows.GridLength]::Auto
        $colVerdictBody = New-Object System.Windows.Controls.ColumnDefinition
        $colVerdictBody.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
        [void]$verdictRow.ColumnDefinitions.Add($colVerdictLabel)
        [void]$verdictRow.ColumnDefinitions.Add($colVerdictBody)
        if (-not [string]::IsNullOrWhiteSpace($verdictKind)) {
            # Only add the full-width colon when a reason follows it: the completion
            # word alone reads fine, with a colon and nothing after it it does not.
            $verdictLabelText = $verdictKind
            if (-not [string]::IsNullOrWhiteSpace($verdictText)) { $verdictLabelText = $verdictKind + [string][char]0xFF1A }
            $verdictLabel = New-Text -Text $verdictLabelText -Size 10.5 -Color (Get-KindAccent ([string]$Payload.kind)) -Weight 'SemiBold'
            $verdictLabel.VerticalAlignment = 'Top'
            [System.Windows.Controls.Grid]::SetColumn($verdictLabel, 0)
            [void]$verdictRow.Children.Add($verdictLabel)
        }
        if (-not [string]::IsNullOrWhiteSpace($verdictText)) {
            $verdictBody = New-Text -Text $verdictText -Size 10.5 -Color $script:VerdictText
            $verdictBody.TextWrapping = 'Wrap'
            $verdictBody.TextTrimming = 'CharacterEllipsis'
            $verdictBody.LineHeight = 15
            $verdictBody.LineStackingStrategy = 'BlockLineHeight'
            $verdictBody.MaxHeight = 45
            $verdictBody.VerticalAlignment = 'Top'
            [System.Windows.Controls.Grid]::SetColumn($verdictBody, 1)
            [void]$verdictRow.Children.Add($verdictBody)
        }
        $verdictTint = [string]$Payload.headlineTint
        if ([string]::IsNullOrWhiteSpace($verdictTint)) {
            $verdictRow.Margin = New-Object System.Windows.Thickness 0,6,0,0
            [void]$body.Children.Add($verdictRow)
        } else {
            # Failure and pending decisions get a faint coloured plate so the reason
            # reads as a status, not as more body copy.
            $verdictFrame = New-Object System.Windows.Controls.Border
            $verdictFrame.Background = New-Brush $verdictTint
            $verdictFrame.CornerRadius = New-Object System.Windows.CornerRadius 6
            $verdictFrame.Padding = New-Object System.Windows.Thickness 9,6,9,6
            $verdictFrame.Margin = New-Object System.Windows.Thickness 0,8,0,0
            $verdictFrame.SnapsToDevicePixels = $true
            $verdictFrame.Child = $verdictRow
            [void]$body.Children.Add($verdictFrame)
        }
    }

    # Which project / session this batch came from. A single-alert card already
    # showed the project as its headline line above; a batch lists one project per
    # row, so the shared line would only repeat it.

    if ($items.Count -gt 0) {
        $divider = New-Object System.Windows.Controls.Border
        $divider.Height = 1
        $divider.Background = New-Brush $script:RuleColor
        $divider.Margin = New-Object System.Windows.Thickness 0,11,0,1
        [void]$body.Children.Add($divider)
    }

    foreach ($item in $items) { [void]$body.Children.Add((New-ItemRow $item)) }

    $more = [string]$Payload.more
    if (-not [string]::IsNullOrWhiteSpace($more)) {
        $moreText = New-Text -Text $more -Size 10.5 -Color $script:MoreText
        $moreText.Margin = New-Object System.Windows.Thickness 0,8,0,0
        [void]$body.Children.Add($moreText)
    }

    $footerText = [string]$Payload.footer
    if (-not [string]::IsNullOrWhiteSpace($footerText)) {
        $footer = New-Text -Text $footerText -Size 10 -Color $script:FooterText
        $footer.Margin = New-Object System.Windows.Thickness 0,12,0,0
        [void]$body.Children.Add($footer)
    }

    # The window can be dragged smaller than the content: keep every line
    # reachable by scrolling instead of clipping it away.
    # No scrollbar: the card grows with its content, so nothing is ever cut off.
    [void]$outer.Children.Add($body)
    $card.Child = $outer
    return $card
}

# Which harness window does this card belong to? The Host that spawned us is itself an
# app-named process that owns no window, and a user can run two instances side by side:
# walking the real ancestor chain and keeping the outermost windowed match is the only
# answer that brings forward the window this reminder actually came from.
function Resolve-OwnerWindow {
    if ($script:ownerResolved) { return $script:ownerWindow }
    $script:ownerResolved = $true
    $script:ownerWindow = [IntPtr]::Zero
    $script:ownerPid = 0
    $script:ownerSource = 'none'
    try {
        foreach ($ancestorPid in [Native.Win]::AncestorChain([uint32]$PID, 12)) {
            $proc = Get-Process -Id $ancestorPid -ErrorAction SilentlyContinue
            if ($null -eq $proc) { continue }
            if ($proc.ProcessName -ne $script:DsExeName) { continue }
            if ($proc.MainWindowHandle -eq 0) { continue }
            # Outermost match wins: the window lives in the app's root process, not in
            # the per-session Host that is our direct parent.
            $script:ownerWindow = $proc.MainWindowHandle
            $script:ownerPid = $proc.Id
            $script:ownerSource = 'ancestor'
        }
    } catch { }
    if ($script:ownerWindow -eq [IntPtr]::Zero) {
        # Standalone runs (self test, manual probe) have no harness ancestor.
        try {
            $fallback = Get-Process -Name $script:DsExeName -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
            if ($null -ne $fallback) {
                $script:ownerWindow = $fallback.MainWindowHandle
                $script:ownerPid = $fallback.Id
                $script:ownerSource = 'fallback'
            }
        } catch { }
    }
    return $script:ownerWindow
}

function Test-ForegroundIsDs {
    try {
        $hwnd = [Native.Win]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) { return $false }
        $procId = 0
        [void][Native.Win]::GetWindowThreadProcessId($hwnd, [ref]$procId)
        if ($procId -eq 0) { return $false }
        # Cheap name check first: only the harness case is worth an owner lookup.
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($null -eq $proc) { return $false }
        if ($proc.ProcessName -ne $script:DsExeName) { return $false }
        $owner = Resolve-OwnerWindow
        if ($owner -eq [IntPtr]::Zero) { return $true }
        if ($hwnd -eq $owner) { return $true }
        $ownerPid = 0
        [void][Native.Win]::GetWindowThreadProcessId($owner, [ref]$ownerPid)
        if ($ownerPid -gt 0) { return ($procId -eq $ownerPid) }
        return $true
    } catch {
        return $false
    }
}

# QUNS_* states that mean "do not interrupt now": 1 = locked / screen saver,
# 2 = fullscreen app busy, 3 = Direct3D fullscreen, 4 = presentation mode,
# 7 = immersive fullscreen app (Windows 8+). 5 (accepts notifications) and
# 6 (first hour of a new account) are deliberately left alone.
$script:QuietNotificationStates = @(1, 2, 3, 4, 7)

function Get-NotificationState {
    try {
        $state = 0
        if ([Native.Win]::SHQueryUserNotificationState([ref]$state) -eq 0) { return [int]$state }
    } catch { }
    return 0
}

# Borderless fullscreen (a game in windowed-fullscreen mode, a video player, F11 in a
# browser) is not reported by the shell query, so also compare the foreground window
# rect with its physical monitor rect. Both checks are read-only: nothing is hooked,
# injected, captured or grabbed from the game.
#
# Two shapes look like fullscreen but are not, and used to swallow every card:
#   * the desktop itself (Progman / WorkerW) and the taskbar - their rect is the monitor;
#   * a maximized window - since Windows 10 its extended frame rect also covers the
#     whole monitor, so the taskbar is not what tells them apart.
# Both are excluded before the rect comparison.
$script:ShellWindowClasses = @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd')

function Test-ShellWindowClass {
    param([IntPtr]$Window)
    try {
        $sb = New-Object System.Text.StringBuilder 128
        [void][Native.Win]::GetClassNameW($Window, $sb, 128)
        return ($script:ShellWindowClasses -contains $sb.ToString())
    } catch {
        return $false
    }
}

function Test-ForegroundFullscreen {
    try {
        $hwnd = [Native.Win]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) { return $false }
        if ($hwnd -eq [Native.Win]::GetShellWindow()) { return $false }
        if ([Native.Win]::IsZoomed($hwnd)) { return $false }
        if (Test-ShellWindowClass $hwnd) { return $false }
        $rect = New-Object 'Native.Win+RECT'
        if (-not [Native.Win]::GetWindowRect($hwnd, [ref]$rect)) { return $false }
        $area = [Native.Win]::MonitorBoundsOf([Native.Win]::MonitorFromWindow($hwnd, 2))
        if ($null -eq $area) { return $false }
        # 2px tolerance for DPI rounding.
        return (($rect.Left -le $area[0] + 2) -and ($rect.Top -le $area[1] + 2) -and
            ($rect.Right -ge $area[2] - 2) -and ($rect.Bottom -ge $area[3] - 2))
    } catch {
        return $false
    }
}

function Focus-Ds {
    try {
        $hwnd = Resolve-OwnerWindow
        if ($hwnd -eq [IntPtr]::Zero) { return $false }
        [void][Native.Win]::ShowWindow($hwnd, 9)
        [void][Native.Win]::SetForegroundWindow($hwnd)
        return $true
    } catch {
        return $false
    }
}

function Show-CardWindow {
    param([System.Windows.Window]$Window)
    # The host spawns us with a hidden window station flag (windowsHide / -WindowStyle Hidden),
    # so the first WPF window can come up invisible: force it visible + topmost without activating.
    try {
        $helper = New-Object System.Windows.Interop.WindowInteropHelper $Window
        $hwnd = $helper.Handle
        if ($hwnd -eq [IntPtr]::Zero) { return }
        # WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW: a notification must never become the
        # active window. Without this, any click on the card activates it and pulls
        # focus (and effectively the mouse) away from whatever the user is typing in.
        $exStyle = [Native.Win]::GetWindowLong($hwnd, -20)
        [void][Native.Win]::SetWindowLong($hwnd, -20, ($exStyle -bor 0x08000000 -bor 0x00000080))
        [void][Native.Win]::ShowWindow($hwnd, 4)
        $topmost = New-Object IntPtr -ArgumentList (-1)
        [void][Native.Win]::SetWindowPos($hwnd, $topmost, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010 -bor 0x0040)
    } catch { }
}

# ---------------- remembered position ----------------
# Default placement is the bottom-right corner of the work area. If the user drags
# or resizes the card, the physical rect it ended at is remembered, so the next
# reminder comes back where they left it - but only while that spot still lands on a
# monitor: unplugging the screen must not park the card outside the desktop.
function Get-PlacementPath {
    param([string]$Override)
    if (-not [string]::IsNullOrWhiteSpace($Override)) { return $Override }
    $base = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($base)) { return '' }
    return (Join-Path (Join-Path $base 'dsh-nudge') 'placement.json')
}

function Read-Placement {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        $data = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json
        $left = [int]$data.left
        $top = [int]$data.top
        $bounds = [Native.Win]::MonitorBoundsOfPoint($left, $top)
        if ($null -eq $bounds) { return $null }
        # Keep at least a corner-ish sliver of the card reachable.
        if ($left -lt $bounds[0] -or $left -gt ($bounds[2] - 80)) { return $null }
        if ($top -lt $bounds[1] -or $top -gt ($bounds[3] - 60)) { return $null }
        return @{ left = $left; top = $top }
    } catch {
        return $null
    }
}

function Save-Placement {
    param([IntPtr]$Handle, [string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    if ($Handle -eq [IntPtr]::Zero) { return }
    try {
        $rect = New-Object 'Native.Win+RECT'
        if (-not [Native.Win]::GetWindowRect($Handle, [ref]$rect)) { return }
        $dir = Split-Path -Parent $Path
        if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        $data = @{ left = $rect.Left; top = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
        Set-Content -LiteralPath $Path -Value (($data | ConvertTo-Json -Compress) + [Environment]::NewLine) -Encoding ASCII -NoNewline
    } catch { }
}

# Anything the user moved by hand is worth remembering: the next card opens where
# this one ended instead of jumping back to the corner.
function Save-CurrentPlacement {
    if (-not $script:rememberPosition) { return }
    if ([string]::IsNullOrWhiteSpace($script:placementPath)) { return }
    try {
        $handle = (New-Object System.Windows.Interop.WindowInteropHelper $window).Handle
        Save-Placement -Handle $handle -Path $script:placementPath
    } catch { }
}

# ---------------- single-card slot ----------------
# Only one card may be on screen at a time. Every DSH instance starts its own helper,
# and every helper computes the same bottom-right corner, so a second card would land
# straight on top of the first with its own timer and its own click target. A
# per-session named mutex elects the owner, and a later helper signs the resident card
# off through a named event and takes the slot: the newest reminder always wins
# instead of stacking. If named objects are unavailable this degrades to the old
# behaviour (one card per helper) rather than refusing to show anything.
function Initialize-CardSlot {
    $slot = @{ owned = $false; took = $false }
    try {
        $script:slotMutex = New-Object -TypeName System.Threading.Mutex -ArgumentList $false, 'Local\dsh-nudge-card'
        $script:slotEvent = New-Object -TypeName System.Threading.EventWaitHandle -ArgumentList $false, ([System.Threading.EventResetMode]::AutoReset), 'Local\dsh-nudge-replace'
    } catch {
        $slot.owned = $true
        return $slot
    }
    $acquired = $false
    try { $acquired = [bool]$script:slotMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    if ($acquired) {
        $slot.owned = $true
        return $slot
    }
    try { [void]$script:slotEvent.Set() } catch { }
    try { $acquired = [bool]$script:slotMutex.WaitOne(1200) }
    catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    $slot.owned = $acquired
    $slot.took = $acquired
    return $slot
}

# Polled by the resident card: a newer helper signals this to ask it to step aside.
function Test-CardSlotTakenOver {
    if ($null -eq $script:slotEvent) { return $false }
    try { return [bool]$script:slotEvent.WaitOne(0) } catch { return $false }
}

# ---------------- theme ----------------
# Resolved once, before any surface is built: -Theme wins, then the payload
# (plugin config), then "auto" (follow the Windows app-mode setting).
Set-CardTheme (Resolve-Theme -Requested $Theme -FromPayload '')

# ---------------- snapshot mode ----------------
if (-not [string]::IsNullOrWhiteSpace($Snapshot)) {
    $payload = Resolve-Payload -B64 $PayloadB64 -File $PayloadFile
    if ($null -eq $payload) {
        Write-Status @{ type = 'error'; message = 'snapshot: no payload' }
        exit 2
    }
    # The payload may pin its own theme; the CLI switch keeps the last word.
    Set-CardTheme (Resolve-Theme -Requested $Theme -FromPayload ([string]$payload.theme))
    $cardWidth = if ($SnapshotWidth -gt 0) { $SnapshotWidth } else { $script:CardWidth }
    $card = New-Card $payload -Width $cardWidth
    $size = Measure-Card $card

    # Snapshot output is meant to be published, so it must never contain desktop
    # pixels: render the card on a solid backdrop with a fixed margin.
    $pad = 12
    $frame = New-Object System.Windows.Controls.Border
    $frame.Background = New-Brush $script:FrameBg 
    $frame.Padding = [System.Windows.Thickness]::new($pad)
    $frame.Child = $card
    $frameWidth = $size.Width + ($pad * 2)
    $frameHeight = $size.Height + ($pad * 2)
    $frame.Arrange([System.Windows.Rect]::new(0, 0, $frameWidth, $frameHeight))
    $frame.UpdateLayout()

    $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap $frameWidth, $frameHeight, 96, 96, ([System.Windows.Media.PixelFormats]::Pbgra32)
    $rtb.Render($frame)
    $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
    [void]$encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rtb))
    $stream = [System.IO.File]::Create($Snapshot)
    try { $encoder.Save($stream) } finally { $stream.Close() }
    Write-Status @{ type = 'snapshot'; path = $Snapshot; width = $frameWidth; height = $frameHeight; theme = $script:ThemeName }
    exit 0
}

# ---------------- one-shot mode ----------------
# The plugin starts one helper per batch with the payload already known: show the
# card, then exit when it is clicked or the stay timer fires. No stdin, no daemon.
$payload = Resolve-Payload -B64 $PayloadB64 -File $PayloadFile
if ($null -ne $payload) {
    # Theme before the suppress checks: "shown"/"suppressed" both report it, and the
    # payload is the only place the plugin's config could say otherwise.
    Set-CardTheme (Resolve-Theme -Requested $Theme -FromPayload ([string]$payload.theme))

    if ($SuppressWhenForeground -and (Test-ForegroundIsDs)) {
        Write-Status @{ type = 'suppressed'; reason = 'foreground'; state = 0; theme = $script:ThemeName }
        exit 0
    }

    # Do not interrupt a game, a movie or a slide show: the card would sit on top of
    # it, and showing any topmost window over an exclusive-fullscreen app can make it
    # minimize or flicker. The batch is dropped (not queued) and reported as such.
    if ($SuppressWhenFullscreen) {
        $notificationState = Get-NotificationState
        if (($script:QuietNotificationStates -contains $notificationState) -or (Test-ForegroundFullscreen)) {
            Write-Status @{ type = 'suppressed'; reason = 'fullscreen'; state = $notificationState; theme = $script:ThemeName }
            exit 0
        }
    }

    # Elect the single card for this user session before building anything: if a
    # resident card is up, it has been asked to leave and the slot is ours now.
    $script:slotState = Initialize-CardSlot
    $script:closeReason = ''
    $script:clipboardOk = $false

    # Single-item cards carry no rows, so the host sends a flat summary too.
    $script:lastSummary = [string]$payload.summary
    if ([string]::IsNullOrWhiteSpace($script:lastSummary)) {
        $summaryParts = @()
        foreach ($item in @($payload.items)) {
            if ($null -eq $item) { continue }
            $summaryParts += ("{0}: {1}" -f $item.title, $item.detail)
        }
        $script:lastSummary = ($summaryParts -join ' | ')
    }

    # The clipboard header is supplied by the host: this script stays ASCII-only, so
    # any human-facing Chinese has to arrive in the payload. Fall back to a neutral
    # English line when an older host does not send one.
    $script:clipboardHeader = [string]$payload.clipboardHeader
    if ([string]::IsNullOrWhiteSpace($script:clipboardHeader)) { $script:clipboardHeader = 'DeepSeek Harness session alert' }

    # Default placement is the work-area corner, but a card the user dragged or
    # resized before comes back to that spot. The host owns the toggle and the file
    # location, so this script never has to spell out a user path.
    $script:rememberPosition = -not ($payload.rememberPosition -eq $false)
    $script:placementPath = ''
    $script:placement = $null
    if ($script:rememberPosition) {
        $script:placementPath = Get-PlacementPath -Override ([string]$payload.placementFile)
        $script:placement = Read-Placement -Path $script:placementPath
    }

    $card = New-Card $payload
    $size = Measure-Card $card

    $window = New-Object System.Windows.Window
    $window.WindowStyle = 'None'
    $window.AllowsTransparency = $true
    $window.Background = [System.Windows.Media.Brushes]::Transparent
    $window.UseLayoutRounding = $true
    $window.SnapsToDevicePixels = $true
    $window.ShowInTaskbar = $false
    $window.Topmost = $true
    $window.ResizeMode = 'CanResize'
    $window.ShowActivated = $false
    $window.Focusable = $false
    $window.WindowStartupLocation = 'Manual'
    $window.SizeToContent = 'Manual'
    $window.MinWidth = 260
    $window.MinHeight = 118
    $window.Width = $size.Width
    $window.Height = $size.Height
    # The card follows the window from here on: no fixed width, content reflows
    # into whatever space the user drags out.
    $card.Width = [double]::NaN
    $card.HorizontalAlignment = 'Stretch'
    $card.VerticalAlignment = 'Stretch'
    $window.Content = $card

    # Place the card on the monitor the user is actually looking at: the one that
    # holds the harness window, else the one under the cursor, else the primary.
    # SystemParameters.WorkArea only ever knows the primary monitor.
    $area = $null
    $monitor = [IntPtr]::Zero
    try {
        $dsProc = Get-Process -Name $script:DsExeName -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($null -ne $dsProc) {
            $monitor = [Native.Win]::MonitorOfWindow($dsProc.MainWindowHandle)
            $area = [Native.Win]::WorkAreaOf($monitor)
        }
    } catch { }
    if ($null -eq $area) {
        try {
            $monitor = [Native.Win]::MonitorOfCursor()
            $area = [Native.Win]::WorkAreaOf($monitor)
        } catch { }
    }
    if ($null -eq $area) {
        $monitor = [IntPtr]::Zero
        $work = [System.Windows.SystemParameters]::WorkArea
        $area = @([int]$work.Left, [int]$work.Top, [int]$work.Right, [int]$work.Bottom)
    }
    # Keep the chosen monitor's work area for the post-layout correction below.
    $script:targetArea = $area
    # Margin is a device-independent unit. On a scaled monitor it must grow with the
    # DPI, otherwise a 16px margin turns into ~11 real pixels at 150%.
    $scale = 1.0
    if ($script:DpiPerMonitor) {
        $dpi = [Native.Win]::DpiOf($monitor)
        if ($dpi -gt 0) { $scale = $dpi / 96.0 }
    }
    $script:marginPx = [int][Math]::Round($Margin * $scale)
    $script:scale = $scale
    # Convert the physical work area into the DIP space WPF positions windows in.
    # The shadow halo is transparent and sits inside the window, so the window has to
    # overshoot the corner by ShadowPad for the visible border to land exactly Margin
    # away from the work-area edge.
    $script:padPx = [int][Math]::Round($script:ShadowPad * $scale)
    $window.Left = ($area[2] / $scale) - $window.Width - $Margin + $script:ShadowPad
    $window.Top = ($area[3] / $scale) - $window.Height - $Margin + $script:ShadowPad

    $script:shownAt = [DateTime]::UtcNow
    $slide = New-Object System.Windows.Media.TranslateTransform 0, 10
    $card.RenderTransform = $slide
    $window.Opacity = 0

    $card.Add_MouseEnter({
            try { $card.BorderBrush = New-Brush $script:CardEdgeHover } catch { }
            # Looking at the card should not cost you the card: hovering restarts
            # the dwell instead of letting the original countdown run out mid-read.
            try { $timer.Stop(); $timer.Start() } catch { }
        })
    $card.Add_MouseLeave({ try { $card.BorderBrush = New-Brush $script:cardEdgeNow } catch { } })

    # A transparent window has no non-client area, so the resize gesture has to be
    # handed to the system ourselves: press on an edge -> ReleaseCapture + a
    # WM_NCLBUTTONDOWN with the matching HT code starts the native sizing loop.
    $script:edgeHit = {
            param($point)
            # The card is inset by ShadowPad, so a band measured from the window
            # edge must reach past the halo to cover the visible border.
            $edge = $script:ShadowPad + 6
            $width = $window.ActualWidth
            $height = $window.ActualHeight
            $left = $point.X -lt $edge
            $right = $point.X -gt ($width - $edge)
            $top = $point.Y -lt $edge
            $bottom = $point.Y -gt ($height - $edge)
            if ($left -and $top) { return 13 }
            if ($right -and $top) { return 14 }
            if ($left -and $bottom) { return 16 }
            if ($right -and $bottom) { return 17 }
            if ($left) { return 10 }
            if ($right) { return 11 }
            if ($top) { return 12 }
            if ($bottom) { return 15 }
            return 0
        }

    # A press that lands while the card is still fading in almost always belongs to
    # whatever the user was clicking before the card appeared. Eating it is exactly
    # what makes a popup feel like it grabbed the mouse.
    $script:pressGrace = 320
    $script:pressActive = $false
    $script:dragging = $false
    $script:resizing = $false
    $script:pressX = 0.0
    $script:pressY = 0.0

    $window.Add_PreviewMouseMove({
            param($sender, $eventArgs)
            try {
                $point = $eventArgs.GetPosition($window)
                $code = & $script:edgeHit $point
                $cursor = [System.Windows.Input.Cursors]::Arrow
                if ($code -eq 13 -or $code -eq 17) { $cursor = [System.Windows.Input.Cursors]::SizeNWSE }
                elseif ($code -eq 14 -or $code -eq 16) { $cursor = [System.Windows.Input.Cursors]::SizeNESW }
                elseif ($code -eq 10 -or $code -eq 11) { $cursor = [System.Windows.Input.Cursors]::SizeWE }
                elseif ($code -eq 12 -or $code -eq 15) { $cursor = [System.Windows.Input.Cursors]::SizeNS }
                if ($card.Cursor -ne $cursor) { $card.Cursor = $cursor }
                # Only a press that actually travels becomes a drag. A plain click
                # never enters the native move loop, so it never captures the mouse.
                if ($script:pressActive -and -not $script:dragging) {
                    if (([Math]::Abs($point.X - $script:pressX) + [Math]::Abs($point.Y - $script:pressY)) -gt 4) {
                        $script:dragging = $true
                        try { $window.DragMove() } catch { }
                        Save-CurrentPlacement
                        try { $timer.Stop(); $timer.Start() } catch { }
                    }
                }
            } catch { }
        })

    $window.Add_PreviewMouseLeftButtonDown({
            param($sender, $eventArgs)
            try {
                if (([DateTime]::UtcNow - $script:shownAt).TotalMilliseconds -lt $script:pressGrace) {
                    $eventArgs.Handled = $true
                    return
                }
                $point = $eventArgs.GetPosition($window)
                $code = & $script:edgeHit $point
                if ($code -eq 0) {
                    $script:pressActive = $true
                    $script:dragging = $false
                    $script:pressX = $point.X
                    $script:pressY = $point.Y
                    # The dwell timer keeps running on purpose: stopping it here
                    # pinned the card forever whenever the button came up outside
                    # the window, because the mouse-up never reached us again.
                    return
                }
                $eventArgs.Handled = $true
                $script:resizing = $true
                $handle = (New-Object System.Windows.Interop.WindowInteropHelper $window).Handle
                [void][Native.Win]::ReleaseCapture()
                [void][Native.Win]::SendMessage($handle, 0x00A1, [IntPtr]$code, [IntPtr]::Zero)
                $script:resizing = $false
                Save-CurrentPlacement
                $script:pressActive = $false
                try { $timer.Stop(); $timer.Start() } catch { }
            } catch { }
        })

    # Right click just gets rid of the card: no focus change, no clipboard write.
    $window.Add_MouseRightButtonUp({ $script:closeReason = 'dismissed'; try { $window.Close() } catch { } })

    # A press that never travels is a click and keeps the original behaviour
    # (focus the harness, copy the batch, close).
    $window.Add_MouseLeftButtonUp({
            try {
                if ($script:resizing) { $script:resizing = $false; return }
                if ($script:dragging) { $script:dragging = $false; $script:pressActive = $false; return }
                if (-not $script:pressActive) { return }
                $script:pressActive = $false
                $script:closeReason = 'clicked'
                try { [void](Focus-Ds) } catch { }
                # The clipboard can be held hostage by another process; a silent
                # failure would leave the user believing the batch was copied. Record
                # the outcome so the status line can report it instead.
                try {
                    if (-not [string]::IsNullOrWhiteSpace($script:lastSummary)) {
                        Set-Clipboard -Value ($script:clipboardHeader + [Environment]::NewLine + $script:lastSummary)
                        $script:clipboardOk = $true
                    }
                } catch { $script:clipboardOk = $false }
                try { $window.Close() } catch { }
            } catch { }
        })

    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromSeconds([Math]::Max(1, $StaySeconds))
    $timer.Add_Tick({
            # Never close while the pointer is still down, but keep re-arming: a
            # lost mouse-up then just costs one more interval instead of leaving a
            # topmost card stuck on screen.
            if ([System.Windows.Input.Mouse]::LeftButton -eq 'Pressed') {
                $timer.Start()
                return
            }
            $timer.Stop()
            $script:closeReason = 'timeout'
            try { $window.Close() } catch { }
        })

    # Absolute lifetime cap. Whatever happens to the mouse, the card goes away.
    $script:hardDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(30, ($StaySeconds * 4) + 30))
    $script:watchdog = New-Object System.Windows.Threading.DispatcherTimer
    $script:watchdog.Interval = [TimeSpan]::FromSeconds(5)
    $script:watchdog.Add_Tick({
            $script:watchdog.Stop()
            if ([DateTime]::UtcNow -ge $script:hardDeadline) { $script:closeReason = 'watchdog'; try { $window.Close() } catch { } }
            else { $script:watchdog.Start() }
        })
    $script:watchdog.Start()

    # A newer helper asks this card to step aside through the slot event. Poll it on
    # the UI thread so the close happens on the same thread as every other close.
    $script:replacePoll = New-Object System.Windows.Threading.DispatcherTimer
    $script:replacePoll.Interval = [TimeSpan]::FromMilliseconds(200)
    $script:replacePoll.Add_Tick({
            if (Test-CardSlotTakenOver) {
                $script:replacePoll.Stop()
                $script:closeReason = 'replaced'
                try { $window.Close() } catch { }
            }
        })
    try { $script:replacePoll.Start() } catch { }

    $app = New-Object System.Windows.Application
    $app.ShutdownMode = 'OnExplicitShutdown'

    $window.Add_SizeChanged({
            if (-not [bool]$script:cardReady) { return }
            # Widen/narrow reflows the text, so the card may need more height than
            # the window has. Lift MinHeight instead of clipping or scrolling.
            try {
                # Measure at the width we are about to have: DesiredSize still
                # describes the previous layout pass, so trusting it lags one
                # resize step and can leave the card clipped.
                $probeWidth = [Math]::Max(120, $window.ActualWidth - (2 * $script:ShadowPad))
                $card.Measure([System.Windows.Size]::new($probeWidth, [double]::PositiveInfinity))
                $needed = $card.DesiredSize.Height
                # Always re-derive the floor from the current width: only raising it
                # would leave the window stuck tall after a narrow-then-wide drag.
                if ($needed -gt 0) { $window.MinHeight = [Math]::Max(90, $needed) }
            } catch { }
            try { $timer.Stop(); $timer.Start() } catch { }
        })

    $window.Add_Loaded({
            Show-CardWindow -Window $window
            # Final placement in physical pixels. WPF positioned the window through
            # DIPs, which can disagree with the monitor's work area once scaling is in
            # play; re-pin it to the chosen area's bottom-right corner and let the
            # system do the arithmetic. On a 100% single screen this is a no-op.
            try {
                $handle = (New-Object System.Windows.Interop.WindowInteropHelper $window).Handle
                $rect = New-Object 'Native.Win+RECT'
                if ([Native.Win]::GetWindowRect($handle, [ref]$rect)) {
                    if ($null -ne $script:placement) {
                        # A spot the user picked by hand. Read-Placement already
                        # dropped anything that no longer lands on a monitor.
                        $targetLeft = [int]$script:placement.left
                        $targetTop = [int]$script:placement.top
                    } else {
                        $targetLeft = $script:targetArea[2] - ($rect.Right - $rect.Left) - $script:marginPx + $script:padPx
                        $targetTop = $script:targetArea[3] - ($rect.Bottom - $rect.Top) - $script:marginPx + $script:padPx
                    }
                    $topmost = New-Object IntPtr -ArgumentList (-1)
                    [void][Native.Win]::SetWindowPos($handle, $topmost, $targetLeft, $targetTop, 0, 0, (0x0001 -bor 0x0010 -bor 0x0040))
                    $script:placedLeft = [int]$targetLeft
                    $script:placedTop = [int]$targetTop
                }
            } catch { }
            $script:cardReady = $true
            try {
                $fade = New-Object System.Windows.Media.Animation.DoubleAnimation 0, 1, ([System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(180)))
                $window.BeginAnimation([System.Windows.Window]::OpacityProperty, $fade)
                $ease = New-Object System.Windows.Media.Animation.QuadraticEase
                $ease.EasingMode = 'EaseOut'
                $move = New-Object System.Windows.Media.Animation.DoubleAnimation 10, 0, ([System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(220)))
                $move.EasingFunction = $ease
                $slide.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $move)
            } catch { }
            $timer.Start()
            # Resolve the owner once here so a click never pays the lookup cost, and so
            # the status line can prove which process the card would focus.
            [void](Resolve-OwnerWindow)
            Write-Status @{ type = 'shown'; count = [int]$payload.count; theme = $script:ThemeName; left = [int]$window.Left; top = [int]$window.Top; placedLeft = [int]$script:placedLeft; placedTop = [int]$script:placedTop; placement = $(if ($null -ne $script:placement) { 'remembered' } else { 'corner' }); width = [int]$window.Width; height = [int]$window.Height; dpi = $script:DpiMode; scale = [double]$script:scale; marginPx = [int]$script:marginPx; padPx = [int]$script:padPx; owner = [int]$script:ownerPid; ownerSrc = $script:ownerSource; slot = $(if ($script:slotState.took) { 'replaced' } elseif ($script:slotState.owned) { 'owner' } else { 'parallel' }) }
        })
    $window.Add_Closed({
            try { $script:replacePoll.Stop() } catch { }
            # One line on the way out tells the host how the card ended and whether the
            # batch actually reached the clipboard, which used to fail silently.
            $reason = if ($script:closeReason -ne '') { $script:closeReason } else { 'closed' }
            if ($reason -eq 'clicked') {
                Write-Status @{ type = 'closed'; reason = $reason; clipboard = [bool]$script:clipboardOk }
            } else {
                Write-Status @{ type = 'closed'; reason = $reason }
            }
            try { $app.Shutdown() } catch { }
        })

    try {
        [void]$window.Show()
        [void]$app.Run()
    } catch {
        Write-Status @{ type = 'error'; message = $_.Exception.Message }
        exit 1
    }
    exit 0
}

Write-Status @{ type = 'error'; message = 'no payload: pass -PayloadB64 or -PayloadFile' }
exit 2
