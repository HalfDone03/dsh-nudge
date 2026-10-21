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
    [string]$PayloadB64 = ''
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
    $title = New-Text -Text ("$($Item.title)$suffix") -Size 12 -Color $script:TextBody -Weight 'SemiBold'
    $title.TextTrimming = 'CharacterEllipsis'
    $title.TextWrapping = 'NoWrap'
    $title.HorizontalAlignment = 'Left'
    [void]$stack.Children.Add($title)

    $detailText = [string]$Item.detail
    if (-not [string]::IsNullOrWhiteSpace($detailText)) {
        $detail = New-Text -Text $detailText -Size 11 -Color $script:TextMuted
        $detail.TextWrapping = 'Wrap'
        $detail.TextTrimming = 'CharacterEllipsis'
        $detail.LineHeight = 15
        $detail.LineStackingStrategy = 'BlockLineHeight'
        $detail.Height = 30
        $detail.Margin = New-Object System.Windows.Thickness 0,3,0,0
        $detail.HorizontalAlignment = 'Left'
        [void]$stack.Children.Add($detail)
    }
    [void]$row.Children.Add($stack)

    $time = New-Text -Text ([string]$Item.at) -Size 10 -Color $script:TextGhost
    $time.VerticalAlignment = 'Top'
    $time.Margin = New-Object System.Windows.Thickness 10,2,0,0
    [System.Windows.Controls.Grid]::SetColumn($time, 2)
    [void]$row.Children.Add($time)
    return $row
}

function New-Card {
    param($Payload, [int]$Width = $script:CardWidth)
    $accent = [string]$Payload.accent
    if ([string]::IsNullOrWhiteSpace($accent)) { $accent = Get-KindAccent ([string]$Payload.kind) }
    $items = @($Payload.items | Where-Object { $null -ne $_ })

    $card = New-Object System.Windows.Controls.Border
    $card.Width = $Width
    $card.CornerRadius = New-Object System.Windows.CornerRadius $script:CardRadius
    $card.Background = New-VerticalGradient -Top $script:CardTop -Bottom $script:CardBottom
    $card.BorderBrush = New-Brush $script:CardEdge
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

    $titleLine = New-Object System.Windows.Controls.StackPanel
    $titleLine.Orientation = 'Horizontal'
    [void]$titleLine.Children.Add((New-Badge -Accent $accent -Glyph ([string]$Payload.glyph)))
    [void]$titleLine.Children.Add((New-Text -Text ([string]$Payload.label) -Size 14 -Color $script:TextPrimary -Weight 'SemiBold'))
    if ([int]$Payload.count -gt 1) {
        [void]$titleLine.Children.Add((New-CountPill -Count ([int]$Payload.count) -Accent $accent))
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
        $moreText.Margin = New-Object System.Windows.Thickness 16,8,0,0
        [void]$body.Children.Add($moreText)
    }

    $footerText = [string]$Payload.footer
    if (-not [string]::IsNullOrWhiteSpace($footerText)) {
        $footer = New-Text -Text $footerText -Size 10 -Color '#59FFFFFF'
        $footer.Margin = New-Object System.Windows.Thickness 0,12,0,0
        [void]$body.Children.Add($footer)
    }

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
    $card = New-Card $payload
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

    $summaryParts = @()
    foreach ($item in @($payload.items)) {
        if ($null -eq $item) { continue }
        $summaryParts += ("{0}: {1}" -f $item.title, $item.detail)
    }
    $script:lastSummary = ($summaryParts -join ' | ')

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
    $window.ResizeMode = 'NoResize'
    $window.ShowActivated = $false
    $window.WindowStartupLocation = 'Manual'
    $window.SizeToContent = 'Manual'
    $window.Width = $size.Width
    $window.Height = $size.Height
    $window.Content = $card

    $work = [System.Windows.SystemParameters]::WorkArea
    $window.Left = $work.Right - $window.Width - $Margin
    $window.Top = $work.Bottom - $window.Height - $Margin

    $slide = New-Object System.Windows.Media.TranslateTransform 0, 10
    $card.RenderTransform = $slide
    $window.Opacity = 0

    $card.Add_MouseEnter({ try { $card.BorderBrush = New-Brush $script:CardEdgeHover } catch { } })
    $card.Add_MouseLeave({ try { $card.BorderBrush = New-Brush $script:CardEdge } catch { } })

    $window.Add_MouseLeftButtonDown({
            try { [void](Focus-Ds) } catch { }
            try {
                if (-not [string]::IsNullOrWhiteSpace($script:lastSummary)) {
                    Set-Clipboard -Value ('DeepSeek Harness session alert' + [Environment]::NewLine + $script:lastSummary)
                }
            } catch { }
            try { $window.Close() } catch { }
        })

    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromSeconds([Math]::Max(1, $StaySeconds))
    $timer.Add_Tick({
            $timer.Stop()
            try { $window.Close() } catch { }
        })

    $app = New-Object System.Windows.Application
    $app.ShutdownMode = 'OnExplicitShutdown'

    $window.Add_Loaded({
            Show-CardWindow -Window $window
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
