# dsh-nudge popup helper (Windows PowerShell 5.1, STA required)
#
# Two modes:
#   1. daemon (default): reads one-line JSON commands from stdin and keeps ONE window.
#        {"type":"show","b64":"<payload JSON, UTF-8, base64>"}
#        {"type":"show","file":"<payload.json path>"}     (fallback)
#        {"type":"quit"}
#      base64 is preferred: the control line stays pure ASCII, so neither the
#      console code page nor the pipe encoding can corrupt Chinese text.
#   2. snapshot: -Snapshot <out.png> (-PayloadB64 <b64> | -PayloadFile <path>)
#      Renders the same card offline (no window) so layout can be verified in
#      automated tests and headless runs.
#
# stdout protocol (one JSON per line):
#   {"type":"shown","count":N} | {"type":"suppressed"} | {"type":"clicked"}
#   {"type":"error","message":"..."} | {"type":"snapshot","path":"..."}
#
# This script stays ASCII-only on purpose: Windows PowerShell 5.1 reads non-BOM
# scripts as ANSI, so any literal CJK here would be mojibake.

param(
    [int]$StaySeconds = 8,
    [int]$Margin = 16,
    [switch]$SuppressWhenForeground,
    [string]$DsProcess = 'DeepSeek Harness',
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
'@

try { [void][Native.Win]::SetProcessDPIAware() } catch { }

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

# Palette: one dark surface with a slight vertical lift, plus a four-step
# text ramp. Every colour below is referenced from here so the card stays
# consistent if a token changes.
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
    $title = New-Text -Text ("$($Item.title)$suffix") -Size 13 -Color '#F2FFFFFF' -Weight 'SemiBold'
    $title.TextTrimming = 'CharacterEllipsis'
    $title.TextWrapping = 'NoWrap'
    $title.HorizontalAlignment = 'Left'
    [void]$stack.Children.Add($title)

    # Which project this row belongs to, spelled out under the task name, so a
    # glance tells you both "what" and "where". A grid, not a horizontal stack:
    # a stack measures children with infinite width, which silently disables
    # wrapping and pushes long detail past the card edge.
    $metaText = [string]$Item.detail
    $rowProject = [string]$Item.rowProject
    if (-not [string]::IsNullOrWhiteSpace($rowProject) -or -not [string]::IsNullOrWhiteSpace($metaText)) {
        $meta = New-Object System.Windows.Controls.Grid
        $meta.Margin = New-Object System.Windows.Thickness 0,3,0,0
        $colMetaLeft = New-Object System.Windows.Controls.ColumnDefinition
        $colMetaLeft.Width = [System.Windows.GridLength]::Auto
        $colMetaRight = New-Object System.Windows.Controls.ColumnDefinition
        $colMetaRight.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
        [void]$meta.ColumnDefinitions.Add($colMetaLeft)
        [void]$meta.ColumnDefinitions.Add($colMetaRight)
        if (-not [string]::IsNullOrWhiteSpace($rowProject)) {
            $left = New-Object System.Windows.Controls.StackPanel
            $left.Orientation = 'Horizontal'
            $left.VerticalAlignment = 'Top'
            $folder = New-Text -Text ([string][char]0xE8B7) -Size 9.5 -Color $script:TextMuted
            $folder.FontFamily = New-Object System.Windows.Media.FontFamily $script:IconFont
            $folder.Margin = New-Object System.Windows.Thickness 0,0,4,0
            [void]$left.Children.Add($folder)
            $projectLabel = New-Text -Text $rowProject -Size 10.5 -Color $script:TextBody
            $projectLabel.TextTrimming = 'CharacterEllipsis'
            $projectLabel.TextWrapping = 'NoWrap'
            $projectLabel.MaxWidth = 132
            [void]$left.Children.Add($projectLabel)
            if (-not [string]::IsNullOrWhiteSpace($metaText)) {
                $sep = New-Text -Text (' ' + [string][char]0x00B7 + ' ') -Size 10.5 -Color $script:TextGhost
                [void]$left.Children.Add($sep)
            }
            [System.Windows.Controls.Grid]::SetColumn($left, 0)
            [void]$meta.Children.Add($left)
        }
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
            [System.Windows.Controls.Grid]::SetColumn($detail, 1)
            [void]$meta.Children.Add($detail)
        }
        [void]$stack.Children.Add($meta)
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
    if ($kindName -eq 'failed') { $script:cardEdgeNow = '#4DE74C3C' }
    elseif ($kindName -eq 'needs_choice') { $script:cardEdgeNow = '#45F5A623' }
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
    $shadow.Opacity = 0.42
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

    # Reading order, top to bottom: WHICH task (biggest), then whether it worked and
    # why, then which project. The task name is the one thing that has to be legible
    # from across the desk, so it gets the largest type on the card.
    $headlineText = [string]$Payload.headline
    if (-not [string]::IsNullOrWhiteSpace($headlineText)) {
        $headlineBlock = New-Text -Text $headlineText -Size 15.5 -Color '#FAFFFFFF' -Weight 'SemiBold'
        $headlineBlock.TextWrapping = 'Wrap'
        $headlineBlock.TextTrimming = 'CharacterEllipsis'
        $headlineBlock.LineHeight = 21
        $headlineBlock.LineStackingStrategy = 'BlockLineHeight'
        $headlineBlock.MaxHeight = 63
        $headlineBlock.HorizontalAlignment = 'Left'
        $headlineBlock.Margin = New-Object System.Windows.Thickness 0,7,0,0
        [void]$body.Children.Add($headlineBlock)
    }

    # Second line: what happened, in one short sentence.
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
            $verdictLabel = New-Text -Text $verdictLabelText -Size 11.5 -Color (Get-KindAccent ([string]$Payload.kind)) -Weight 'SemiBold'
            $verdictLabel.VerticalAlignment = 'Top'
            [System.Windows.Controls.Grid]::SetColumn($verdictLabel, 0)
            [void]$verdictRow.Children.Add($verdictLabel)
        }
        if (-not [string]::IsNullOrWhiteSpace($verdictText)) {
            $verdictBody = New-Text -Text $verdictText -Size 11.5 -Color '#DCFFFFFF'
            $verdictBody.TextWrapping = 'Wrap'
            $verdictBody.TextTrimming = 'CharacterEllipsis'
            $verdictBody.LineHeight = 16
            $verdictBody.LineStackingStrategy = 'BlockLineHeight'
            $verdictBody.MaxHeight = 48
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

    # Which project / session this batch came from, one muted line under the header.
    $contextText = [string]$Payload.context
    if (-not [string]::IsNullOrWhiteSpace($contextText)) {
        $contextLine = New-Object System.Windows.Controls.StackPanel
        $contextLine.Orientation = 'Horizontal'
        $contextLine.Margin = New-Object System.Windows.Thickness 0,6,0,0
        $folderIcon = New-Text -Text ([string][char]0xE8B7) -Size 10 -Color $script:TextFaint
        $folderIcon.FontFamily = New-Object System.Windows.Media.FontFamily $script:IconFont
        $folderIcon.Margin = New-Object System.Windows.Thickness 0,0,5,1
        [void]$contextLine.Children.Add($folderIcon)
        $contextLabel = New-Text -Text $contextText -Size 11 -Color $script:TextMuted
        $contextLabel.TextTrimming = 'CharacterEllipsis'
        $contextLabel.TextWrapping = 'NoWrap'
        [void]$contextLine.Children.Add($contextLabel)
        [void]$body.Children.Add($contextLine)
    }

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
        $moreText = New-Text -Text $more -Size 10.5 -Color '#75FFFFFF'
        $moreText.Margin = New-Object System.Windows.Thickness 0,8,0,0
        [void]$body.Children.Add($moreText)
    }

    $footerText = [string]$Payload.footer
    if (-not [string]::IsNullOrWhiteSpace($footerText)) {
        $footer = New-Text -Text $footerText -Size 10 -Color '#59FFFFFF'
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

function Test-ForegroundIsDs {
    try {
        $hwnd = [Native.Win]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) { return $false }
        $procId = 0
        [void][Native.Win]::GetWindowThreadProcessId($hwnd, [ref]$procId)
        if ($procId -eq 0) { return $false }
        $proc = Get-Process -Id $procId -ErrorAction Stop
        return ($proc.ProcessName -eq $script:DsExeName)
    } catch {
        return $false
    }
}

