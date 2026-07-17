/*
 * ShotLoaderStrategy.h — 单进程 curl 直驱 LoaderStrategy。
 *
 * 蓝本 WebResourceLoadScheduler，差异只在"起飞"：不走 resourceLoader->start()
 *（curl 的 ResourceHandle 后端已删），http(s) 改用 ShotCurlResourceLoader 驱动 CurlRequest。
 * data:/blob:/about: 仍走内置 start()。见 docs/network-integration-map.md。
 */

#pragma once

#include <wtf/Platform.h>
#if USE(CURL)
#include "ShotCurlResourceLoader.h" // Ref<ShotCurlResourceLoader> 需完整类型
#endif
#include <WebCore/LoaderStrategy.h>
#include <WebCore/ResourceError.h>
#include <wtf/CompletionHandler.h>
#include <wtf/HashMap.h>
#include <wtf/Ref.h>

namespace ShotKit {

class ShotLoaderStrategy final : public WebCore::LoaderStrategy {
public:
    ShotLoaderStrategy();
    ~ShotLoaderStrategy();

    // ShotCurlResourceLoader 完成/失败时回调，摘除映射（释放最后一个 Ref）。
    void didCompleteLoad(WebCore::ResourceLoader&);

    // 完成状态机用：是否仍有在途 curl 子资源加载。
    bool hasPendingLoads() const
    {
#if USE(CURL)
        return !m_handles.isEmpty();
#else
        return false;
#endif
    }

private:
    void loadResource(WebCore::LocalFrame&, WebCore::CachedResource&, WebCore::ResourceRequest&&, const WebCore::ResourceLoaderOptions&, WTF::CompletionHandler<void(RefPtr<WebCore::SubresourceLoader>&&)>&&) final;
    void loadResourceSynchronously(WebCore::FrameLoader&, WebCore::ResourceLoaderIdentifier, const WebCore::ResourceRequest&, WebCore::ClientCredentialPolicy, const WebCore::FetchOptions&, const WebCore::HTTPHeaderMap&, WebCore::ResourceError&, WebCore::ResourceResponse&, WTF::Vector<uint8_t>&) final;
    void pageLoadCompleted(WebCore::Page&) final { }
    void browsingContextRemoved(WebCore::LocalFrame&) final { }
    void remove(WebCore::ResourceLoader*) final;
    void setDefersLoading(WebCore::ResourceLoader&, bool) final { }
    void crossOriginRedirectReceived(WebCore::ResourceLoader*, const URL&) final { }
    void servePendingRequests(WebCore::ResourceLoadPriority) final { }
    void suspendPendingRequests() final { }
    void resumePendingRequests() final { }
    void startPingLoad(WebCore::LocalFrame&, WebCore::ResourceRequest&, const WebCore::HTTPHeaderMap&, const WebCore::FetchOptions&, WebCore::ContentSecurityPolicyImposition, PingLoadCompletionHandler&&) final { }
    void preconnectTo(WebCore::FrameLoader&, WebCore::ResourceRequest&&, WebCore::StoredCredentialsPolicy, ShouldPreconnectAsFirstParty, PreconnectCompletionHandler&&) final { }
    void setCaptureExtraNetworkLoadMetricsEnabled(bool) final { }
    bool isOnLine() const final { return true; }
    void addOnlineStateChangeListener(WTF::Function<void(bool)>&&) final { }
    void isResourceLoadFinished(WebCore::CachedResource&, WTF::CompletionHandler<void(bool)>&& callback) final { callback(true); }
    WebCore::ResourceError cancelledError(const WebCore::ResourceRequest& request) const final;
    WebCore::ResourceError blockedError(const WebCore::ResourceRequest&) const final { return { }; }
    bool isBlockedError(const WebCore::ResourceError&) const final { return false; }
    WebCore::ResourceError blockedByContentBlockerError(const WebCore::ResourceRequest&) const final { return { }; }
    WebCore::ResourceError cannotShowURLError(const WebCore::ResourceRequest&) const final { return { }; }
    WebCore::ResourceError interruptedForPolicyChangeError(const WebCore::ResourceRequest&) const final { return { }; }
    WebCore::ResourceError cannotShowMIMETypeError(const WebCore::ResourceResponse&) const final { return { }; }
    WebCore::ResourceError fileDoesNotExistError(const WebCore::ResourceResponse&) const final { return { }; }
    WebCore::ResourceError httpsUpgradeRedirectLoopError(const WebCore::ResourceRequest&) const final { return { }; }
    WebCore::ResourceError httpNavigationWithHTTPSOnlyError(const WebCore::ResourceRequest&) const final { return { }; }
    bool isHttpNavigationWithHTTPSOnlyError(const WebCore::ResourceError&) const final { return false; }
    WebCore::ResourceError pluginWillHandleLoadError(const WebCore::ResourceResponse&) const final { return { }; }

    void startLoad(WebCore::ResourceLoader&);

#if USE(CURL)
    HashMap<WebCore::ResourceLoader*, Ref<ShotCurlResourceLoader>> m_handles;
#endif
};

// 进程内当前活跃的 LoaderStrategy（PlatformStrategies 单例创建时登记），供完成状态机查在途加载。
ShotLoaderStrategy* activeShotLoaderStrategy();

} // namespace ShotKit
