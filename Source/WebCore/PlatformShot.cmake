# WebCore 平台层（Shot 端口）：复用 Windows 的 Skia/ANGLE/EGL 接线。
# 默认截图仍走 Skia CPU；GPU 相关实现保留作为可选的本地构建能力。
include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformWin.cmake)
include(${CMAKE_CURRENT_SOURCE_DIR}/ShotPruning.cmake)