function Focus-Ds {
    try {
        $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ProcessName -eq $script:DsExeName -and $_.MainWindowHandle -ne 0
        } | Select-Object -First 1
        if ($null -eq $proc) { return $false }
        [void][Native.Win]::ShowWindow($proc.MainWindowHandle, 9)
        [void][Native.Win]::SetForegroundWindow($proc.MainWindowHandle)
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

# ---------------- snapshot mode ----------------
if (-not [string]::IsNullOrWhiteSpace($Snapshot)) {
    $payload = Resolve-Payload -B64 $PayloadB64 -File $PayloadFile
    if ($null -eq $payload) {
        Write-Status @{ type = 'error'; message = 'snapshot: no payload' }
        exit 2
    }
    $cardWidth = if ($SnapshotWidth -gt 0) { $SnapshotWidth } else { $script:CardWidth }
    $card = New-Card $payload -Width $cardWidth
    $size = Measure-Card $card

    # Snapshot output is meant to be published, so it must never contain desktop
    # pixels: render the card on a solid backdrop with a fixed margin.
    $pad = 12
    $frame = New-Object System.Windows.Controls.Border
    $frame.Background = New-Brush '#FF1F1F1F'
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
    Write-Status @{ type = 'snapshot'; path = $Snapshot; width = $frameWidth; height = $frameHeight }
    exit 0
}

# ---------------- one-shot mode ----------------
# The plugin starts one helper per batch with the payload already known: show the
# card, then exit when it is clicked or the stay timer fires. No stdin, no daemon.
$payload = Resolve-Payload -B64 $PayloadB64 -File $PayloadFile
if ($null -ne $payload) {
    if ($SuppressWhenForeground -and (Test-ForegroundIsDs)) {
        Write-Status @{ type = 'suppressed' }
        exit 0
    }

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
    try {
        $dsProc = Get-Process -Name $script:DsExeName -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($null -ne $dsProc) { $area = [Native.Win]::WorkAreaOfWindow($dsProc.MainWindowHandle) }
    } catch { }
    if ($null -eq $area) { try { $area = [Native.Win]::WorkAreaOfCursor() } catch { } }
    if ($null -eq $area) {
        $work = [System.Windows.SystemParameters]::WorkArea
        $area = @([int]$work.Left, [int]$work.Top, [int]$work.Right, [int]$work.Bottom)
    }
    $window.Left = $area[2] - $window.Width - $Margin
    $window.Top = $area[3] - $window.Height - $Margin

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
                $script:pressActive = $false
                try { $timer.Stop(); $timer.Start() } catch { }
            } catch { }
        })

    # Right click just gets rid of the card: no focus change, no clipboard write.
    $window.Add_MouseRightButtonUp({ try { $window.Close() } catch { } })

    # A press that never travels is a click and keeps the original behaviour
    # (focus the harness, copy the batch, close).
    $window.Add_MouseLeftButtonUp({
            try {
                if ($script:resizing) { $script:resizing = $false; return }
                if ($script:dragging) { $script:dragging = $false; $script:pressActive = $false; return }
                if (-not $script:pressActive) { return }
                $script:pressActive = $false
                try { [void](Focus-Ds) } catch { }
                try {
                    if (-not [string]::IsNullOrWhiteSpace($script:lastSummary)) {
                        Set-Clipboard -Value ('DeepSeekRuntime session alert' + [Environment]::NewLine + $script:lastSummary)
                    }
                } catch { }
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
            try { $window.Close() } catch { }
        })

    # Absolute lifetime cap. Whatever happens to the mouse, the card goes away.
    $script:hardDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(30, ($StaySeconds * 4) + 30))
    $script:watchdog = New-Object System.Windows.Threading.DispatcherTimer
    $script:watchdog.Interval = [TimeSpan]::FromSeconds(5)
    $script:watchdog.Add_Tick({
            $script:watchdog.Stop()
            if ([DateTime]::UtcNow -ge $script:hardDeadline) { try { $window.Close() } catch { } }
            else { $script:watchdog.Start() }
        })
    $script:watchdog.Start()

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
            Write-Status @{ type = 'shown'; count = [int]$payload.count; left = [int]$window.Left; top = [int]$window.Top; width = [int]$window.Width; height = [int]$window.Height }
        })
    $window.Add_Closed({ try { $app.Shutdown() } catch { } })

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
