/*
 * ShotPage.h — 把 HTML 渲染成 PNG 的最小 WebCore 嵌入。
 *
 * 第一阶段：本地 HTML 字符串（含 data: 子资源），走 SVGImage 式的
 * DocumentWriter 直喂路径，不需要网络栈。远程 URL / 外链子资源是后续阶段。
 * 见仓库根 CLAUDE.md。
 */

#pragma once

#include <span>
#include <wtf/Vector.h>
#include <wtf/text/WTFString.h>

namespace ShotKit {

struct RenderOptions {
    int width { 1280 };
    int height { 800 };
    double deviceScale { 1.0 };
    bool fullPage { false };        // true=按 contentsSize 截整页
    int timeoutMs { 30000 };        // 加载硬超时
    bool bestEffortOnTimeout { true }; // 超时仍尽力截图
    bool allowFileURLs { false };   // 是否允许 file:// 子资源/导航
    WTF::String baseURL;            // HTML 模式的 base URL（解析外链子资源）
    WTF::String userAgent;          // 空=默认 UA
};

// 渲染一段 UTF-8 HTML（base URL 见 options.baseURL），成功写 PNG 到 outPng 返回 true。
// 必须在 ShotKit::initialize() 绑定的主线程上调用。
bool renderHTMLToPNG(std::span<const uint8_t> html, const RenderOptions&, WTF::Vector<uint8_t>& outPng);

// 渲染一个远程/本地 URL（curl 抓主资源 + 子资源自动加载）。
bool renderURLToPNG(const WTF::String& url, const RenderOptions&, WTF::Vector<uint8_t>& outPng);

} // namespace ShotKit
