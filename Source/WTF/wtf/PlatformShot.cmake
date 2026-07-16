# WTF 平台层：Shot 端口是 Windows 二进制，直接复用 Win 的 WTF 平台配置
# （Windows 线程/文件系统/RunLoop 源 + PlatformEnableWin.h + 系统库）。
include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformWin.cmake)
