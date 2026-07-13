/*
 * ShotNetworkingContext.h — 单进程 curl 网络所需的 FrameNetworkingContext。
 *
 * FrameNetworkingContext 已实现 shouldClearReferrerOnHTTPSToHTTPRedirect/isValid，
 * 这里只需补 storageSession()（返回进程级 ephemeral 会话）与 blockedError()（WIN 纯虚）。
 * 见 Source/WebKitShot/docs/network-integration-map.md 第 6 节。
 */

#pragma once

#include <WebCore/FrameNetworkingContext.h>
#include <wtf/Ref.h>

namespace ShotKit {

class ShotNetworkingContext final : public WebCore::FrameNetworkingContext {
public:
    static Ref<ShotNetworkingContext> create(WebCore::LocalFrame* frame)
    {
        return adoptRef(*new ShotNetworkingContext(frame));
    }

private:
    explicit ShotNetworkingContext(WebCore::LocalFrame* frame)
        : WebCore::FrameNetworkingContext(frame)
    {
    }

    WebCore::NetworkStorageSession* storageSession() const final;
    WebCore::ResourceError blockedError(const WebCore::ResourceRequest&) const final;
};

} // namespace ShotKit
