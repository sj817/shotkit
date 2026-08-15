# shot — ShotKit 截图内核
#
# libshot: the direct C ABI library, with WebCore/JSC linked into one DLL.
# shotcli: a thin client of libshot.
# 见仓库根 AGENTS.md。

set(SHOTKIT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/kernel")

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

# ---- libshot (WebCore/JSC implementation) ----
set(libshot_LIBRARY_TYPE SHARED)
set(libshot_OUTPUT_NAME shot)

set(libshot_SOURCES
    ${SHOTKIT_DIR}/ShotGlobal.cpp
    ${SHOTKIT_DIR}/ShotLoaderStrategy.cpp
    ${SHOTKIT_DIR}/ShotPage.cpp
    ${SHOTKIT_DIR}/ShotPlatformStrategies.cpp
    ${SHOTKIT_DIR}/ShotSession.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/capi/shot.cpp
)

if (USE_CURL)
    list(APPEND libshot_SOURCES ${SHOTKIT_DIR}/ShotCurlResourceLoader.cpp)
endif ()

# WebCore 等是 OBJECT 库，链接时把目标文件与 include 一并带入。
set(libshot_FRAMEWORKS
    WebCore
    PAL
    JavaScriptCore
    WTF
    bmalloc
)

set(libshot_PRIVATE_INCLUDE_DIRECTORIES ${_shotkit_includes})
if (APPLE)
    list(APPEND libshot_PRIVATE_INCLUDE_DIRECTORIES ${SHOT_WEBP_INCLUDE_DIR})
endif ()

set(libshot_LIBRARIES
    ICU::data ICU::i18n ICU::uc
)
if (WIN32)
    # FontCacheSkiaWin uses DirectWrite. OBJECT-library private dependencies do
    # not propagate to the final shared library, so keep these explicit.
    list(APPEND libshot_LIBRARIES dwrite delayimp)
else ()
    list(APPEND libshot_LIBRARIES Threads::Threads ${CMAKE_DL_LIBS})
endif ()
if (APPLE)
    list(APPEND libshot_LIBRARIES ${SHOT_WEBP_LIBRARY} ${SHOT_SHARPYUV_LIBRARY})
endif ()

WEBKIT_LIBRARY_DECLARE(libshot)
target_compile_definitions(libshot PRIVATE BUILDING_LIBSHOT=1)
WEBKIT_LIBRARY(libshot)
if (WIN32)
    target_link_options(libshot PRIVATE "/DELAYLOAD:libEGL.dll" "/DELAYLOAD:libGLESv2.dll")
endif ()


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
if (APPLE)
    set_target_properties(shotcli PROPERTIES
        BUILD_RPATH "@loader_path/../lib"
        INSTALL_RPATH "@loader_path/../lib"
    )
elseif (UNIX)
    set_target_properties(shotcli PROPERTIES
        BUILD_RPATH "$ORIGIN/../lib"
        INSTALL_RPATH "$ORIGIN/../lib"
    )
endif ()
