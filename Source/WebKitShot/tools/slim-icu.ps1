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
#
# 另见 tools/icu-data-filter.json：ICU 构建期 ICU_DATA_FILTER_FILE 版（clean 重装 ICU 用），
# 与本脚本裁剪等价，二选一即可。

param(
    [string]$Root = 'D:\Github\webkit',
    [string]$DatPath = '',
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$vcpkg = "$Root\WebKitLibraries\windows\vcpkg"
$installed = "$Root\WebKitBuild\vcpkg_installed\x64-windows-webkit"

# ICU 版本号（icudtNN）
$dll = Get-ChildItem "$installed\bin\icudt*.dll" | Where-Object { $_.Name -notmatch 'orig' } | Select-Object -First 1
if (-not $dll) { throw "找不到 icudt*.dll" }
$ver = [regex]::Match($dll.Name, 'icudt(\d+)\.dll').Groups[1].Value
if (-not $Out) { $Out = $dll.FullName }
if (-not $DatPath) {
    $DatPath = Get-ChildItem "$vcpkg\buildtrees\icu\*rel\data\out\tmp\icudt${ver}l.dat" -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object FullName
}
if (-not $DatPath -or -not (Test-Path $DatPath)) {
    throw "找不到源 icudt${ver}l.dat（vcpkg buildtrees 已清理？）。请传 -DatPath，或改用 icu-data-filter.json 重装 ICU。"
}

$tools = Get-ChildItem "$vcpkg\packages\icu_*\tools\icu" | Select-Object -First 1
$icupkg = "$($tools.FullName)\icupkg.exe"
$genccode = "$($tools.FullName)\genccode.exe"

$work = Join-Path $env:TEMP "slimicu_$ver"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work | Out-Null
Copy-Item $DatPath "$work\icudt${ver}l.dat"

# 列 item，生成移除清单：无用子类别 + 顶层 locale bundle（保留必要 misc 白名单）。
$items = & $icupkg -l "$work\icudt${ver}l.dat"
$keep = @('root','pool','supplementalData','likelySubtags','metadata','metaZones',
          'timezoneTypes','windowsZones','keyTypeData','genderList','numberingSystems','icustd','icuver')
$remove = $items | Where-Object {
    ($_ -match '^(coll|curr|zone|region|lang|unit|rbnf|translit)/') -or
    ($_ -match '^[a-z]{2,3}(_[A-Za-z0-9]+)*\.res$' -and ($keep -notcontains ($_ -replace '\.res$','')))
}
$remove | Set-Content "$work\remove.txt" -Encoding ascii
Write-Host "移除 $($remove.Count) / $($items.Count) items"
& $icupkg -r "$work\remove.txt" "$work\icudt${ver}l.dat"

# 数据 .dat → 导出 icudtNN_dat 的数据 obj → /NOENTRY DLL
Push-Location $work
& $genccode -o -c x64 -e "icudt$ver" -d $work -f "icudt${ver}_dat" "icudt${ver}l.dat"
Pop-Location
$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath
$lnk = "`"$vs\VC\Auxiliary\Build\vcvarsall.bat`" x64 && link /DLL /NOENTRY /MACHINE:X64 /OUT:`"$work\icudt$ver.dll`" `"$work\icudt${ver}_dat.obj`""
cmd /c $lnk | Out-Null

if (-not (Test-Path "$installed\bin\icudt$ver.orig.dll")) {
    Copy-Item "$installed\bin\icudt$ver.dll" "$installed\bin\icudt$ver.orig.dll"
}
Copy-Item "$work\icudt$ver.dll" $Out -Force
$mb = [math]::Round((Get-Item $Out).Length/1MB, 1)
Write-Host "slim icudt$ver.dll -> $Out  ($mb MB；原始备份 icudt$ver.orig.dll)"
