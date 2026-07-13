/*
 * ShotPlatformStrategies.h — 单进程嵌入所需的最小 PlatformStrategies。
 *
 * 第一阶段（本地 HTML、无外链子资源）：
 *   - LoaderStrategy / PasteboardStrategy 返回 nullptr（静态渲染路径不应触达；
 *     若触达会在此崩溃，正好定位 M2 网络栈的接入点）。
 *   - BlobRegistry 用 WebCore 自带的进程内 BlobRegistryImpl。
 *   - MediaStrategy 为桩（媒体特性已关）。
 * 见仓库根 AGENTS.md 第 5.3 节。
 */

#pragma once

#include <WebCore/PlatformStrategies.h>

namespace ShotKit {

class ShotPlatformStrategies final : public WebCore::PlatformStrategies {
public:
    static void initialize();

    ShotPlatformStrategies() = default; // public：供 NeverDestroyed 构造

private:
    WebCore::LoaderStrategy* createLoaderStrategy() override;
    WebCore::PasteboardStrategy* createPasteboardStrategy() override;
    WebCore::MediaStrategy* createMediaStrategy() override;
    WebCore::BlobRegistry* createBlobRegistry() override;
};

} // namespace ShotKit
