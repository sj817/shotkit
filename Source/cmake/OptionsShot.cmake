# OptionsShot.cmake — ShotKit 纯静态截图内核端口
#
# 目标：单进程直嵌 WebCore，把 HTML/CSS 渲染成 PNG，无头、页面 JS 永不执行、二进制极小。
# 见仓库根 AGENTS.md。Windows/Linux 使用 Skia 软光栅；macOS 使用 Cocoa 图形栈。
#
# 依赖来源：vcpkg（CMAKE_TOOLCHAIN_FILE 指向 vcpkg.cmake，vcpkg.json 的 web/skia/woff2 特性）。
# 库形态：bmalloc/WTF/JSC/PAL/WebCore 全部 OBJECT，静态汇入最终 libshot（仿 PlayStation 端口）。

add_definitions(-DWTF_PLATFORM_SHOT=1 -DBPLATFORM_SHOT=1)

if (APPLE)
    include(WebKitVersion)
    enable_language(OBJC OBJCXX)
    set(WEBKIT_SDK_NAME "macosx")
    set(WEBKIT_PLATFORM_NAME "MacOSX")
    # PlatformEnableCocoa derives these as ON on macOS even when their parent
    # feature is OFF. Shot has no media, payment, or notification surface.
    add_definitions(
        -DENABLE_APPLE_PAY=0
        -DENABLE_APPLE_PAY_AMS_UI=0
        -DENABLE_COCOA_WEBM_PLAYER=0
        -DENABLE_DECLARATIVE_WEB_PUSH=0
        -DENABLE_IMAGE_ANALYSIS=0
        -DENABLE_IMAGE_ANALYSIS_ENHANCEMENTS=0
        -DENABLE_IMAGE_ANALYSIS_FOR_MACHINE_READABLE_CODES=0
        -DENABLE_MODEL_ELEMENT_ACCESSIBILITY=0
        -DENABLE_NOTIFICATION_EVENT=0
        -DHAVE_AVASSETREADER=0
        -DHAVE_AVPLAYER_VIDEORANGEOVERRIDE=0
    )
    # ScrollAnimatorMac's ABI uses wheel phases even though Shot never sends
    # wheel events. Keep async scrolling OFF; expose only those phase types.
    add_definitions(-DENABLE_KINETIC_SCROLLING=1)
    # Xcode 16.4 rejects the current annotate_type placement on declarations.
    # NODELETE is analyzer metadata only and is already empty on Win/Linux Shot.
    add_definitions(-DNODELETE=)
endif ()

if (MSVC)
    include(OptionsMSVC)
else ()
    set(CMAKE_C_VISIBILITY_PRESET hidden)
    set(CMAKE_CXX_VISIBILITY_PRESET hidden)
    set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)
endif ()

# ---- Windows 平台基础定义（摘自 OptionsWin.cmake）----
if (WIN32)
    add_definitions(-D_WINDOWS -DNTDDI_VERSION=0x0A000006 -D_WIN32_WINNT=0x0A00)
    add_definitions(-DNOMINMAX)
    add_definitions(-DUNICODE -D_UNICODE)
    add_definitions(-DNOCRYPT)
    add_definitions(-D_CRT_NONSTDC_NO_DEPRECATE)
    add_definitions(-D_SILENCE_CXX23_DENORM_DEPRECATION_WARNING)
    add_definitions(-D_WINSOCKAPI_=)
endif ()

# 不构建 WebKit 双进程层与 WebKitLegacy —— 我们只要 WebCore + 自己的嵌入库。
set(ENABLE_WEBKIT OFF)
set(ENABLE_WEBKIT_LEGACY OFF)

set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY_DEBUG "${CMAKE_ARCHIVE_OUTPUT_DIRECTORY}")
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY_RELEASE "${CMAKE_ARCHIVE_OUTPUT_DIRECTORY}")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY_DEBUG "${CMAKE_LIBRARY_OUTPUT_DIRECTORY}")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY_RELEASE "${CMAKE_LIBRARY_OUTPUT_DIRECTORY}")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}")

