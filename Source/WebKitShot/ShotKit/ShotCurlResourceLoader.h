/*
 * ShotCurlResourceLoader.h — 用 CurlRequest 驱动一个子资源加载，事件回灌 ResourceLoader。
 *
 * 实现 CurlRequestClient 的 5 个回调，转发到 ResourceLoader 的公开虚函数
 *（didReceiveResponse/didReceiveData/didFinishLoading/didFail/willSendRequest），
 * 守 completeDidReceiveResponse() 握手，cookie 读写走进程级 ephemeral 会话。
 * 蓝本 NetworkDataTaskCurl.cpp（去掉 Download/NetworkProcess 分支）。见 network-integration-map.md 第 3/4 节。
 */

#pragma once

#include <WebCore/CurlRequestClient.h>
#include <WebCore/ResourceResponse.h>
#include <wtf/Ref.h>
#include <wtf/RefCounted.h>
#include <wtf/RefPtr.h>

namespace WebCore {
class CurlRequest;
class ResourceLoader;
class ResourceRequest;
}

namespace ShotKit {

class ShotLoaderStrategy;

class ShotCurlResourceLoader final : public WTF::RefCounted<ShotCurlResourceLoader>, public WebCore::CurlRequestClient {
public:
    static Ref<ShotCurlResourceLoader> create(WebCore::ResourceLoader&, ShotLoaderStrategy&);
    ~ShotCurlResourceLoader();

    void start();
    void cancel();

    // CurlRequestClient : AbstractRefCounted —— 用 RefCounted 满足 virtual ref/deref。
    void ref() const final { WTF::RefCounted<ShotCurlResourceLoader>::ref(); }
    void deref() const final { WTF::RefCounted<ShotCurlResourceLoader>::deref(); }

private:
    ShotCurlResourceLoader(WebCore::ResourceLoader&, ShotLoaderStrategy&);

    void startRequest(WebCore::ResourceRequest&&);
    bool shouldRedirect() const;
    void willPerformRedirect();
    void complete();

    // CurlRequestClient
    void curlDidSendData(WebCore::CurlRequest&, unsigned long long, unsigned long long) final;
    void curlDidReceiveResponse(WebCore::CurlRequest&, WebCore::CurlResponse&&) final;
    void curlDidReceiveData(WebCore::CurlRequest&, Ref<WebCore::SharedBuffer>&&) final;
    void curlDidComplete(WebCore::CurlRequest&, WebCore::NetworkLoadMetrics&&) final;
    void curlDidFailWithError(WebCore::CurlRequest&, WebCore::ResourceError&&, WebCore::CertificateInfo&&) final;

    RefPtr<WebCore::ResourceLoader> m_loader;
    ShotLoaderStrategy& m_strategy;
    RefPtr<WebCore::CurlRequest> m_curlRequest;
    WebCore::ResourceResponse m_response;
    unsigned m_redirectCount { 0 };
    bool m_cancelled { false };
};

} // namespace ShotKit
