# collect-dist.ps1 — 收集 ShotKit 真实分发集(只含被实际依赖的 DLL,自动排除 vcpkg 死重)。
#
# 背景:vcpkg bin 里有一批 shot.dll 根本不 import 的 DLL(harfbuzz-subset/turbojpeg/
# brotlienc/tls-33/libwebpmux/libwebpdecoder/icu 工具库…约 4.4MB 死重)。本脚本从
# shot.dll + shotcli.exe 出发,用 dumpbin 递归求 import 闭包,只拷真正需要的,死重自动落选。
# ICU 数据 DLL(icudtNN)由 icuuc 运行期 dlopen、不在静态 import 表,单独补入。
#
# 用法:pwsh Source/WebKitShot/tools/collect-dist.ps1 [-Out <dist目录>]

param(
    [string]$Root = 'D:\Github\webkit',
    [string]$Out  = ''
)
$ErrorActionPreference = 'Stop'
$binShot = "$Root\WebKitBuild\shot\bin"
$binDeps = "$Root\WebKitBuild\vcpkg_installed\x64-windows-webkit\bin"
if (-not $Out) { $Out = "$Root\WebKitBuild\shot-dist" }

$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath
$dumpbin = (Get-ChildItem "$vs\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe" | Select-Object -First 1).FullName

# 依赖池:vcpkg bin 里所有 DLL 名(小写→真实路径),排除 *.orig.dll
$pool = @{}
Get-ChildItem "$binDeps\*.dll" | Where-Object { $_.Name -notmatch '\.orig\.dll$' } | ForEach-Object { $pool[$_.Name.ToLower()] = $_.FullName }

$need = [System.Collections.Generic.HashSet[string]]::new()
$queue = [System.Collections.Generic.Queue[string]]::new()
# 种子:shot.dll + shotcli.exe
"$binShot\shot.dll","$binShot\shotcli.exe" | ForEach-Object { $queue.Enqueue($_) }

while ($queue.Count) {
    $f = $queue.Dequeue()
    $deps = (& $dumpbin /DEPENDENTS $f) | Select-String '^\s+(\S+\.dll)\s*$' | ForEach-Object { $_.Matches[0].Groups[1].Value.ToLower() }
    foreach ($d in $deps) {
        if ($pool.ContainsKey($d) -and $need.Add($d)) { $queue.Enqueue($pool[$d]) }
    }
}
# ICU 数据 DLL:运行期由 icuuc dlopen,补入
Get-ChildItem "$binDeps\icudt*.dll" | Where-Object { $_.Name -notmatch '\.orig\.dll$' } | ForEach-Object { [void]$need.Add($_.Name.ToLower()) }

# 输出
Remove-Item $Out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Out | Out-Null
Copy-Item "$binShot\shot.dll" $Out; Copy-Item "$binShot\shotcli.exe" $Out
foreach ($d in $need) { Copy-Item $pool[$d] $Out }

# 报告
$distFiles = Get-ChildItem "$Out\*" -File
$total = ($distFiles | Measure-Object Length -Sum).Sum
$allDeps = ($pool.Values | ForEach-Object { (Get-Item $_).Length } | Measure-Object -Sum).Sum
$shipped = ($need | ForEach-Object { (Get-Item $pool[$_]).Length } | Measure-Object -Sum).Sum
$dead = $pool.Keys | Where-Object { -not $need.Contains($_) }
Write-Host ("分发集: {0} 个文件, 合计 {1:N1} MB" -f $distFiles.Count, ($total/1MB))
Write-Host ("  其中 shot.dll {0:N1} MB + 依赖 {1:N1} MB" -f ((Get-Item "$Out\shot.dll").Length/1MB), ($shipped/1MB))
Write-Host ("排除的死重 {0} 个, 省 {1:N1} MB:" -f $dead.Count, (($allDeps-$shipped)/1MB))
$dead | Sort-Object | ForEach-Object { Write-Host ("    - {0} ({1:N2} MB)" -f $_, ((Get-Item $pool[$_]).Length/1MB)) }
Write-Host "dist -> $Out"
