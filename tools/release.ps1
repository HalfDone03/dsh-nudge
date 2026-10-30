<#
.SYNOPSIS
    一条命令走完一次发版：版本号 → CHANGELOG 标题 → 提交 → tag → index 指针 → GitHub Release → push。

.DESCRIPTION
    发版手滑过几次（忘了打 tag、忘了建 Release、index.json 指针忘了跟），所以把顺序固化下来。
    每一步都可重入：中途失败后修好再跑，已完成的步骤会跳过或幂等重做。

.PARAMETER Version
    目标版本号，形如 0.3.1。必须比 package.json 里的当前版本大。

.PARAMETER DryRun
    只打印计划，不写文件、不提交、不推送。

.PARAMETER SkipChecks
    跳过自测（不推荐；CI 也会跑一遍，只是本地快一点）。

.PARAMETER NoPush
    做完本地提交与 tag，但不 push、不建 Release。

.PARAMETER NoRelease
    只 push，不建 GitHub Release。

.PARAMETER Title
    覆盖 tag / Release 标题里那句摘要。默认取该版 CHANGELOG 的第一条 bullet
    （去掉 markdown 记号、截到 60 字）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\release.ps1 -Version 0.3.1 -DryRun

.NOTES
    本机默认 ExecutionPolicy 禁止直接跑 .ps1，所以用上面的 powershell -File 形式；
    这个文件带 UTF-8 BOM，因为 5.1 会把无 BOM 的 UTF-8 当 ANSI 读，中文提示会吃引号。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$Title,
    [switch]$DryRun,
    [switch]$SkipChecks,
    [switch]$NoPush,
    [switch]$NoRelease
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
    function Say([string]$text) { Write-Host "  $text" }
    function Step([string]$text) { Write-Host "`n== $text ==" -ForegroundColor Cyan }
    function Fail([string]$text) { Write-Host "  !! $text" -ForegroundColor Red; throw $text }

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    function Read-Text([string]$path) { [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) }
    function Write-Text([string]$path, [string]$text) { [System.IO.File]::WriteAllText($path, $text, $utf8) }

    # ---------- 预检 ----------
    Step "预检"
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "版本号要写成 0.3.1 这样：$Version" }

    $packagePath = Join-Path $repo 'package.json'
    $changelogPath = Join-Path $repo 'CHANGELOG.md'
    $indexPath = Join-Path $repo 'index.json'

    $packageText = Read-Text $packagePath
    if ($packageText -notmatch '"version"\s*:\s*"(\d+\.\d+\.\d+)"') { Fail 'package.json 里找不到 version' }
    $current = $Matches[1]
    if ([version]$Version -le [version]$current) { Fail "版本号没往前走：当前 $current，要发 $Version" }
    Say "当前 $current -> 目标 $Version"

    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    if ($branch -ne 'main') { Fail "当前在 $branch 分支，发版只在 main 上做" }
    $dirty = @(git status --porcelain)
    if ($dirty.Count -gt 0) {
        Say '工作树不干净：'
        $dirty | ForEach-Object { Say "   $_" }
        Fail '先提交或撤销这些改动再发版'
    }
    Say "分支 main，工作树干净"

    $changelog = Read-Text $changelogPath
    if ($changelog -notmatch '(?m)^## 未发布\s*$') { Fail 'CHANGELOG.md 顶部没有「## 未发布」，是不是已经发过了？' }

    $tagName = "v$Version"
    $tagExists = git tag --list $tagName
    if ($tagExists) { Fail "tag $tagName 已存在" }

    if ($DryRun) { Say "（dry run：下面只打印计划，不写任何文件）" }

    # ---------- 自测 ----------
    if (-not $SkipChecks) {
        Step "自测"
        $node = 'node'
        $depsScript = Join-Path $repo 'scripts\dsh-deps.ps1'
        if (Test-Path $depsScript) {
            . $depsScript
            $bundledDeps = Find-DshDependencies
            if ($null -ne $bundledDeps) { $node = $bundledDeps.Node }
        }
        Say "node: $node"
        foreach ($target in 'lib\index.js', 'scripts\selftest.mjs') {
            & $node --check (Join-Path $repo $target)
            if ($LASTEXITCODE -ne 0) { Fail "$target 语法检查没过" }
        }
        Say 'node --check 通过'
        $out = & $node (Join-Path $repo 'scripts\selftest.mjs') 2>&1
        $tail = ($out | Select-Object -Last 1)
        Say "selftest: $tail"
        if ($LASTEXITCODE -ne 0) { $out | Select-Object -Last 12 | ForEach-Object { Say "   $_" }; Fail '自测没过，不发版' }
    } else {
        Step "自测（已跳过）"
    }

    # ---------- 版本号 + CHANGELOG 标题 ----------
    Step "改版本号与 CHANGELOG 标题"
    $today = Get-Date -Format 'yyyy-MM-dd'
    $newPackage = $packageText -replace '("version"\s*:\s*")\d+\.\d+\.\d+(")', ('${1}' + $Version + '${2}')
    $newChangelog = $changelog -replace '(?m)^## 未发布\s*$', "## $Version - $today"
    Say "package.json: $current -> $Version"
    Say "CHANGELOG.md: ## 未发布 -> ## $Version - $today"
    if (-not $DryRun) {
        Write-Text $packagePath $newPackage
        Write-Text $changelogPath $newChangelog
    }

    # 从 CHANGELOG 的这一段切出 Release 正文
    $notesPattern = '(?ms)^## ' + [regex]::Escape($Version) + ' - ' + [regex]::Escape($today) + '\s*$(.*?)(?=^## )'
    $notesMatch = [regex]::Match($newChangelog, $notesPattern)
    $notes = ''
    if ($notesMatch.Success) { $notes = $notesMatch.Groups[1].Value.Trim() }
    $firstLine = ($notes -split "`r?`n" | Where-Object { $_ -match '^\s*[-*] ' } | Select-Object -First 1)
    if (-not $firstLine) { $firstLine = "- 见 CHANGELOG.md 的 $Version 段" }
    $derived = ($firstLine -replace '^\s*[-*]\s*', '').Trim()
    # 去掉 markdown 记号，免得 tag/Release 标题里出现反引号和括号链接
    $derived = $derived -replace '\[([^\]]+)\]\([^)]*\)', '$1'
    $derived = $derived -replace '[`*_]', ''
    $derived = ($derived -replace '\s+', ' ').Trim()
    # 「一句话：后面跟细节」这种 bullet，标题只留冒号前那半句
    $colon = $derived.IndexOfAny([char[]]@([char]0xFF1A, [char]0x3A))
    if ($colon -ge 8) { $derived = $derived.Substring(0, $colon).Trim() }
    if ($derived.Length -gt 60) {
        $derived = $derived.Substring(0, 60)
        $lastSpace = $derived.LastIndexOf(' ')
        if ($lastSpace -gt 30) { $derived = $derived.Substring(0, $lastSpace) }
        $derived = $derived.TrimEnd(' ', '，', ',', '、', ':', '：')
    }
    $headline = if ($Title) { $Title } else { $derived }

    # ---------- README 的版本一览 ----------
    Step "更新 README 的版本一览"
    $readmePath = Join-Path $repo 'README.md'
    $readme = [System.IO.File]::ReadAllText($readmePath, [System.Text.Encoding]::UTF8)
    $readme2 = $readme -replace '当前 \*\*\d+\.\d+\.\d+\*\*（\d{4}-\d{2}-\d{2}）', ('当前 **' + $Version + '**（' + $today + '）')
    $rowText = '| ' + $Version + ' | ' + $today + ' | ' + ($headline -replace '\|', '/') + ' |'
    $hasRow = $readme2 -match ('(?m)^\| ' + [regex]::Escape($Version) + ' \|')
    if (-not $hasRow) {
        # 锚定「版本 / 日期 / 一句话」这张表：README 里还有别的三列空表头，
        # 而且 [regex]::Replace 的第 4 个参数是 RegexOptions 不是次数，不能靠它只换一处。
        $eol = if ($readme2 -match "`r`n") { "`r`n" } else { "`n" }
        $readme2 = [regex]::Replace($readme2, '(?m)^\| 版本 \| 日期 \| 一句话 \|\r?\n\| --- \| --- \| --- \|\r?$', ("`$0" + $eol + $rowText))
    }
    if ($readme2 -eq $readme) {
        Say 'README 版本一览没有变化（已是最新？）'
    } else {
        Say "当前版本行与表格首行都指向 $Version"
    }

    # ---------- 提交 + tag ----------
    Step "提交并打 tag"
    $releaseMessage = "chore(release): $Version"
    Say "commit: $releaseMessage"
    Say "tag:    $tagName（附注：$headline）"
    if (-not $DryRun) {
        [System.IO.File]::WriteAllText($readmePath, $readme2, (New-Object System.Text.UTF8Encoding($false)))
        git add package.json CHANGELOG.md README.md
        if ($LASTEXITCODE -ne 0) { Fail 'git add 失败' }
        $messageFile = Join-Path $env:TEMP "dsh-nudge-release-$Version.txt"
        Write-Text $messageFile $releaseMessage
        git commit -F $messageFile | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail 'git commit 失败' }
        $tagFile = Join-Path $env:TEMP "dsh-nudge-tag-$Version.txt"
        Write-Text $tagFile "$tagName - $headline"
        git tag -a $tagName -F $tagFile | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail 'git tag 失败' }
    }
    $releaseHash = if ($DryRun) { '0' * 40 } else { (git rev-parse HEAD).Trim() }
    $shortHash = $releaseHash.Substring(0, 7)
    Say "release commit: $shortHash"

    # ---------- index.json 指针 ----------
    Step "index.json 指向新提交"
    $indexText = Read-Text $indexPath
    $stamp = [int][double]::Parse((Get-Date -UFormat %s))
    $newIndex = $indexText -replace '"version"\s*:\s*"\d+\.\d+\.\d+"', ('"version": "' + $Version + '"')
    $newIndex = $newIndex -replace '"publishTimestamp"\s*:\s*\d+', ('"publishTimestamp": ' + $stamp)
    $newIndex = $newIndex -replace '"commit"\s*:\s*"[0-9a-f]{40}"', ('"commit": "' + $releaseHash + '"')
    Say "version=$Version publishTimestamp=$stamp source.commit=$shortHash"
    if (-not $DryRun) {
        Write-Text $indexPath (($newIndex.TrimEnd()) + "`n")
        git add index.json
        $indexMessage = "chore(release): 索引指向 $Version 最终提交 ($shortHash)"
        $indexFile = Join-Path $env:TEMP "dsh-nudge-index-$Version.txt"
        Write-Text $indexFile $indexMessage
        git commit -F $indexFile | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail 'index.json 提交失败' }
        Say "commit: $indexMessage"
    }

    # ---------- push + Release ----------
    if ($NoPush) {
        Step "跳过推送"
        Say '本地已就绪；想推的时候执行：git push origin main && git push origin --tags'
    } else {
        Step "推送"
        $env:GIT_TERMINAL_PROMPT = '0'
        if (-not $DryRun) {
            git push origin main
            if ($LASTEXITCODE -ne 0) { Fail 'git push main 失败' }
            git push origin --tags
            if ($LASTEXITCODE -ne 0) { Fail 'git push --tags 失败' }
            Say 'main 与 tag 已推送'
        } else {
            Say 'git push origin main && git push origin --tags'
        }

        Step "GitHub Release"
        if ($NoRelease) {
            Say '已按 -NoRelease 跳过'
        } else {
            $gh = Get-Command gh -ErrorAction SilentlyContinue
            if (-not $gh) {
                Say '没找到 gh 命令行；标签已在远端，但 GitHub 首页不会显示 Release。装 gh 后补：'
                Say "   gh release create $tagName --title `"$tagName - $headline`" --notes-file <正文文件> --latest"
            } elseif ($DryRun) {
                Say "gh release create $tagName --title `"$tagName - $headline`" --latest"
            } else {
                $notesFile = Join-Path $env:TEMP "dsh-nudge-notes-$Version.md"
                Write-Text $notesFile $notes
                & gh release create $tagName --title "$tagName - $headline" --notes-file $notesFile --latest
                if ($LASTEXITCODE -ne 0) { Fail 'gh release create 失败（tag 已推上去，补一下 Release 即可）' }
                Say "Release $tagName 已创建并标记为 latest"
            }
        }
    }

    Step "完成"
    Say "版本 $Version；tag $tagName；索引指向 $shortHash"
} finally {
    Pop-Location
}
