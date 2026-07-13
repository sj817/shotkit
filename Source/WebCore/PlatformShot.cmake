# WebCore 平台层（Shot 端口）：复用 Win 的 WebCore 平台配置。
# 为"先能截图"沿用 WinCairo 图形栈（Skia + ANGLE/EGL 显示抽象 + TextureMapper）。
# 运行期不做 GPU 合成（ShotPage 关闭加速合成，ImageBuffer 走 Skia CPU 后端）。
# 移除 ANGLE/TextureMapper 以减体积列为二期专项（见 CLAUDE.md 4.6 / R2）。
include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformWin.cmake)
