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

set(_shotkit_kernel_sources
    ${SHOTKIT_DIR}/ShotGlobal.cpp
    ${SHOTKIT_DIR}/ShotLoaderStrategy.cpp
    ${SHOTKIT_DIR}/ShotPage.cpp
    ${SHOTKIT_DIR}/ShotPlatformStrategies.cpp
    ${SHOTKIT_DIR}/ShotSession.cpp
)

if (USE_CURL)
    list(APPEND _shotkit_kernel_sources ${SHOTKIT_DIR}/ShotCurlResourceLoader.cpp)
endif ()

set(libshot_SOURCES
    ${_shotkit_kernel_sources}
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
    # ICU i18n 与这两个 ANGLE 库是同一种形态：链接期可达、运行期不可达。
    # 2026-08-15 上游同步后 shot.dll 对 icuin<N>.dll 只有 **一个** 导入符号
    # udat_close —— IntlDateTimeFormat 那几个 std::unique_ptr<UDateFormat> 成员的
    # 析构器，被 JSCell 静态方法表取地址钉住（同偏离清单里 ShadowRealm 那条的机制）。
    # 整个 Intl 日期格式化代码本身是死的：真活着的话 udat_open/udat_format/udatpg_*
    # 会一起出现在导入表里，实测没有。SHOT_NO_SCRIPT 下 JS 永不执行 ⇒
    # IntlDateTimeFormat 永不构造 ⇒ 该析构器永不运行。
    # 延迟加载让它退出直接导入闭包，collect-dist.ps1 随之不再分发 icuin<N>.dll，
    # 拿回 2.86 MiB（M2「斩链二期」消掉过一次，这次被上游 Temporal 重构带了回来）。
    # 已核实 icuuc77.dll 自身不依赖 icuin77.dll，所以它只由 shot.dll 这一个导入拽入。
    string(REGEX MATCH "^[0-9]+" _shot_icu_major "${ICU_VERSION}")
    if (NOT _shot_icu_major)
        # 不给静默失配的机会：取不到主版本号就说明 DLL 名会写错，
        # 那样 /DELAYLOAD 会静默失效、icuin 悄悄回到分发包里。
        message(FATAL_ERROR "无法从 ICU_VERSION='${ICU_VERSION}' 解析主版本号，/DELAYLOAD 的 DLL 名会失配")
    endif ()
    target_link_options(libshot PRIVATE
        "/DELAYLOAD:libEGL.dll"
        "/DELAYLOAD:libGLESv2.dll"
        "/DELAYLOAD:icuin${_shot_icu_major}.dll"
    )
    unset(_shot_icu_major)
endif ()


# ---- shot.node（Node-API，静态汇入同一 C ABI + WebCore OBJECT 闭包）----
# 头文件来自 apps/node 的 build-only node-api-headers 依赖。没有 npm checkout
# 时仍允许只构建 CLI；发布/平台 CI 会先 npm ci 并显式构建 shotnode。
set(SHOT_NODE_API_INCLUDE_DIR "${CMAKE_SOURCE_DIR}/apps/node/node_modules/node-api-headers/include"
    CACHE PATH "Directory containing node_api.h for the optional shot.node target")
if (EXISTS "${SHOT_NODE_API_INCLUDE_DIR}/node_api.h")
    set(shotnode_LIBRARY_TYPE SHARED)
    set(shotnode_SOURCES
        ${_shotkit_kernel_sources}
        ${CMAKE_CURRENT_SOURCE_DIR}/capi/shot.cpp
        ${CMAKE_CURRENT_SOURCE_DIR}/node/addon.cpp
    )
    set(shotnode_FRAMEWORKS ${libshot_FRAMEWORKS})
    set(shotnode_PRIVATE_INCLUDE_DIRECTORIES
        ${_shotkit_includes}
        ${SHOT_NODE_API_INCLUDE_DIR}
    )
    if (APPLE)
        list(APPEND shotnode_PRIVATE_INCLUDE_DIRECTORIES ${SHOT_WEBP_INCLUDE_DIR})
    endif ()
    set(shotnode_LIBRARIES ${libshot_LIBRARIES})

    if (WIN32)
        get_filename_component(_shot_node_api_root "${SHOT_NODE_API_INCLUDE_DIR}" DIRECTORY)
        set(_shot_node_def "${_shot_node_api_root}/def/node_api.def")
        set(_shot_node_import_library "${CMAKE_CURRENT_BINARY_DIR}/node_api.lib")
        if (WTF_CPU_ARM64)
            set(_shot_node_machine ARM64)
        else ()
            set(_shot_node_machine X64)
        endif ()
        execute_process(
            COMMAND "${CMAKE_AR}" "/def:${_shot_node_def}" "/machine:${_shot_node_machine}" "/out:${_shot_node_import_library}"
            RESULT_VARIABLE _shot_node_lib_result
            OUTPUT_VARIABLE _shot_node_lib_output
            ERROR_VARIABLE _shot_node_lib_error
        )
        if (NOT _shot_node_lib_result EQUAL 0)
            message(FATAL_ERROR "Failed to create Node-API import library: ${_shot_node_lib_output}${_shot_node_lib_error}")
        endif ()
        list(APPEND shotnode_LIBRARIES "${_shot_node_import_library}")
    endif ()

    WEBKIT_LIBRARY_DECLARE(shotnode)
    target_compile_definitions(shotnode PRIVATE SHOT_STATIC=1 NAPI_VERSION=8)
    WEBKIT_LIBRARY(shotnode)
    set_target_properties(shotnode PROPERTIES
        OUTPUT_NAME shot
        PREFIX ""
        SUFFIX ".node"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
        LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
        ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/import"
    )
    if (APPLE)
        target_link_options(shotnode PRIVATE "-undefined" "dynamic_lookup")
        set_target_properties(shotnode PROPERTIES BUILD_RPATH "@loader_path/lib" INSTALL_RPATH "@loader_path/lib")
    elseif (UNIX)
        # Node resolves N-API symbols from the host executable at dlopen time.
        # WebKit globally links shared libraries with --no-undefined, so restore
        # the normal addon policy for this target only (the later CI export/
        # dependency checks still reject accidental ShotKit ABI leakage).
        target_link_options(shotnode PRIVATE "-Wl,-z,undefs")
        set_target_properties(shotnode PROPERTIES BUILD_RPATH "$ORIGIN/lib" INSTALL_RPATH "$ORIGIN/lib")
    endif ()

    if (WIN32)
        string(REGEX MATCH "^[0-9]+" _shot_node_icu_major "${ICU_VERSION}")
        if (NOT _shot_node_icu_major)
            message(FATAL_ERROR "Cannot derive the ICU DLL name for shot.node from ICU_VERSION='${ICU_VERSION}'")
        endif ()
        target_link_options(shotnode PRIVATE
            "/DELAYLOAD:libEGL.dll"
            "/DELAYLOAD:libGLESv2.dll"
            "/DELAYLOAD:icuin${_shot_node_icu_major}.dll"
        )
        unset(_shot_node_icu_major)
    endif ()
else ()
    message(STATUS "shot.node disabled: node_api.h not found under ${SHOT_NODE_API_INCLUDE_DIR}")
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

# Small cross-platform C ABI ownership regression used by every platform CI.
set(shot_capi_thread_test_SOURCES ${CMAKE_SOURCE_DIR}/tests/capi_thread_test.cpp)
set(shot_capi_thread_test_LIBRARIES libshot)
set(shot_capi_thread_test_PRIVATE_INCLUDE_DIRECTORIES ${CMAKE_CURRENT_SOURCE_DIR}/capi)
WEBKIT_EXECUTABLE_DECLARE(shot_capi_thread_test)
WEBKIT_EXECUTABLE(shot_capi_thread_test)
if (APPLE)
    set_target_properties(shot_capi_thread_test PROPERTIES BUILD_RPATH "@loader_path/../lib")
elseif (UNIX)
    set_target_properties(shot_capi_thread_test PROPERTIES BUILD_RPATH "$ORIGIN/../lib")
endif ()
