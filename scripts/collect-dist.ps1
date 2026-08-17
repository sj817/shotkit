# collect-dist.ps1 - collect the exact direct ShotKit runtime import closure.
#
# shot.dll contains WebCore/JSC directly. ICU data is loaded by ICU at runtime
# and is therefore added explicitly.

param(
    [string]$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')),
    [string]$Out = '',
    [string]$VcpkgTriplet = 'x64-windows-webkit',
    [switch]$NodeAddon
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
$binShot = Join-Path $Root 'WebKitBuild\shot\bin'
$binDeps = Join-Path $Root "WebKitBuild\vcpkg_installed\$VcpkgTriplet\bin"
if (-not $Out) { $Out = Join-Path $Root $(if ($NodeAddon) { 'WebKitBuild\shot-node-dist' } else { 'WebKitBuild\shot-dist' }) }
$Out = [IO.Path]::GetFullPath($Out)
$allowedOutputRoot = [IO.Path]::GetFullPath((Join-Path $Root 'WebKitBuild'))
if (-not $Out.StartsWith($allowedOutputRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing to replace output outside $allowedOutputRoot`: $Out"
}

$shot = Join-Path $binShot 'shot.dll'
$cli = Join-Path $binShot 'shotcli.exe'
$addon = Join-Path $binShot 'shot.node'
$entryFiles = if ($NodeAddon) { @($addon) } else { @($shot, $cli) }
foreach ($required in $entryFiles) {
    if (-not (Test-Path -LiteralPath $required)) { throw "missing build output: $required" }
}

$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath
$hostArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$dumpbin = (Get-ChildItem "$vs\VC\Tools\MSVC\*\bin\Host$hostArch\$hostArch\dumpbin.exe" | Sort-Object FullName -Descending | Select-Object -First 1).FullName
if (-not $dumpbin) { throw "dumpbin.exe for host architecture $hostArch was not found under $vs" }

$pool = @{}
Get-ChildItem "$binDeps\*.dll" | Where-Object { $_.Name -notmatch '\.orig\.dll$' } | ForEach-Object { $pool[$_.Name.ToLowerInvariant()] = $_.FullName }
Get-ChildItem "$binShot\*.dll" | Where-Object { $_.Name -ne 'shot.dll' } | ForEach-Object { $pool[$_.Name.ToLowerInvariant()] = $_.FullName }

$need = [System.Collections.Generic.HashSet[string]]::new()
$queue = [System.Collections.Generic.Queue[string]]::new()
$entryFiles | ForEach-Object { $queue.Enqueue($_) }

# ShotKit disables accelerated compositing and renders through Skia CPU. These
# two ANGLE imports are retained only to satisfy WebCore's WinCairo link ABI;
# broad PNG/WebP/network/XSLT/Node tests pass without either DLL. Ignore them
# only when they occur in the PE delay-load table.
#
# icuin<N>.dll 同理：shot.dll 对它只有一个导入符号 udat_close（IntlDateTimeFormat
# 的 unique_ptr 析构器，被 JSCell 静态方法表钉住），Intl 日期格式化本体是死代码；
# SHOT_NO_SCRIPT 下 JS 永不执行 ⇒ 该析构器永不运行。见 shot/CMakeLists.txt 的
# /DELAYLOAD 注释。写成通配是为了 ICU 主版本号变化时不会静默失配。
$unusedDelayLoads = @('libegl.dll', 'libglesv2.dll', 'icuin*.dll')

while ($queue.Count) {
    $file = $queue.Dequeue()
    $inDelayLoadTable = $false
    foreach ($line in (& $dumpbin /DEPENDENTS $file)) {
        if ($line -match '^\s*Image has the following dependencies:') {
            $inDelayLoadTable = $false
            continue
        }
        if ($line -match '^\s*Image has the following delay load dependencies:') {
            $inDelayLoadTable = $true
            continue
        }
        if ($line -notmatch '^\s+(\S+\.dll)\s*$') {
            continue
        }
        $dependency = $Matches[1].ToLowerInvariant()
        if ($inDelayLoadTable -and ($unusedDelayLoads | Where-Object { $dependency -like $_ })) {
            continue
        }
        if ($pool.ContainsKey($dependency) -and $need.Add($dependency)) {
            $queue.Enqueue($pool[$dependency])
        }
    }
}

Get-ChildItem "$binDeps\icudt*.dll" | Where-Object { $_.Name -notmatch '\.orig\.dll$' } | ForEach-Object { [void]$need.Add($_.Name.ToLowerInvariant()) }

Remove-Item $Out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Out | Out-Null
Copy-Item $entryFiles -Destination $Out
foreach ($dependency in $need) { Copy-Item $pool[$dependency] $Out }

$distFiles = Get-ChildItem "$Out\*" -File
$total = ($distFiles | Measure-Object Length -Sum).Sum
$allDeps = ($pool.Values | ForEach-Object { (Get-Item $_).Length } | Measure-Object -Sum).Sum
$shipped = ($need | ForEach-Object { (Get-Item $pool[$_]).Length } | Measure-Object -Sum).Sum
$dead = $pool.Keys | Where-Object { -not $need.Contains($_) }
Write-Host ("runtime: {0} files, {1:N1} MiB" -f $distFiles.Count, ($total / 1MB))
$primary = if ($NodeAddon) { $addon } else { $shot }
Write-Host ("  {0} {1:N1} MiB + dependencies {2:N1} MiB" -f (Split-Path $primary -Leaf), ((Get-Item $primary).Length / 1MB), ($shipped / 1MB))
Write-Host ("excluded {0} unused DLLs, saving {1:N1} MiB:" -f $dead.Count, (($allDeps - $shipped) / 1MB))
$dead | Sort-Object | ForEach-Object { Write-Host ("    - {0} ({1:N2} MiB)" -f $_, ((Get-Item $pool[$_]).Length / 1MB)) }
Write-Host "dist -> $Out"
