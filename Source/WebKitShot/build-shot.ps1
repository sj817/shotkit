# build-shot.ps1 — 配置并构建 ShotKit 截图内核（Windows / clang-cl / ninja / vcpkg / Skia）。
#
# 用法：pwsh Source/WebKitShot/build-shot.ps1 [-Configure] [-Build] [-Clean]
#   -Build                增量：只重编改动的源 + 重链 shotcli（日常迭代用这个）
#   -Configure            全量重配（改了任何 *.cmake，或 ninja 自动重配擦了 CMake 缓存后必用）
#   -Configure -Build     先重配再构建
#
# 背景（见仓库根 AGENTS.md「实施进度 M0/M1」）：编辑任何 *.cmake 触发 ninja 自动重配时，
# CMake 因编译器缓存项是短名 clang-cl 判定"编译器变了" → 擦掉整个 CMake 缓存（PORT/vcpkg
# 前缀/Ruby/全部编译链接 flag 尽失）。-Configure 用完整 -D 一次性补齐所有被擦变量，避免手工
# 逐个补参数。缺 /DNDEBUG 会开断言，触发 C_LOOP 下 JSDOMGlobalObject 编译中断，故
# 发布构建固定 MinSizeRel + full LTO；*_FLAGS_MINSIZEREL 必含 /DNDEBUG。
# 运行 shotcli 前把 vcpkg_installed/.../bin 加进 PATH。

param(
    [switch]$Configure,
    [switch]$Build,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$Root = 'D:\Github\webkit'
$BuildDir = "$Root\WebKitBuild\shot"
$Prefix = "$Root/WebKitBuild/vcpkg_installed/x64-windows-webkit"
$LlvmBin = 'C:/Program Files/LLVM/bin'
$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath

if ($Clean) {
    Remove-Item $BuildDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "cleaned $BuildDir"
}

# 单行 cmake 配置（cmd /c 里的 ^ 续行不可靠，务必单行）。含 cache-wipe 后需回填的全部变量。
$cfg = 'cmake -S "' + $Root + '" -B "' + $BuildDir + '" -G Ninja -DPORT=Shot -DCMAKE_C_COMPILER="' + $LlvmBin + '/clang-cl.exe" -DCMAKE_CXX_COMPILER="' + $LlvmBin + '/clang-cl.exe" -DCMAKE_RC_COMPILER="' + $LlvmBin + '/llvm-rc.exe" -DCMAKE_BUILD_TYPE=MinSizeRel -DLTO_MODE=full -DCMAKE_TOOLCHAIN_FILE="' + $Root + '/WebKitLibraries/windows/vcpkg/scripts/buildsystems/vcpkg.cmake" -DVCPKG_TARGET_TRIPLET=x64-windows-webkit -DVCPKG_OVERLAY_TRIPLETS="' + $Root + '/WebKitLibraries/triplets" -DVCPKG_INSTALLED_DIR="' + $Root + '/WebKitBuild/vcpkg_installed" -DVCPKG_MANIFEST_INSTALL=OFF -DCMAKE_PREFIX_PATH="' + $Prefix + '" -DCMAKE_C_FLAGS_MINSIZEREL="/MD /O1 /DNDEBUG" -DCMAKE_CXX_FLAGS_MINSIZEREL="/MD /O1 /DNDEBUG" -DCMAKE_EXE_LINKER_FLAGS=/INCREMENTAL:NO -DCMAKE_SHARED_LINKER_FLAGS=/INCREMENTAL:NO'

# vcvarsall 提供 Windows SDK/CRT；LLVM(clang-cl) + Ruby 塞进 PATH。
$cmd = "call `"$vs\VC\Auxiliary\Build\vcvarsall.bat`" x64 && set `"PATH=C:\Program Files\LLVM\bin;C:\Ruby33-x64\bin;%PATH%`" && set `"CC=C:\Program Files\LLVM\bin\clang-cl.exe`" && "
if ($Configure) { $cmd += "$cfg && " }
if ($Build -or $Configure) { $cmd += "ninja -C `"$BuildDir`" shotcli" }
else { $cmd = $null }

if ($cmd) {
    Remove-Item "$BuildDir\.ninja_lock" -ErrorAction SilentlyContinue
    cmd /c $cmd
} elseif (-not $Clean) {
    Write-Host "nothing to do; pass -Configure and/or -Build (or -Clean)"
}
