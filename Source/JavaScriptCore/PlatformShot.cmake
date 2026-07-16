# JSC 平台层：复用 Win 的 JavaScriptCore 平台配置（Windows 二进制）。
include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformWin.cmake)

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
