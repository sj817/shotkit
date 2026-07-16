/*
 * ShotLoaderStrategy.cpp — 见 ShotLoaderStrategy.h。
 */

#include "config.h"
#include "ShotLoaderStrategy.h"

#include "ShotCurlResourceLoader.h"
#include <WebCore/CachedResource.h>
#include <WebCore/FetchOptions.h>
#include <WebCore/ResourceLoader.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/SubresourceLoader.h>
#include <wtf/CompletionHandler.h>

namespace ShotKit {

using namespace WebCore;

static ShotLoaderStrategy* s_activeStrategy = nullptr;

ShotLoaderStrategy* activeShotLoaderStrategy()
{
    return s_activeStrategy;
}

ShotLoaderStrategy::ShotLoaderStrategy()
{
    s_activeStrategy = this;
}

ShotLoaderStrategy::~ShotLoaderStrategy()
{
    if (s_activeStrategy == this)
        s_activeStrategy = nullptr;
}

void ShotLoaderStrategy::loadResource(LocalFrame& frame, CachedResource& resource, ResourceRequest&& request, const ResourceLoaderOptions& options, CompletionHandler<void(RefPtr<SubresourceLoader>&&)>&& completionHandler)
{
    // Defense in depth for every script request source: classic/module tags,
    // preload/modulepreload, HTTP Link headers, workers and worklets.
    if (resource.type() == CachedResource::Type::Script
        || resource.type() == CachedResource::Type::JSON
        || isScriptLikeDestination(options.destination)
        || options.destination == FetchOptions::Destination::Speculationrules) {
        completionHandler(nullptr);
        return;
    }

    SubresourceLoader::create(frame, resource, WTF::move(request), options, [this, completionHandler = WTF::move(completionHandler)](RefPtr<SubresourceLoader>&& loader) mutable {
        if (loader)
            startLoad(*loader);
        completionHandler(WTF::move(loader));
    });
}

void ShotLoaderStrategy::startLoad(ResourceLoader& loader)
{
    auto& url = loader.request().url();
    // data:/blob:/about: 走 ResourceLoader 内置路径（start() 内部 loadDataURL 短路，不触 ResourceHandle）。
    if (url.protocolIsData() || url.protocolIsBlob() || url.protocolIsAbout()) {
        loader.start();
        return;
    }
    // http(s)/file 用 curl 驱动。
    auto handle = ShotCurlResourceLoader::create(loader, *this);
    m_handles.add(&loader, handle.copyRef());
    handle->start();
}

void ShotLoaderStrategy::didCompleteLoad(ResourceLoader& loader)
{
    m_handles.remove(&loader);
}

void ShotLoaderStrategy::remove(ResourceLoader* loader)
{
    if (!loader)
        return;
    auto it = m_handles.find(loader);
    if (it == m_handles.end())
        return;
    Ref<ShotCurlResourceLoader> handle = it->value;
    m_handles.remove(it);
    handle->cancel();
}

void ShotLoaderStrategy::loadResourceSynchronously(FrameLoader&, ResourceLoaderIdentifier, const ResourceRequest&, ClientCredentialPolicy, const FetchOptions&, const HTTPHeaderMap&, ResourceError& error, ResourceResponse&, Vector<uint8_t>&)
{
    // JS 已禁用 → 无同步 XHR。直接失败。
    error = ResourceError("ShotKit"_s, 0, URL(), "synchronous load unsupported"_s);
}

ResourceError ShotLoaderStrategy::cancelledError(const ResourceRequest& request) const
{
    return ResourceError("ShotKit"_s, 0, request.url(), "cancelled"_s, ResourceError::Type::Cancellation);
}

} // namespace ShotKit
