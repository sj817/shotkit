# slim-icu.ps1 — 把 ICU 数据 DLL（icudtNN.dll）裁成截图内核只需的最小集。
#
# 背景（AGENTS.md 4.5③「ICU data filter 是单项最大体积杠杆」）：完整 icudt 数据 ≈ 30 MB，
# 内含 currency/timezone/region/lang/unit/collation/rbnf/transliteration + 上千 locale bundle，
# 纯静态截图渲染一律用不到。渲染只需：brkitr(断行/断词，含 CJK/Thai 词典)、normalization、
# 字符属性(BiDi/case/props)、conversion(非 UTF 页面解码)、root/pool/supplemental 少量 misc。
# 裁剪后 ≈ 10 MB（−67%），多语言（中/日/阿拉伯 RTL/泰/emoji）渲染像素不变（已验证）。
#
# 做法：icupkg 按 item 移除无用类别 → genccode 生成数据 obj → link 成 /NOENTRY 数据 DLL。
# 输入用 ICU 构建残留的源 .dat（vcpkg buildtrees），输出替换 vcpkg_installed/bin 的 icudtNN.dll。
#
# 用法：pwsh Source/WebKitShot/tools/slim-icu.ps1 [-DatPath <icudtNNl.dat>] [-Out <icudtNN.dll>]
#          [-PruneUnusedConverters]
#
# PruneUnusedConverters 保留 TextCodecICU 直接打开的表，以及 CJK/ISO-2022
# 编码检测所需的传递闭包；共保留 43、删除 147 个 .cnv。UTF、CJK、
# Windows-1252、ISO-8859-2 等编码已做精简前后像素哈希对比，不缩减公开编码集。
#
# tools/icu-data-filter.json 负责 clean 重装时的基础类别裁剪；converter 白名单
# 仍由本脚本做确定性的 icupkg 后处理。

param(
    [string]$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..')),
    [string]$VcpkgRoot = '',
    [string]$VcpkgInstalledDir = '',
    [string]$VcpkgTriplet = 'x64-windows-webkit',
    [string]$DatPath = '',
    [string]$Out = '',
    [switch]$PruneUnusedConverters
)
$ErrorActionPreference = 'Stop'
if (-not $VcpkgRoot) { $VcpkgRoot = Join-Path $Root 'WebKitLibraries\windows\vcpkg' }
if (-not $VcpkgInstalledDir) { $VcpkgInstalledDir = Join-Path $Root 'WebKitBuild\vcpkg_installed' }
$installed = Join-Path $VcpkgInstalledDir $VcpkgTriplet

# ICU 版本号（icudtNN）
$dll = Get-ChildItem "$installed\bin\icudt*.dll" | Where-Object { $_.Name -notmatch 'orig' } | Select-Object -First 1
if (-not $dll) { throw "找不到 icudt*.dll" }
$ver = [regex]::Match($dll.Name, 'icudt(\d+)\.dll').Groups[1].Value
if (-not $Out) { $Out = $dll.FullName }
if (-not $DatPath) {
    $DatPath = Get-ChildItem "$VcpkgRoot\buildtrees\icu\*rel\data\out\tmp\icudt${ver}l.dat" -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object FullName
}
if (-not $DatPath -or -not (Test-Path $DatPath)) {
    throw "找不到源 icudt${ver}l.dat（vcpkg buildtrees 已清理？）。请传 -DatPath，或改用 icu-data-filter.json 重装 ICU。"
}

$tools = Get-Item (Join-Path $installed 'tools\icu') -ErrorAction SilentlyContinue
if (-not $tools) {
    $tools = Get-ChildItem "$VcpkgRoot\packages\icu_*\tools\icu" -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $tools) { throw "找不到 ICU 工具目录（icupkg.exe/genccode.exe）" }
$icupkg = "$($tools.FullName)\icupkg.exe"
$genccode = "$($tools.FullName)\genccode.exe"
if (-not (Test-Path $icupkg) -or -not (Test-Path $genccode)) { throw "ICU 工具不完整：$($tools.FullName)" }

$work = Join-Path $env:TEMP "slimicu_$ver"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work | Out-Null
Copy-Item $DatPath "$work\icudt${ver}l.dat"

