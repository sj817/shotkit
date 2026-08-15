/*
 * ShotPlatformStrategies.cpp — 见 ShotPlatformStrategies.h。
 */

#include "config.h"
#include "ShotPlatformStrategies.h"

#include "ShotLoaderStrategy.h"
#include <WebCore/MediaStrategy.h>
#include <WebCore/PlatformStrategies.h>
#include <wtf/NeverDestroyed.h>

namespace ShotKit {

// 媒体特性全部关闭。createAudioDestination 仅在 ENABLE(WEB_AUDIO) 下才是纯虚，
// 本端口 WEB_AUDIO=OFF，故 MediaStrategy 无纯虚成员，空桩即可实例化。
class ShotMediaStrategy final : public WebCore::MediaStrategy {
};

void ShotPlatformStrategies::initialize()
{
    static WTF::NeverDestroyed<ShotPlatformStrategies> strategies;
    WebCore::setPlatformStrategies(&strategies.get());
}

WebCore::LoaderStrategy* ShotPlatformStrategies::createLoaderStrategy()
{
    // curl 直驱的真 LoaderStrategy。PlatformStrategies::loaderStrategy() 缓存该指针
    //（进程级单例，泄漏一次即可）。
    return new ShotLoaderStrategy;
}

WebCore::PasteboardStrategy* ShotPlatformStrategies::createPasteboardStrategy()
{
    // 无头静态渲染不涉及剪贴板。
    return nullptr;
}

WebCore::MediaStrategy* ShotPlatformStrategies::createMediaStrategy()
{
    return new ShotMediaStrategy;
}

WebCore::BlobRegistry* ShotPlatformStrategies::createBlobRegistry()
{
    // 第一阶段：本地 HTML 不使用 blob: URL。M2 再接进程内 blob 注册表。
    return nullptr;
}

} // namespace ShotKit