# ---- 第三方依赖（Win/Linux 由 vcpkg/系统包提供；macOS 使用 SDK 框架）----
if (NOT APPLE)
    find_package(ICU 70.1 REQUIRED COMPONENTS data i18n uc)
    find_package(Threads REQUIRED)
    find_package(CURL 7.87.0 REQUIRED)
    find_package(HarfBuzz 1.4.2 REQUIRED COMPONENTS ICU)
    find_package(JPEG 1.5.2 REQUIRED)
    find_package(LibXml2 2.9.7 REQUIRED)
    find_package(OpenSSL REQUIRED)
    find_package(PNG 1.6.34 REQUIRED)
    find_package(SQLite3 3.23.1 REQUIRED)
    find_package(ZLIB 1.2.11 REQUIRED)
    find_package(LibPSL 0.20.2 REQUIRED)
    find_package(WebP REQUIRED COMPONENTS demux)
    find_package(WOFF2 1.0.2 COMPONENTS dec)
    find_package(Brotli REQUIRED COMPONENTS dec)
endif ()

if (CMAKE_SYSTEM_NAME MATCHES "Linux")
    find_package(EGL REQUIRED)
    find_package(Fontconfig REQUIRED)
    find_package(Freetype REQUIRED)
    find_package(OpenGLES2 REQUIRED)
endif ()

if (NOT APPLE AND NOT TARGET SQLite3::SQLite3) # CMake < 4.3
    add_library(SQLite3::SQLite3 ALIAS SQLite::SQLite3)
endif ()

WEBKIT_OPTION_BEGIN()

# ---- JSC 裁到最小：纯 LLInt 解释器，无 JIT/DFG/FTL/WASM ----
# C_LOOP 与 JIT 互斥；开启后 WEBKIT_OPTION_CONFLICT 会自动关掉整条 JIT 链与 WebAssembly。
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_C_LOOP PRIVATE ON)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_JIT PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_DFG_JIT PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_FTL_JIT PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_WEBASSEMBLY PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_SAMPLING_PROFILER PRIVATE OFF)

# 非共享 JSC，随 OBJECT 库静态汇入
WEBKIT_OPTION_DEFINE(ENABLE_STATIC_JSC "Control whether to build a non-shared JSC" PUBLIC ON)
# 供 IDL 预处理器识别 Shot 的静态渲染裁剪，其他端口不受影响。
WEBKIT_OPTION_DEFINE(ENABLE_SHOTKIT_STATIC_RENDERER "Build only the static rendering surface" PRIVATE ON)

# ---- 图形/字体后端：Skia 纯 CPU 软光栅 + HarfBuzz ----
if (APPLE)
    WEBKIT_OPTION_DEFAULT_PORT_VALUE(USE_SKIA PRIVATE OFF)
    WEBKIT_OPTION_DEFAULT_PORT_VALUE(USE_WOFF2 PRIVATE OFF)
else ()
    WEBKIT_OPTION_DEFAULT_PORT_VALUE(USE_SKIA PRIVATE ON)
    WEBKIT_OPTION_DEFAULT_PORT_VALUE(USE_WOFF2 PRIVATE ON)
endif ()

# ---- 渲染必需、零依赖的特性（保留以提高还原度）----
if (APPLE)
    # PlatformMac's AX wrapper requires the isolated-tree API and upstream
    # OptionsMac enables it by default. Shot reuses PlatformMac directly.
    WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_ACCESSIBILITY_ISOLATED_TREE PRIVATE ON)
endif ()
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_MATHML PUBLIC ON)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_DARK_MODE_CSS PRIVATE ON)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_VARIATION_FONTS PRIVATE ON)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_XSLT PUBLIC ON)

