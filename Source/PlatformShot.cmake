# PlatformShot.cmake — 由 Source/CMakeLists.txt 末尾 WEBKIT_INCLUDE_CONFIG_FILES_IF_EXISTS() 自动 include。
# 在 WebCore 配置完成后，把 ShotKit 嵌入库 + shotcli 挂进构建。
if (ENABLE_WEBCORE)
    add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/WebKitShot)
endif ()
