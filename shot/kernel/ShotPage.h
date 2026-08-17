/*
 * ShotPage.h — 把 HTML 渲染成 PNG 的最小 WebCore 嵌入。
 *
 * 第一阶段：本地 HTML 字符串（含 data: 子资源），走 SVGImage 式的
 * DocumentWriter 直喂路径，不需要网络栈。远程 URL / 外链子资源是后续阶段。
 * 见仓库根 AGENTS.md。
 */

#pragma once

#include <cstdint>
#include <span>
#include <wtf/Vector.h>
#include <wtf/text/WTFString.h>

namespace ShotKit {

enum class OutputFormat : uint8_t {
    PNG,
    WebPLossy,
    WebPLossless,
};

struct RenderOptions {
    int width { 1280 };
    int height { 800 };
    double deviceScale { 1.0 };
    bool fullPage { false };        // true=按 contentsSize 截整页
    int timeoutMs { 30000 };        // 加载硬超时
    bool bestEffortOnTimeout { true }; // 超时仍尽力截图
    bool allowFileURLs { false };   // 是否允许 file:// 子资源/导航
    uint32_t backgroundRGBA { 0xFFFFFFFFu }; // 画布底色，0xRRGGBBAA；0=透明黑
    WTF::String selector;           // 非空=裁到该 CSS 选择器命中的首个元素；优先于 fullPage
    WTF::String baseURL;            // HTML 模式的 base URL（解析外链子资源）
    WTF::String userAgent;          // 空=默认 UA
    WTF::String inputMIMEType;       // 空=text/html；也可显式传 XML/XHTML
    OutputFormat outputFormat { OutputFormat::PNG };
    double outputQuality { 0.8 };    // WebP 有损质量，范围 0..1；无损模式忽略
};

// 渲染一段 UTF-8 标记（base URL/MIME 见 options），成功写编码图像到 outImage 返回 true。
// 失败时若传了 outError，写入可直接呈给调用方的原因（目前只有选择器路径会填）。
// 必须在 ShotKit::initialize() 绑定的主线程上调用。
bool renderMarkupToImage(std::span<const uint8_t> markup, const RenderOptions&, WTF::Vector<uint8_t>& outImage, WTF::String* outError = nullptr);

// 渲染一个远程/本地 URL（curl 抓主资源 + 子资源自动加载）。
bool renderURLToImage(const WTF::String& url, const RenderOptions&, WTF::Vector<uint8_t>& outImage, WTF::String* outError = nullptr);

} // namespace ShotKit
