# build-shot.ps1 — configure and build ShotKit on Windows with clang-cl/Ninja/vcpkg.

param(
    [switch]$Configure,
    [switch]$Build,
    [switch]$Clean,
    [string]$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')),
    [string]$BuildDir = '',
    [string]$VcpkgRoot = $env:VCPKG_INSTALLATION_ROOT,
    [string]$VcpkgInstalledDir = '',
    [string]$VcpkgTriplet = 'x64-windows-webkit',
    [ValidateSet('off', 'thin', 'full')]
    [string]$LtoMode = 'full',
    [ValidateRange(0, 256)]
    [int]$Jobs = 0,
    [ValidateRange(0, 256)]
    [int]$LtoJobs = 0,
    [ValidateRange(0, 256)]
    [int]$LinkThreads = 0,
    [string]$ThinLTOCacheDir = '',
    [string]$LlvmBin = ''
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
if (-not $BuildDir) { $BuildDir = Join-Path $Root 'WebKitBuild\shot' }
if (-not $VcpkgInstalledDir) { $VcpkgInstalledDir = Join-Path $Root 'WebKitBuild\vcpkg_installed' }
$BuildDir = [IO.Path]::GetFullPath($BuildDir)
$VcpkgInstalledDir = [IO.Path]::GetFullPath($VcpkgInstalledDir)
$Prefix = Join-Path $VcpkgInstalledDir $VcpkgTriplet

if (-not $BuildDir.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "BuildDir must stay inside the repository: $BuildDir"
}

if (-not $VcpkgRoot) {
    $bundledVcpkg = Join-Path $Root 'WebKitLibraries\windows\vcpkg'
    if (Test-Path -LiteralPath (Join-Path $bundledVcpkg 'scripts\buildsystems\vcpkg.cmake')) {
        $VcpkgRoot = $bundledVcpkg
    } else {
        $vcpkgCommand = Get-Command vcpkg.exe -ErrorAction SilentlyContinue
        if ($vcpkgCommand) { $VcpkgRoot = Split-Path $vcpkgCommand.Source -Parent }
    }
}
if (-not $VcpkgRoot) { throw 'Unable to locate vcpkg; pass -VcpkgRoot or set VCPKG_INSTALLATION_ROOT.' }
$VcpkgRoot = [IO.Path]::GetFullPath($VcpkgRoot)
$VcpkgToolchain = Join-Path $VcpkgRoot 'scripts\buildsystems\vcpkg.cmake'
if (-not (Test-Path -LiteralPath $VcpkgToolchain)) { throw "vcpkg toolchain not found: $VcpkgToolchain" }

if (-not $LlvmBin) {
    $clang = Get-Command clang-cl.exe -ErrorAction SilentlyContinue
    if ($clang) {
        $LlvmBin = Split-Path $clang.Source -Parent
    } elseif (Test-Path -LiteralPath 'C:\Program Files\LLVM\bin\clang-cl.exe') {
        $LlvmBin = 'C:\Program Files\LLVM\bin'
    }
}
if (-not $LlvmBin) { throw 'Unable to locate clang-cl; pass -LlvmBin.' }
$LlvmBin = [IO.Path]::GetFullPath($LlvmBin)
$clangCl = Join-Path $LlvmBin 'clang-cl.exe'
$llvmRc = Join-Path $LlvmBin 'llvm-rc.exe'
foreach ($requiredTool in $clangCl, $llvmRc) {
    if (-not (Test-Path -LiteralPath $requiredTool)) { throw "required LLVM tool not found: $requiredTool" }
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw "vswhere not found: $vswhere" }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio C++ tools were not found.' }
$vcvarsall = Join-Path $vs 'VC\Auxiliary\Build\vcvarsall.bat'

# Import vcvarsall into this PowerShell process so CMake/Ninja can be invoked with
# argument arrays instead of one fragile cmd.exe command line.
$environmentLines = & cmd.exe /d /s /c "`"$vcvarsall`" x64 >nul && set"
if ($LASTEXITCODE) { throw "vcvarsall failed with exit code $LASTEXITCODE" }
foreach ($line in $environmentLines) {
    $separator = $line.IndexOf('=')
    if ($separator -le 0) { continue }
    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    Set-Item -Path "Env:$name" -Value $value
}
$env:PATH = "$LlvmBin;$env:PATH"
$env:CC = $clangCl
$env:CXX = $clangCl

if ($Clean) {
    Remove-Item -LiteralPath $BuildDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "cleaned $BuildDir"
}

if ($Configure) {
    # Cache files are CMake syntax, where a raw Windows path such as
    # C:\Program Files is parsed as an invalid \P escape. Normalize every
    # path stored through -D; command-line -S/-B arguments can remain native.
    $clangClCMake = $clangCl.Replace('\', '/')
    $llvmRcCMake = $llvmRc.Replace('\', '/')
    $vcpkgToolchainCMake = $VcpkgToolchain.Replace('\', '/')
    $vcpkgInstalledDirCMake = $VcpkgInstalledDir.Replace('\', '/')
    $prefixCMake = $Prefix.Replace('\', '/')
    $overlayTripletsCMake = (Join-Path $Root 'WebKitLibraries\triplets').Replace('\', '/')
    $cmakeArguments = @(
        '-S', $Root,
        '-B', $BuildDir,
        '-G', 'Ninja',
        '-DPORT=Shot',
        "-DCMAKE_C_COMPILER=$clangClCMake",
        "-DCMAKE_CXX_COMPILER=$clangClCMake",
        "-DCMAKE_RC_COMPILER=$llvmRcCMake",
        '-DCMAKE_BUILD_TYPE=MinSizeRel',
        "-DCMAKE_TOOLCHAIN_FILE=$vcpkgToolchainCMake",
        "-DVCPKG_TARGET_TRIPLET=$VcpkgTriplet",
        "-DVCPKG_OVERLAY_TRIPLETS=$overlayTripletsCMake",
        "-DVCPKG_INSTALLED_DIR=$vcpkgInstalledDirCMake",
        '-DVCPKG_MANIFEST_INSTALL=OFF',
        "-DCMAKE_PREFIX_PATH=$prefixCMake",
        '-DCMAKE_C_FLAGS_MINSIZEREL=/MD /O1 /DNDEBUG',
        '-DCMAKE_CXX_FLAGS_MINSIZEREL=/MD /O1 /DNDEBUG',
        '-DCMAKE_EXE_LINKER_FLAGS=/INCREMENTAL:NO',
        '-DCMAKE_SHARED_LINKER_FLAGS=/INCREMENTAL:NO'
    )
    if ($LtoMode -ne 'off') { $cmakeArguments += "-DLTO_MODE=$LtoMode" }
    if ($LtoJobs) { $cmakeArguments += "-DSHOT_LTO_JOBS=$LtoJobs" }
    if ($LinkThreads) { $cmakeArguments += "-DSHOT_LINK_THREADS=$LinkThreads" }
    if ($ThinLTOCacheDir) {
        $ThinLTOCacheDir = [IO.Path]::GetFullPath($ThinLTOCacheDir)
        New-Item -ItemType Directory -Force -Path $ThinLTOCacheDir | Out-Null
        $cmakeArguments += "-DSHOT_THINLTO_CACHE_DIR=$($ThinLTOCacheDir.Replace('\', '/'))"
    }

    & cmake @cmakeArguments
    if ($LASTEXITCODE) { throw "CMake configure failed with exit code $LASTEXITCODE" }
}

if ($Build -or $Configure) {
    Remove-Item -LiteralPath (Join-Path $BuildDir '.ninja_lock') -Force -ErrorAction SilentlyContinue
    $ninjaArguments = @('-C', $BuildDir)
    if ($Jobs) { $ninjaArguments += "-j$Jobs" }
    $ninjaArguments += 'shotcli'
    & ninja @ninjaArguments
    if ($LASTEXITCODE) { throw "Ninja failed with exit code $LASTEXITCODE" }
} elseif (-not $Clean) {
    Write-Host 'nothing to do; pass -Configure and/or -Build (or -Clean)'
}
