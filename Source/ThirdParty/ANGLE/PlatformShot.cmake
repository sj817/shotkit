# ANGLE 平台层（Shot 端口）：复用 Win 配置（D3D11 后端 + 定义 ANGLE_ENABLE_D3D11、
# D3D/dxgi 源与头）。ANGLE 仅为 WebCore 的 EGL 显示抽象提供支撑，运行期不做 GPU 合成。
include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformWin.cmake)
