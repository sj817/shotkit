/*
 * ShotCurlResourceLoader.cpp — 见 ShotCurlResourceLoader.h。
 */

#include "config.h"
#include "ShotCurlResourceLoader.h"

#include "ShotLoaderStrategy.h"
#include "ShotSession.h"
#include <WebCore/CurlRequest.h>
#include <WebCore/CurlResponse.h>
#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/NetworkStorageSession.h>
#include <WebCore/ResourceError.h>
#include <WebCore/ResourceLoader.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/SameSiteInfo.h>
#include <WebCore/SharedBuffer.h>
#include <wtf/CompletionHandler.h>

namespace ShotKit {

using namespace WebCore;

Ref<ShotCurlResourceLoader> ShotCurlResourceLoader::create(ResourceLoader& loader, ShotLoaderStrategy& strategy)
{
    return adoptRef(*new ShotCurlResourceLoader(loader, strategy));
}

ShotCurlResourceLoader::ShotCurlResourceLoader(ResourceLoader& loader, ShotLoaderStrategy& strategy)
    : m_loader(&loader)
    , m_strategy(strategy)
{
}

ShotCurlResourceLoader::~ShotCurlResourceLoader()
{
    if (m_curlRequest)
        m_curlRequest->invalidateClient();
}

void ShotCurlResourceLoader::start()
{
    startRequest(ResourceRequest(m_loader->request()));
}

void ShotCurlResourceLoader::startRequest(ResourceRequest&& request)
{
    appendRequestCookies(request);
    m_curlRequest = CurlRequest::create(request, *this);
    m_curlRequest->resume();
}

void ShotCurlResourceLoader::cancel()
{
    m_cancelled = true;
    if (m_curlRequest) {
        m_curlRequest->invalidateClient();
        m_curlRequest->cancel();
        m_curlRequest = nullptr;
    }
}

void ShotCurlResourceLoader::complete()
{
    if (m_curlRequest) {
        m_curlRequest->invalidateClient();
        m_curlRequest = nullptr;
    }
    if (m_loader)
        m_strategy.didCompleteLoad(*m_loader);
}

bool ShotCurlResourceLoader::shouldRedirect() const
{
    auto code = m_response.httpStatusCode();
    if (code < 300 || code >= 400)
        return false;
    if (code == 300 || code == 304 || code == 305 || code == 306)
        return false;
    return !m_response.httpHeaderField(HTTPHeaderName::Location).isEmpty();
}

void ShotCurlResourceLoader::willPerformRedirect()
{
    static const unsigned maxRedirects = 20;
    String location = m_response.httpHeaderField(HTTPHeaderName::Location);
    URL base = m_response.url();
    URL redirectedURL(base, location);
    if (++m_redirectCount > maxRedirects || redirectedURL.protocolIsFile()) {
        m_loader->didFail(ResourceError("ShotKit"_s, 0, m_response.url(), "redirect error"_s));
        complete();
        return;
    }

    ResourceRequest newRequest = m_loader->request();
    newRequest.setURL(WTF::move(redirectedURL));
    newRequest.removeHTTPHeaderField(HTTPHeaderName::Cookie);
    ResourceResponse redirectResponse = m_response;

    if (m_curlRequest) {
        m_curlRequest->invalidateClient();
        m_curlRequest->cancel();
        m_curlRequest = nullptr;
    }

    m_loader->willSendRequest(WTF::move(newRequest), redirectResponse, [this, protectedThis = Ref { *this }](ResourceRequest&& request) {
        if (m_cancelled || request.isNull()) {
            complete();
            return;
        }
        startRequest(WTF::move(request));
    });
}

void ShotCurlResourceLoader::curlDidSendData(CurlRequest&, unsigned long long, unsigned long long)
{
}

void ShotCurlResourceLoader::curlDidReceiveResponse(CurlRequest& request, CurlResponse&& received)
{
    Ref protectedThis { *this };
    if (m_cancelled)
        return;

    m_response = ResourceResponse(received);
    storeResponseCookies(request.resourceRequest(), received);

    if (shouldRedirect()) {
        willPerformRedirect();
        return;
    }

    m_loader->didReceiveResponse(ResourceResponse(m_response), [this, protectedThis = Ref { *this }]() {
        if (m_cancelled)
            return;
        if (m_curlRequest)
            m_curlRequest->completeDidReceiveResponse();
    });
}

void ShotCurlResourceLoader::curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer)
{
    Ref protectedThis { *this };
    if (m_cancelled)
        return;
    auto size = static_cast<long long>(buffer->size());
    m_loader->didReceiveData(buffer.get(), size, DataPayloadBytes);
}

void ShotCurlResourceLoader::curlDidComplete(CurlRequest&, NetworkLoadMetrics&& metrics)
{
    Ref protectedThis { *this };
    if (m_cancelled)
        return;
    m_loader->didFinishLoading(metrics);
    complete();
}

void ShotCurlResourceLoader::curlDidFailWithError(CurlRequest&, ResourceError&& error, CertificateInfo&&)
{
    Ref protectedThis { *this };
    if (m_cancelled)
        return;
    m_loader->didFail(error);
    complete();
}

} // namespace ShotKit