# ---- 与静态截图无关的一切，全部关闭（体积/依赖裁剪）----
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_VIDEO PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_WEB_AUDIO PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_WEBGL PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_WEBGL PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_MEDIA_SOURCE PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_MEDIA_STREAM PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_WEB_RTC PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_LEGACY_ENCRYPTED_MEDIA PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_ENCRYPTED_MEDIA PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_WEBXR PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_GAMEPAD PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_REMOTE_INSPECTOR PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_WEBDRIVER PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_NOTIFICATIONS PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_GEOLOCATION PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_FULLSCREEN_API PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_CONTEXT_MENUS PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_DRAG_SUPPORT PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_DEVICE_ORIENTATION PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_SMOOTH_SCROLLING PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_ASYNC_SCROLLING PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_GPU_PROCESS PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_PERIODIC_MEMORY_MONITOR PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_APPLICATION_MANIFEST PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_OFFSCREEN_CANVAS PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_JAVASCRIPT_SHELL PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_SWIFT_DEMO_URI_SCHEME PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_BACK_FORWARD_LIST_SWIFT PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_USER_MESSAGE_HANDLERS PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_IMAGE_DIFF PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_MINIBROWSER PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_API_TESTS PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_LAYOUT_TESTS PUBLIC OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(USE_AVIF PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(USE_LCMS PRIVATE OFF)
WEBKIT_OPTION_DEFAULT_PORT_VALUE(USE_JPEGXL PRIVATE OFF)

WEBKIT_OPTION_END()

if (APPLE)
    # Reuse the maintained Cocoa SDK/framework setup, then restore ShotKit's
    # single-process, OBJECT-library shape below. Page scripts and browser-only
    # features remain governed by the Shot option matrix above.
    include(OptionsCocoa)
    set(SWIFT_REQUIRED OFF)
    set(ENABLE_WEBKIT OFF)
    set(ENABLE_WEBKIT_LEGACY OFF)
    set(USE_LIBWEBRTC OFF)
    set(USE_ANGLE_EGL OFF)
    set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")
    set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")
    set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
endif ()

# CSS 选择器 JIT 无 CMake 变量，用编译定义覆盖 PlatformEnable.h 默认（回退解释执行）。
add_definitions(-DENABLE_CSS_SELECTOR_JIT=0 -DSHOT_DISABLE_HTTP3=1)

# ---- 体积极致化（AGENTS.md 4.5①）：死代码消除三件套 ----
# ① 关掉层间 dllexport：bmalloc/WTF/JSC/PAL/WebCore 全是 OBJECT 静态汇入 libshot，层间无
#    DLL 边界。上游 *_EXPORT 宏默认展开为 __declspec(dllexport)，会把上万个内部符号钉在
#    libshot 导出表里，链接器无法当死代码删除。SHOT_NO_DLLEXPORT 让 WTF/bmalloc 的
#    EXPORT_DECLARATION 全清空（见 WTF/wtf/ExportMacros.h、bmalloc/BExport.h），最终只剩
#    libshot 自己的 shot_*（SHOT_API 显式 dllexport）导出。
add_definitions(-DSHOT_NO_DLLEXPORT=1)
# ①b JSC 公共 C API（JSContextRef/JSObjectRef… 约 165 个 JS* 符号）用独立的 JS_EXPORT 宏
#    （非 WTF_EXPORT_DECLARATION）导出。libshot 从不暴露 JSC C API，故用上游自带的 JS_NO_EXPORT
#    钩子（JSBase.h:82）把 JS_EXPORT 清空，去掉这批导出锚点，连带其 API glue 可被 DCE。
add_definitions(-DJS_NO_EXPORT=1)
# ShotKit is a static renderer: page scripts are neither executed nor fetched.
# Upstream loader/parser seams use this to compile out script-only request paths.
add_definitions(-DSHOT_NO_SCRIPT=1)
# ② 函数级/数据级分段；③ 链接期回收未引用段。
if (MSVC)
    add_compile_options(/Gy /Gw)
    string(APPEND CMAKE_EXE_LINKER_FLAGS " /OPT:REF /OPT:ICF")
    string(APPEND CMAKE_SHARED_LINKER_FLAGS " /OPT:REF /OPT:ICF")
elseif (APPLE)
    string(APPEND CMAKE_EXE_LINKER_FLAGS " -Wl,-dead_strip")
    string(APPEND CMAKE_SHARED_LINKER_FLAGS " -Wl,-dead_strip")
else ()
    add_compile_options(
        "$<$<COMPILE_LANGUAGE:C,CXX>:-ffunction-sections>"
        "$<$<COMPILE_LANGUAGE:C,CXX>:-fdata-sections>"
    )
    string(APPEND CMAKE_EXE_LINKER_FLAGS " -Wl,--gc-sections")
    string(APPEND CMAKE_SHARED_LINKER_FLAGS " -Wl,--gc-sections")
endif ()

# CI release profile: ThinLTO retains cross-module optimization without the
# monolithic full-LTO memory peak. Bound backend parallelism explicitly on
# small hosted runners and persist native backend objects in a cache.
set(SHOT_LTO_JOBS "0" CACHE STRING "Maximum parallel ThinLTO backend jobs (0 = linker default)")
set(SHOT_THINLTO_CACHE_DIR "" CACHE PATH "ThinLTO native object cache directory")
set(SHOT_LINK_THREADS "0" CACHE STRING "Maximum lld-link threads for Full LTO (0 = linker default)")
if (MSVC AND LTO_MODE STREQUAL "thin")
    set(_shot_thin_lto_link_flags "")
    if (SHOT_LTO_JOBS)
        string(APPEND _shot_thin_lto_link_flags " /opt:lldltojobs=${SHOT_LTO_JOBS}")
    endif ()
    if (SHOT_THINLTO_CACHE_DIR)
        file(TO_NATIVE_PATH "${SHOT_THINLTO_CACHE_DIR}" _shot_thin_lto_cache_native)
        string(APPEND _shot_thin_lto_link_flags " /lldltocache:${_shot_thin_lto_cache_native}")
    endif ()
    string(APPEND CMAKE_EXE_LINKER_FLAGS "${_shot_thin_lto_link_flags}")
    string(APPEND CMAKE_SHARED_LINKER_FLAGS "${_shot_thin_lto_link_flags}")
    string(APPEND CMAKE_MODULE_LINKER_FLAGS "${_shot_thin_lto_link_flags}")
endif ()
if (MSVC AND LTO_MODE STREQUAL "full" AND SHOT_LINK_THREADS)
    # Full LTO merges the complete WebCore/JSC bitcode graph into one module.
    # Serializing lld's worker pool trades link time for a lower memory peak,
    # improving the chance of fitting a standard public GitHub runner.
    set(_shot_full_lto_link_flags " /threads:${SHOT_LINK_THREADS}")
    string(APPEND CMAKE_EXE_LINKER_FLAGS "${_shot_full_lto_link_flags}")
    string(APPEND CMAKE_SHARED_LINKER_FLAGS "${_shot_full_lto_link_flags}")
    string(APPEND CMAKE_MODULE_LINKER_FLAGS "${_shot_full_lto_link_flags}")
endif ()

# ---- USE_* 后端暴露给构建（Skia；保留可选 GPU 接线，默认截图仍走 CPU）----
if (APPLE)
    SET_AND_EXPOSE_TO_BUILD(USE_AUDIO_SESSION OFF)
    SET_AND_EXPOSE_TO_BUILD(USE_CF ON)
    SET_AND_EXPOSE_TO_BUILD(USE_CG ON)
    SET_AND_EXPOSE_TO_BUILD(USE_CURL OFF)
    SET_AND_EXPOSE_TO_BUILD(USE_OPENSSL OFF)
    SET_AND_EXPOSE_TO_BUILD(USE_HARFBUZZ OFF)
    SET_AND_EXPOSE_TO_BUILD(USE_SKIA OFF)
else ()
    SET_AND_EXPOSE_TO_BUILD(USE_CURL ON)
    SET_AND_EXPOSE_TO_BUILD(USE_OPENSSL ON)
    SET_AND_EXPOSE_TO_BUILD(USE_HARFBUZZ ON)
    SET_AND_EXPOSE_TO_BUILD(USE_SKIA ON)
endif ()
# ANGLE/EGL/TextureMapper 保留为可选 GPU 接线；默认截图仍关闭加速合成并使用 Skia CPU，
# 以保证无 GPU 环境可运行。发行依赖收集只复制 shot.dll 真正导入的库。
if (WIN32)
    set(USE_ANGLE_EGL ON)
    SET_AND_EXPOSE_TO_BUILD(USE_ANGLE ON)
else ()
    SET_AND_EXPOSE_TO_BUILD(USE_ANGLE OFF)
endif ()
if (APPLE)
    SET_AND_EXPOSE_TO_BUILD(USE_TEXTURE_MAPPER OFF)
    SET_AND_EXPOSE_TO_BUILD(USE_GRAPHICS_LAYER_TEXTURE_MAPPER OFF)
else ()
    SET_AND_EXPOSE_TO_BUILD(USE_TEXTURE_MAPPER ON)
    SET_AND_EXPOSE_TO_BUILD(USE_GRAPHICS_LAYER_TEXTURE_MAPPER ON)
endif ()
SET_AND_EXPOSE_TO_BUILD(USE_LIBWPE OFF)

if (CMAKE_SYSTEM_NAME MATCHES "Linux")
    SET_AND_EXPOSE_TO_BUILD(USE_FONTCONFIG ON)
    SET_AND_EXPOSE_TO_BUILD(USE_UNIX_DOMAIN_SOCKETS ON)
    SET_AND_EXPOSE_TO_BUILD(USE_COORDINATED_GRAPHICS ON)
    SET_AND_EXPOSE_TO_BUILD(USE_EGL ON)
    SET_AND_EXPOSE_TO_BUILD(USE_GENERIC_EVENT_LOOP ON)
    SET_AND_EXPOSE_TO_BUILD(WTF_DEFAULT_EVENT_LOOP OFF)
    set(LOWERCASE_EVENT_LOOP_TYPE "generic")
endif ()

# 主题/滚动条：Win 端口用 Adwaita 主题（RenderTheme/Theme/ScrollbarTheme::singleton
# 的定义整体包在 #if USE(THEME_ADWAITA) 内，platform/Adwaita.cmake 已随 PlatformWin
# 挂入源码，但符号定义需此开关点亮，否则链接期缺 singleton 符号）。对齐 OptionsWin:128。
if (APPLE)
    SET_AND_EXPOSE_TO_BUILD(USE_THEME_ADWAITA OFF)
else ()
    SET_AND_EXPOSE_TO_BUILD(USE_THEME_ADWAITA ON)
endif ()

# 判断 OpenSSL 是否为 BoringSSL（curl TLS 相关代码分支需要）
if (NOT APPLE)
    cmake_push_check_state()
    set(CMAKE_REQUIRED_INCLUDES "${OPENSSL_INCLUDE_DIR}")
    set(CMAKE_REQUIRED_LIBRARIES "${OPENSSL_LIBRARIES}")
    WEBKIT_CHECK_HAVE_SYMBOL(USE_BORINGSSL OPENSSL_IS_BORINGSSL openssl/ssl.h)
    cmake_pop_check_state()
endif ()

if (ENABLE_XSLT AND NOT APPLE)
    find_package(LibXslt 1.1.32 REQUIRED)
endif ()

if (USE_WOFF2)
    SET_AND_EXPOSE_TO_BUILD(USE_WOFF2 ON)
endif ()

# ---- 库形态：全 OBJECT，静态汇入 libshot（仿 PlayStation OptionsPlayStation.cmake）----
set(bmalloc_LIBRARY_TYPE OBJECT)
set(WTF_LIBRARY_TYPE OBJECT)
set(JavaScriptCore_LIBRARY_TYPE OBJECT)
set(PAL_LIBRARY_TYPE OBJECT)
set(WebCore_LIBRARY_TYPE OBJECT)
set(WebCoreTestSupport_LIBRARY_TYPE OBJECT)
