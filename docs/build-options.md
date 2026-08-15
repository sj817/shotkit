# 构建开关与构建速查

`OptionsShot.cmake` 的开关矩阵，以及 Windows 的构建命令。
体积相关的开关清单（4.5 / 4.6）单独放在 [size-ledger.md](size-ledger.md)。

## 4. OptionsShot.cmake 开关矩阵

骨架照抄 `OptionsPlayStation.cmake` 结构（`WEBKIT_OPTION_BEGIN/END` + 库类型段）。

### 构建形态
| 开关 | 值 | 理由 |
|---|---|---|
| `ENABLE_WEBKIT` | OFF | 不编双进程层 |
| `ENABLE_WEBKIT_LEGACY` | OFF | 不编旧 API 层（源码留作抄写蓝本） |
| `ENABLE_WEBINSPECTORUI` | OFF | 无检查器 |
| `ENABLE_STATIC_JSC`（自定义 option） | ON | 仿 PlayStation:167 |
| `bmalloc/WTF/JavaScriptCore/PAL/WebCore_LIBRARY_TYPE` | OBJECT | 全静态汇入 libshot，无中间 dll/so 边界 |

### JSC 最小化
| 开关 | 值 | 备注 |
|---|---|---|
| `ENABLE_C_LOOP` | PRIVATE ON | 纯 LLInt；CONFLICT 机制自动关 JIT/WASM/SAMPLING_PROFILER |
| `ENABLE_JIT` / `ENABLE_DFG_JIT` / `ENABLE_FTL_JIT` | PRIVATE OFF | 显式双保险 |
| CSS Selector JIT | `add_definitions(-DENABLE_CSS_SELECTOR_JIT=0)` | **无 CMake 变量**，只能编译定义覆盖 `wtf/PlatformEnable.h` 默认；选择器回退解释执行 |

### 特性关断（均为 WebKitFeatures.cmake 已有选项）
```
ENABLE_VIDEO=OFF  ENABLE_WEB_AUDIO=OFF  ENABLE_WEBGL=OFF（连带不再编 ANGLE）
ENABLE_WEBXR=OFF  ENABLE_MEDIA_STREAM=OFF  ENABLE_WEB_RTC=OFF  ENABLE_MEDIA_SOURCE=OFF
ENABLE_MEDIA_RECORDER=OFF  ENABLE_REMOTE_INSPECTOR=OFF  ENABLE_WEBDRIVER=OFF
ENABLE_NOTIFICATIONS=OFF  ENABLE_GEOLOCATION=OFF  ENABLE_FULLSCREEN_API=OFF
ENABLE_CONTEXT_MENUS=OFF  ENABLE_GAMEPAD=OFF  ENABLE_DRAG_SUPPORT=OFF
ENABLE_SPEECH_SYNTHESIS=OFF  ENABLE_OFFSCREEN_CANVAS=OFF  ENABLE_XSLT=ON（静态 XML/XSLT 截图必须）
ENABLE_SMOOTH_SCROLLING=OFF  ENABLE_ASYNC_SCROLLING=OFF  ENABLE_GPU_PROCESS=OFF
ENABLE_PERIODIC_MEMORY_MONITOR=OFF
ENABLE_MATHML=ON   # 纯渲染特性、零额外依赖，留下增强还原度；可随时关
```

### Windows / Linux 段（`if (WIN32)` / Linux）
| 项 | 值 | 备注 |
|---|---|---|
| `USE_SKIA` | ON | `Source/CMakeLists.txt` 自动挂 vendored `ThirdParty/skia` |
| `USE_SKIA_ENCODERS` | ON | `encodeData` 走 SkPngEncoder（M1 验证；备选 libpng 编码器路径） |
| `USE_CURL` + `USE_OPENSSL` | ON | `find_package(CURL/OpenSSL)`，仿 OptionsWin.cmake:44-53 |
| `USE_HARFBUZZ` | ON | Skia 文字整形必需 |
| `USE_TEXTURE_MAPPER` + `USE_COORDINATED_GRAPHICS` | ON | **编译期需要 GraphicsLayer 实现存在**（运行期 AC 已关）；仿 PlayStation 非-GPU-process 分支（310-324） |
| Linux 额外 | `find_package(Fontconfig, Freetype)` | FontCacheSkia 需要 |
| Windows 字体 | 无额外开关 | FontCacheSkiaWin.cpp（DirectWrite）随源列表进入 |
| 系统依赖 | ICU / PNG / JPEG / WebP / LibXml2 / SQLite3 / ZLIB / LibPSL / Brotli+WOFF2 | 照抄 OptionsWin.cmake；Windows 用 WebKitRequirements 预构建包 |
| `USE_LIBWPE / USE_GLIB / USE_AVIF / USE_LCMS / USE_JPEGXL` | OFF | 减依赖 |

### macOS 段（`if (APPLE)`，M4 阶段实施）
- 不设 USE_SKIA / USE_CURL。图形 = CG/CoreText，网络 = `platform/network/cf + cocoa`（CFNetwork，`ResourceHandleCocoa.mm` 可用）。
- 以 `OptionsMac.cmake` 为参照抄取必要的 `SET_AND_EXPOSE_TO_BUILD(HAVE_*/USE_CF/USE_CG)` 与框架 find；WebCore 源列表复用 `PlatformMac.cmake` 后做裁剪。
- 这是工作量最大的平台段，排在最后（见风险 R3）。

### WebCore/PlatformShot.cmake 组织（Win/Linux）
```cmake
include(platform/Curl.cmake)
include(platform/OpenSSL.cmake)
include(platform/Skia.cmake)
include(platform/ImageDecoders.cmake)
include(platform/TextureMapper.cmake)
# Linux: include(platform/FreeType.cmake)
# 再从 PlatformWin.cmake 摘 Windows 专属源（FontCacheSkiaWin 等）
```


## 8. 构建速查（Windows，M0 起步）

- 依赖：安装 [WebKitRequirements](https://github.com/WebKitForWindows/WebKitRequirements) 预构建包（提供 ICU/PNG/JPEG/curl/OpenSSL 等），设 `WEBKIT_LIBRARIES` 环境变量；工具链需 MSVC 或 clang-cl + CMake + Ninja + perl + gperf + bison（参照 Win 端口现行构建文档）。
- 预期命令形态（体积优先，clang-cl 以启用 LTO）：
  ```
  cmake -S . -B WebKitBuild/shot -G Ninja -DPORT=Shot ^
        -DCMAKE_BUILD_TYPE=MinSizeRel -DLTO_MODE=full ^
        -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl
  ninja -C WebKitBuild/shot shotcli
  ```
  开发迭代期可先用 `Release` + 不开 LTO 换编译速度，但发布产物一律 MinSizeRel+LTO。
- 参考现有 preset 风格可在 `CMakePresets.json` 私有化（不改上游文件，用 `CMakeUserPresets.json`）。
