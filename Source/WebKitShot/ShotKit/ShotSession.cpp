/*
 * ShotSession.cpp — 见 ShotSession.h。
 */

#include "config.h"
#include "ShotSession.h"

#include <WebCore/CurlResponse.h>
#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/NetworkStorageSession.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/SameSiteInfo.h>
#include <pal/SessionID.h>
#include <wtf/NeverDestroyed.h>

namespace ShotKit {

using namespace WebCore;

NetworkStorageSession& networkStorageSession()
{
    // ephemeral → CookieJarDB(":memory:")，进程内共享。NeverDestroyed 原地构造并泄漏。
    static WTF::NeverDestroyed<NetworkStorageSession> session(PAL::SessionID::generateEphemeralSessionID());
    return session.get();
}

void appendRequestCookies(ResourceRequest& request)
{
    auto& session = networkStorageSession();
    auto includeSecureCookies = request.url().protocolIs("https"_s) ? IncludeSecureCookies::Yes : IncludeSecureCookies::No;
    auto cookie = session.cookieRequestHeaderFieldValue(request.firstPartyForCookies(), SameSiteInfo::create(request), request.url(), std::nullopt, std::nullopt, includeSecureCookies, ApplyTrackingPrevention::Yes, ShouldRelaxThirdPartyCookieBlocking::No, IsKnownCrossSiteTracker::No).first;
    if (!cookie.isEmpty())
        request.addHTTPHeaderField(HTTPHeaderName::Cookie, cookie);
}

void storeResponseCookies(const ResourceRequest& request, const CurlResponse& response)
{
    static constexpr auto setCookieHeader = "set-cookie: "_s;
    auto& session = networkStorageSession();
    for (auto header : response.headers) {
        if (header.startsWithIgnoringASCIICase(setCookieHeader)) {
            String value = header.right(header.length() - setCookieHeader.length());
            session.setCookiesFromHTTPResponse(request.firstPartyForCookies(), response.url, value);
        }
    }
}

} // namespace ShotKit
