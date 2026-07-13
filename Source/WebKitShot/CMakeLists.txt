# WebKitShot — ShotKit 截图内核
#
# libshot：SHARED 动态库，静态汇入 WebCore(OBJECT) 等，只导出 C ABI（shot_*）。
# shotcli：libshot 的薄命令行封装。
# 见仓库根 CLAUDE.md。

set(SHOTKIT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/ShotKit")

# WebCore 内部头（DocumentWriter/FrameSnapshotting 等）的 include 目录，libshot 编译需要。
set(_shotkit_includes
    ${CMAKE_CURRENT_SOURCE_DIR}                          # config.h
    ${CMAKE_CURRENT_SOURCE_DIR}/capi                     # shot.h
    ${SHOTKIT_DIR}
    ${CMAKE_BINARY_DIR}                                  # cmakeconfig.h
    ${CMAKE_BINARY_DIR}/WTF/Headers
    ${CMAKE_BINARY_DIR}/JavaScriptCore/Headers
    ${CMAKE_BINARY_DIR}/JavaScriptCore/PrivateHeaders
    ${CMAKE_BINARY_DIR}/bmalloc/Headers
    ${CMAKE_BINARY_DIR}/PAL/Headers
    ${CMAKE_BINARY_DIR}/WebCore/PrivateHeaders
)

# ---- libshot（SHARED，唯一导出 shot_*）----
set(libshot_LIBRARY_TYPE SHARED)
set(libshot_OUTPUT_NAME shot)

set(libshot_SOURCES
    ${SHOTKIT_DIR}/ShotCurlResourceLoader.cpp
    ${SHOTKIT_DIR}/ShotGlobal.cpp
    ${SHOTKIT_DIR}/ShotLoaderStrategy.cpp
    ${SHOTKIT_DIR}/ShotNetworkingContext.cpp
    ${SHOTKIT_DIR}/ShotPage.cpp
    ${SHOTKIT_DIR}/ShotPlatformStrategies.cpp
    ${SHOTKIT_DIR}/ShotSession.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/capi/shot.cpp
)

# WebCore 等是 OBJECT 库，链接时把目标文件与 include 一并带入。
set(libshot_FRAMEWORKS
    WebCore
    PAL
    JavaScriptCore
    WTF
    bmalloc
)

set(libshot_PRIVATE_INCLUDE_DIRECTORIES ${_shotkit_includes})

# dwrite：FontCacheSkiaWin 用 DWriteCreateFactory。OBJECT 库的 PRIVATE 系统库依赖不传递，
# 故此处显式补 Windows SDK 系统库。
set(libshot_LIBRARIES
    ICU::data ICU::i18n ICU::uc
    dwrite
)

WEBKIT_LIBRARY_DECLARE(libshot)
target_compile_definitions(libshot PRIVATE BUILDING_LIBSHOT=1)
WEBKIT_LIBRARY(libshot)

# ---- shotcli（薄 CLI，只用 C ABI，链接 libshot）----
set(shotcli_SOURCES
    ${CMAKE_CURRENT_SOURCE_DIR}/cli/main.cpp
)
set(shotcli_LIBRARIES libshot)
set(shotcli_PRIVATE_INCLUDE_DIRECTORIES
    ${CMAKE_CURRENT_SOURCE_DIR}/capi
)

WEBKIT_EXECUTABLE_DECLARE(shotcli)
WEBKIT_EXECUTABLE(shotcli)
