if (WIN32)
    include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformWin.cmake)
elseif (APPLE)
    include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformCocoa.cmake)
else ()
    include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformJSCOnly.cmake)
endif ()

# ENABLE_C_LOOP 已把 WebAssembly/JIT 功能关掉，但上游 Sources.txt 仍会
# 无条件生成并编译全部 wasm/ 与 B3 WASM 专用翻译单元。ShotKit 不执行
# 页面脚本，直接在统一源生成前物理排除，避免空壳对象、LTO 输入和残留代码。
list(APPEND JavaScriptCore_UNIFIED_SOURCE_EXCLUDES
    "(^|/)wasm/"
    "(^|/)b3/B3.*Wasm.*\\.cpp([ \\t]|$)"
)

# StackVisitor 的 CodeType::Wasm 分支在功能关闭时仍保留 IndexOrName 的
# 格式化 ABI；只回加这个最小翻译单元，不带解析器、编译器或 JS API。
list(APPEND JavaScriptCore_SOURCES wasm/WasmIndexOrName.cpp)

# ---- 整个 JSC target 从 -Os 降到 -Oz（minsize），零性能代价换体积 ----
#
# 依据：ShotKit 的页面 JS 永不执行（SHOT_NO_SCRIPT 四层拦截 + 编译期斩断
# JSGlobalObject 创建链），JSC 因此是全项目**唯一没有热路径**的大目标——CLoop
# 解释器从不进入，GC 只在近空堆上跑，Yarr 仅由表单 pattern / type=email 校验低频
# 调用。相对 MinSizeRel 的 -Os，-Oz 让 clang 在每个函数上多打一个 minsize 属性
# （-Os 只有 optsize），换来更激进的尺寸取舍（关闭循环向量化、不做会增大代码的
# 内联与展开）。WebCore / WTF / bmalloc / Skia 是布局、光栅与分配热路径，**不适用
# 本条**，继续走全局 -Os。
#
# 接线：本文件由 CMakeLists.txt 的 WEBKIT_INCLUDE_CONFIG_FILES_IF_EXISTS() 包含，
# 位置晚于 WEBKIT_FRAMEWORK_DECLARE(JavaScriptCore)、早于 WEBKIT_FRAMEWORK
# (JavaScriptCore)，故此处的 JavaScriptCore_COMPILE_OPTIONS 会被 _WEBKIT_TARGET_SETUP
# 转成 target_compile_options(JavaScriptCore PRIVATE ...)。写法对齐树内既有先例
# Source/bmalloc/PlatformIOS.cmake（同样在 Platform<PORT>.cmake 里用
# <Target>_COMPILE_OPTIONS + COMPILE_LANGUAGE 生成器表达式改单个 framework 的优化级别）。
# 子目标 JavaScriptCoreJIT（jit/dfg/ftl/bytecode/bytecompiler/llint/lol/tools，仅在
# 非 MSVC 的 clang 路径上创建）经 WEBKIT_DEFINE_SUBTARGET 的
# $<TARGET_PROPERTY:JavaScriptCore,COMPILE_OPTIONS> 自动继承；clang-cl 下该子目标
# 根本不创建、源文件全在主 target，两条路径都覆盖到。用 target 级而非 source 级还能
# 保证 cmake_pch.cxx 与普通源用同一套 flag，不会触发 clang 的 PCH flag 不匹配。
#
# 生效顺序：CMake 把 CMAKE_<LANG>_FLAGS_<CONFIG>（MinSizeRel 的 /O1）排在 target
# COMPILE_OPTIONS **之前**，而 clang 驱动对 -O 组取 getLastArg（后出现者胜），故 -Oz
# 覆盖 /O1。clang-cl -### 实测：`/O1` 单独 → cc1 收到 `-Os`；`/O1 /clang:-Oz` →
# cc1 收到 `-Oz`（且 -vectorize-loops 消失）。`/clang:` 参数还会被驱动追加到参数表
# 末尾，故与命令行先后无关，恒胜。full LTO 亦尊重此设置：-Oz 把 minsize 属性写进
# bitcode 的函数 attribute（-Os 只有 optsize），LTO 后端 codegen 按函数属性决策，
# 因此效果精确局限在 JSC 的函数上，不会外溢到合并进同一模块的 WebCore。
#
# 只作用于 C/C++（以及 Apple 上 JSC 的 ObjC/ObjC++ 源），不碰 Swift 与 asm；
# Debug 配置排除以保可调试性（本项目三平台均只配置 MinSizeRel，此为防御性守卫）。
# 仅 clang 系接线：本项目三平台工具链都是 clang（Windows clang-cl / Linux clang /
# macOS AppleClang）；GCC 直到 12 才支持 -Oz，不在此处冒进。
if (COMPILER_IS_CLANG_CL)
    list(APPEND JavaScriptCore_COMPILE_OPTIONS
        "$<$<AND:$<COMPILE_LANGUAGE:C,CXX>,$<NOT:$<CONFIG:Debug>>>:/clang:-Oz>")
elseif (COMPILER_IS_CLANG)
    list(APPEND JavaScriptCore_COMPILE_OPTIONS
        "$<$<AND:$<COMPILE_LANGUAGE:C,CXX,OBJC,OBJCXX>,$<NOT:$<CONFIG:Debug>>>:-Oz>")
endif ()
