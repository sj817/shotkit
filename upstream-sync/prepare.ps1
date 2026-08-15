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
    # 只跑同步后的静态检查（不联网）：我们端口文件里的 include() 是否仍能解析。
    [switch]$Verify,
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

# ---- -Verify：同步后的静态检查（README 第 6 节第 4 类）----
# 我们自己的端口文件不在上游补丁里，所以上游把它们 include 的文件改名/删掉时
# 不会产生冲突，直到配置期才炸；而且只在对应平台上炸（2026-08-15 的
# PlatformMac -> PlatformCocoa 改名，Windows 本地构建完全无感）。
if ($Verify) {
    $ourFiles = @(Get-ChildItem -Path (Join-Path $Root 'Source') -Recurse -Filter 'PlatformShot.cmake' -File) +
                @(Get-ChildItem -Path (Join-Path $Root 'Source') -Recurse -Filter 'ShotPruning.cmake' -File) +
                @(Get-Item (Join-Path $Root 'Source/cmake/OptionsShot.cmake') -ErrorAction SilentlyContinue)
    $bad = 0
    foreach ($f in $ourFiles) {
        $dir = Split-Path -Parent $f.FullName
        foreach ($m in [regex]::Matches((Get-Content -Raw -LiteralPath $f.FullName),
                       'include\(\s*(?:\$\{CMAKE_CURRENT_SOURCE_DIR\}/)?([A-Za-z0-9_/.\-]+\.cmake)\s*\)')) {
            $t = $m.Groups[1].Value
            $found = @($t, (Join-Path $dir $t), (Join-Path $Root "Source/cmake/$t")) |
                     Where-Object { Test-Path -LiteralPath $_ }
            if (-not $found) {
                $rel = $f.FullName.Substring($Root.Length + 1)
                Write-Host "缺失  $rel -> include($t)"
                $bad++
            }
        }
    }
    Write-Host "检查 $($ourFiles.Count) 个端口文件，缺失 include: $bad"
    if ($bad) { throw "端口文件引用了不存在的上游 cmake（多半是上游改名/删除），见上方清单" }
    Write-Host "端口文件的 include 全部可解析。"
    return
}
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

# README 第 6 节第 6 类：上游把特性开关从 CMake 注销、交给 Platform*.h 按 SDK 判定。
# 被注销的开关不再进 cmakeconfig.h，我们 WEBKIT_OPTION_DEFAULT_PORT_VALUE(... OFF)
# 关掉的东西会被 PlatformEnable*.h 的 HAVE(...) 分支重新打开，而且不产生任何冲突。
# 这是唯一能在应用补丁前静态发现的一类，所以直接比对新旧的注销名单。
function Get-PlatformHOwnedOptions([string]$Rev) {
    $names = @()
    # 按 rev 实际存在的文件来取，不要写死路径：Options*.cmake 会增删（这次就新增了
    # OptionsCocoa.cmake），而 git show 一个不存在的路径在 PowerShell 7.4+ 下会因为
    # $PSNativeCommandUseErrorActionPreference 默认为真、配合脚本顶部的 Stop 直接抛。
    $files = git -C $ScratchDir ls-tree -r --name-only $Rev Source/cmake/ |
        Where-Object { $_ -like 'Source/cmake/Options*.cmake' }
    foreach ($file in $files) {
        $text = (git -C $ScratchDir show "${Rev}:${file}") -join "`n"
        foreach ($m in [regex]::Matches($text, '(?s)WEBKIT_OPTION_OWNED_BY_PLATFORM_H\((.*?)\)')) {
            $names += $m.Groups[1].Value -split '\s+' | Where-Object { $_ -match '^\w+$' }
        }
    }
    return $names | Sort-Object -Unique
}
$OwnedBefore = Get-PlatformHOwnedOptions $Baseline
$OwnedAfter = Get-PlatformHOwnedOptions $Target
$NewlyRetired = $OwnedAfter | Where-Object { $_ -notin $OwnedBefore }
if ($NewlyRetired) {
    Write-Host "上游新注销了 $($NewlyRetired.Count) 个 CMake 特性开关（WEBKIT_OPTION_OWNED_BY_PLATFORM_H）："
    $NewlyRetired | ForEach-Object { Write-Host "  ! $_" }
    Write-Host "  -> 逐个查 Source/WTF/wtf/PlatformEnable*.h 里它的门控条件。"
    Write-Host "     门控挂在父特性上（如 ENABLE(APPLE_PAY)）即安全；挂在 HAVE(...)/PLATFORM(...)"
    Write-Host "     上且我们关掉了父特性的，必须在 OptionsShot.cmake 的对应分支显式补 0"
    Write-Host "     （add_definitions 与 SET_AND_EXPOSE_TO_BUILD 两份视图都要补）。"
}

if (-not $Idl -and -not $ExportMacros -and -not $NewlyRetired -and
    ($Changed -notcontains 'Source/WebCore/Sources.txt')) {
    Write-Host "未命中已知的隐性断裂点（仍建议按 README 第 6 节做内容对等校验）"
}

Write-Host "`n下一步：git checkout -b sync/upstream-<日期> && git apply --3way $Patch"