# 列 item，生成移除清单：无用子类别 + 顶层 locale bundle（保留必要 misc 白名单）。
$items = & $icupkg -l "$work\icudt${ver}l.dat"
$keep = @('root','pool','supplementalData','likelySubtags','metadata','metaZones',
          'timezoneTypes','windowsZones','keyTypeData','genderList','numberingSystems','icustd','icuver')
$keepConverters = @(
    'ibm-912_P100-1995.cnv', 'ibm-914_P100-1995.cnv', 'ibm-915_P100-1995.cnv',
    'iso-8859_10-1998.cnv', 'ibm-921_P100-1995.cnv', 'iso-8859_14-1998.cnv',
    'ibm-923_P100-1998.cnv', 'ibm-878_P100-1996.cnv', 'macos-0_2-10.2.cnv',
    'ibm-5346_P100-1998.cnv', 'ibm-5347_P100-1998.cnv', 'ibm-5350_P100-1998.cnv',
    'ibm-9448_X100-2005.cnv', 'ibm-5354_P100-1998.cnv', 'macos-7_3-10.2.cnv',
    'macos-6_2-10.4.cnv', 'macos-29-10.2.cnv', 'macos-35-10.2.cnv',
    'euc-tw-2014.cnv',
    'windows-950-2000.cnv', 'ibm-1373_P100-2002.cnv',
    'euc-jp-2007.cnv', 'ibm-943_P15A-2003.cnv',
    'ibm-970_P110_P110-2006_U2.cnv', 'windows-949-2000.cnv',
    'ibm-949_P110-1999.cnv', 'ibm-949_P11A-1999.cnv',
    'ibm-1363_P110-1997.cnv',
    'ibm-1363_P11B-1998.cnv',
    'windows-936-2000.cnv', 'ibm-1386_P100-2001.cnv', 'gb18030-2022.cnv',
    'icu-internal-compound-d1.cnv', 'icu-internal-compound-d2.cnv',
    'icu-internal-compound-d3.cnv', 'icu-internal-compound-d4.cnv',
    'icu-internal-compound-d5.cnv', 'icu-internal-compound-d6.cnv',
    'icu-internal-compound-d7.cnv', 'icu-internal-compound-s1.cnv',
    'icu-internal-compound-s2.cnv', 'icu-internal-compound-s3.cnv',
    'icu-internal-compound-t.cnv'
)
$remove = $items | Where-Object {
    ($_ -match '^(coll|curr|zone|region|lang|unit|rbnf|translit)/') -or
    ($PruneUnusedConverters -and $_ -match '\.cnv$' -and $keepConverters -notcontains $_) -or
    ($_ -match '^[a-z]{2,3}(_[A-Za-z0-9]+)*\.res$' -and ($keep -notcontains ($_ -replace '\.res$','')))
}
$remove | Set-Content "$work\remove.txt" -Encoding ascii
Write-Host "移除 $($remove.Count) / $($items.Count) items"
& $icupkg -r "$work\remove.txt" "$work\icudt${ver}l.dat"
if ($LASTEXITCODE) { throw "icupkg failed with exit code $LASTEXITCODE" }

# 数据 .dat → 导出 icudtNN_dat 的数据 obj → /NOENTRY DLL
Push-Location $work
& $genccode -o -c x64 -e "icudt$ver" -d $work -f "icudt${ver}_dat" "icudt${ver}l.dat"
if ($LASTEXITCODE) { throw "genccode failed with exit code $LASTEXITCODE" }
Pop-Location
$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath
$lnk = "`"$vs\VC\Auxiliary\Build\vcvarsall.bat`" x64 && link /DLL /NOENTRY /MACHINE:X64 /OUT:`"$work\icudt$ver.dll`" `"$work\icudt${ver}_dat.obj`""
cmd /c $lnk | Out-Null
if ($LASTEXITCODE) { throw "link failed with exit code $LASTEXITCODE" }

if (-not (Test-Path "$installed\bin\icudt$ver.orig.dll")) {
    Copy-Item "$installed\bin\icudt$ver.dll" "$installed\bin\icudt$ver.orig.dll"
}
$outDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($Out))
if ($outDirectory) { New-Item -ItemType Directory -Force -Path $outDirectory | Out-Null }
Copy-Item "$work\icudt$ver.dll" $Out -Force
$mb = [math]::Round((Get-Item $Out).Length/1MB, 1)
Write-Host "slim icudt$ver.dll -> $Out  ($mb MB；原始备份 icudt$ver.orig.dll)"
