# prepare.ps1 — 为一次上游同步做准备：浅取 scratch 仓、生成 path-scoped patch、预报冲突。
#
# 这个脚本只做只读的准备工作，不会碰产品仓的工作区或索引。
# 应用补丁与解决冲突由人/AI 按 README.md 第 5 节手工进行。
#
# 用法：
#   pwsh upstream-sync/prepare.ps1                              # 仅准备 scratch 仓
#   pwsh upstream-sync/prepare.ps1 -Patch ../upstream.patch     # 顺带生成补丁与冲突预报
#   pwsh upstream-sync/prepare.ps1 -TargetRef <sha> -Patch ...  # 对齐到指定提交而非 main

param(
    [string]$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')),
    # 上游目标：分支名或提交哈希。默认取上游 main 的当前顶端。
    [string]$TargetRef = 'main',
    # scratch 仓位置。默认放在仓库外的兄弟目录，避免污染产品仓的 .git。
    [string]$ScratchDir = '',
    # 给出路径时把 patch 写到该文件，并打印冲突预报。
    [string]$Patch = '',
    [string]$UpstreamUrl = 'https://github.com/WebKit/WebKit.git'
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
if (-not $ScratchDir) { $ScratchDir = Join-Path (Split-Path -Parent $Root) 'webkit-upstream' }
$ScratchDir = [IO.Path]::GetFullPath($ScratchDir)

if ($ScratchDir.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "scratch 仓必须在产品仓之外，否则上游对象会重新进入本仓库的 .git：$ScratchDir"
}

# ---- 读基线哈希 ----
$BaselineFile = Join-Path $PSScriptRoot 'baseline.md'
$BaselineMatch = Select-String -Path $BaselineFile -Pattern '对齐提交：`([0-9a-f]{40})`' | Select-Object -First 1
if (-not $BaselineMatch) { throw "无法从 $BaselineFile 解析基线哈希（期望一行形如：- 对齐提交：``<40 位哈希>``）" }
$Baseline = $BaselineMatch.Matches[0].Groups[1].Value
Write-Host "基线提交: $Baseline"
Write-Host "上游目标: $TargetRef"

# ---- 读路径域 ----
$PathsFile = Join-Path $PSScriptRoot 'paths.txt'
$Paths = Get-Content -LiteralPath $PathsFile |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') }
if (-not $Paths) { throw "路径域为空：$PathsFile" }
Write-Host "路径域: $($Paths.Count) 条"

# ---- 准备 scratch 仓 ----
if (-not (Test-Path -LiteralPath (Join-Path $ScratchDir '.git'))) {
    Write-Host "`n创建 scratch 仓: $ScratchDir"
    New-Item -ItemType Directory -Force -Path $ScratchDir | Out-Null
    git -C $ScratchDir init --quiet
    git -C $ScratchDir remote add origin $UpstreamUrl
} else {
    Write-Host "`n复用 scratch 仓: $ScratchDir"
}

# 浅取两个互不相连的快照即可：git diff 只比较树，不需要祖先关系。
# --filter=blob:none 让文件内容按需下载，避免拉完整的 WebKit 工作树。
Write-Host "浅取基线快照..."
git -C $ScratchDir fetch --depth=1 --filter=blob:none --no-tags origin $Baseline
if ($LASTEXITCODE -ne 0) { throw "浅取基线 $Baseline 失败" }

Write-Host "浅取目标快照..."
git -C $ScratchDir fetch --depth=1 --filter=blob:none --no-tags origin $TargetRef
if ($LASTEXITCODE -ne 0) { throw "浅取目标 $TargetRef 失败" }
$Target = (git -C $ScratchDir rev-parse FETCH_HEAD).Trim()

Write-Host "`n目标提交: $Target"
git -C $ScratchDir log -1 --format='  %ci%n  %s' $Target

if ($Baseline -eq $Target) {
    Write-Host "`n基线已经是目标提交，无需同步。"
    return
}

if (-not $Patch) {
    Write-Host "`nscratch 仓已就绪。加 -Patch <文件> 生成补丁与冲突预报。"
    return
}

# ---- 生成 path-scoped patch ----
$Patch = [IO.Path]::GetFullPath($Patch)
Write-Host "`n生成 patch: $Patch"
# --binary 不能省：上游有二进制文件（ANGLE 测试数据、字体、图片），没有它 git diff
# 只写一行「Binary files ... differ」，git apply 到那里就整个失败。
# --output 让 git 自己写文件：走 PowerShell 管道会被 Set-Content 改成 CRLF，
# 而 base85 的二进制 hunk 经不起换行符改写。
git -C $ScratchDir diff --binary --output=$Patch $Baseline $Target -- @Paths
if ($LASTEXITCODE -ne 0) { throw 'git diff 失败' }

$Changed = git -C $ScratchDir diff --name-only $Baseline $Target -- @Paths
Write-Host "上游在路径域内改动: $($Changed.Count) 个文件"

# ---- 冲突预报：patch 涉及的文件 ∩ 偏离清单登记的文件 ----
# deviations.md 的表格首列是反引号包起来的路径（可能带「（新增）」前缀）。
# 少数行用花括号一次登记多个文件，例如
#   `Source/WebCore/{ShotPruning.cmake,Sources.txt}`
# 必须展开，否则这些文件永远不会出现在冲突预报里。
function Expand-LedgerPath([string]$Entry) {
    # 花括号可能在末尾，也可能在路径中段：
    #   Source/WebCore/{ShotPruning.cmake,Sources.txt}
    #   Source/{WTF/wtf,JavaScriptCore,ThirdParty/ANGLE}/PlatformShot.cmake
    if ($Entry -match '^(.*?)\{(.+?)\}(.*)$') {
        $prefix = $Matches[1]
        $suffix = $Matches[3]
        return $Matches[2].Split(',') | ForEach-Object { $prefix + $_.Trim() + $suffix }
    }
    return @($Entry)
}

$DeviationsFile = Join-Path $PSScriptRoot 'deviations.md'
# 惰性 [^|]*? 与排除 | 的捕获类缺一不可：贪婪版本会把首列的收尾反引号和次列的
# 起始反引号配成一对，捕获出「 | 改动 」这种跨列垃圾。
$Deviations = Select-String -Path $DeviationsFile -Pattern '^\|[^|]*?`([^`|]+)`' |
    ForEach-Object { $_.Matches[0].Groups[1].Value } |
    ForEach-Object { Expand-LedgerPath $_ } |
    Where-Object { $_ -match '^(Source|shot|scripts|CMakeLists)' } |
    Sort-Object -Unique

# 用 -like 而非 -contains：少数登记项是通配符（如
# Source/.../CoordinatedPlatformLayerBuffer*.cpp），无通配符时 -like 即精确匹配。
function Test-Registered([string]$Path, [object[]]$Patterns) {
    foreach ($p in $Patterns) { if ($Path -like $p) { return $true } }
    return $false
}

$Expected = $Changed | Where-Object { Test-Registered $_ $Deviations }
$Unregistered = $Changed | Where-Object { -not (Test-Registered $_ $Deviations) }

Write-Host "`n--- 冲突预报 ---"
Write-Host "偏离清单登记在案: $($Deviations.Count) 个文件"
if ($Expected) {
    Write-Host "`n预计冲突（上游改了、我们也改过）—— $($Expected.Count) 个："
    $Expected | ForEach-Object { Write-Host "  ! $_" }
    Write-Host "`n逐条对照 deviations.md 的「原因」列判断改动是否仍然必要（README 第 5 节）。"
} else {
    Write-Host "`n预计无冲突：上游的改动没有碰到任何登记过的文件。"
}
Write-Host "`n可干净应用: $($Unregistered.Count) 个文件"

# ---- 隐性断裂预警（README 第 6 节，补丁干净应用也可能踩到）----
Write-Host "`n--- 隐性断裂预警 ---"
$Idl = $Changed | Where-Object { $_ -like '*.idl' }
if ($Idl) { Write-Host "IDL 改动 $($Idl.Count) 个 -> 复查 shot/degenerate-bindings.txt 是否有悬空/漏收条目" }
if ($Changed -contains 'Source/WebCore/Sources.txt') { Write-Host "Sources.txt 有改动 -> 复查 Source/WebCore/ShotPruning.cmake 的裁剪规则是否失配" }
$ExportMacros = $Changed | Where-Object { $_ -match 'ExportMacros\.h|BExport\.h|JSBase\.h' }
if ($ExportMacros) { Write-Host "导出宏文件有改动 -> 复查 SHOT_NO_DLLEXPORT / JS_NO_EXPORT 的 #if 分支插入点" }
if (-not $Idl -and -not $ExportMacros -and ($Changed -notcontains 'Source/WebCore/Sources.txt')) {
    Write-Host "未命中已知的隐性断裂点（仍建议按 README 第 6 节做内容对等校验）"
}

Write-Host "`n下一步：git checkout -b sync/upstream-<日期> && git apply --3way $Patch"
