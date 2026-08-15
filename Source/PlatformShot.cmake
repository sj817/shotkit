# PlatformShot.cmake — 由 Source/CMakeLists.txt 末尾 WEBKIT_INCLUDE_CONFIG_FILES_IF_EXISTS() 自动 include。
# 在 WebCore 配置完成后，把 ShotKit 嵌入库 + shotcli 挂进构建。
#
# 产品代码在仓库顶层 shot/，不在 Source/ 内（Source/ 只留上游与端口粘合）。
# 本文件必须留在 Source/：端口机制按 Platform${PORT}.cmake 的文件名自动挂载。
# 源目录位于当前目录之外时，add_subdirectory 必须显式给出 binary dir。
if (ENABLE_WEBCORE)
    add_subdirectory(${CMAKE_SOURCE_DIR}/shot ${CMAKE_BINARY_DIR}/shot)
endif ()
