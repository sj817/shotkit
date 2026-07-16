/*
 * ShotSession.cpp — 单次渲染的纯内存 CookieJar，见 ShotSession.h。
 */

#include "config.h"
#include "ShotSession.h"

#include <WebCore/Cookie.h>
#include <WebCore/CookieUtil.h>
#include <WebCore/CurlResponse.h>
#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/ResourceRequest.h>
#include <wtf/URL.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/Vector.h>
#include <wtf/WallTime.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

namespace ShotKit {

using namespace WebCore;

namespace {

struct StoredCookie {
    Cookie cookie;
    bool hostOnly { true };
};

Vector<StoredCookie>& cookies()
{
    static NeverDestroyed<Vector<StoredCookie>> storage;
    return storage.get();
}

bool pathMatches(const String& cookiePath, StringView requestPath)
{
    if (cookiePath == requestPath)
        return true;
    if (!requestPath.startsWith(cookiePath))
        return false;
    return cookiePath.endsWith('/') || (requestPath.length() > cookiePath.length() && requestPath[cookiePath.length()] == '/');
}

bool domainMatches(const StoredCookie& stored, const String& host)
{
    String domain = stored.cookie.domain;
    if (domain.startsWith('.'))
        domain = domain.substring(1);
    if (stored.hostOnly)
        return equalIgnoringASCIICase(domain, host);
    return CookieUtil::domainMatch(domain, host);
}

bool isExpired(const Cookie& cookie)
{
    return cookie.expires && *cookie.expires <= WallTime::now().secondsSinceEpoch().milliseconds();
}

} // anonymous namespace

void beginRenderSession()
{
    cookies().clear();
}

void appendRequestCookies(ResourceRequest& request)
{
    auto& storage = cookies();
    storage.removeAllMatching([](auto& stored) { return isExpired(stored.cookie); });

    StringBuilder header;
    for (auto& stored : storage) {
        auto& cookie = stored.cookie;
        if (cookie.secure && !request.url().protocolIs("https"_s))
            continue;
        if (!domainMatches(stored, request.url().host().toString()))
            continue;
        if (!pathMatches(cookie.path, request.url().path()))
            continue;
        if (!header.isEmpty())
            header.append("; "_s);
        header.append(cookie.name, '=', cookie.value);
    }
    if (!header.isEmpty())
        request.addHTTPHeaderField(HTTPHeaderName::Cookie, header.toString());
}

void storeResponseCookies(const ResourceRequest&, const CurlResponse& response)
{
    static constexpr auto setCookieHeader = "set-cookie: "_s;
    auto host = response.url.host().toString().convertToASCIILowercase();

    for (auto header : response.headers) {
        if (!header.startsWithIgnoringASCIICase(setCookieHeader))
            continue;

        auto parsed = CookieUtil::parseCookieHeader(header.substring(setCookieHeader.length()));
        if (!parsed || parsed->name.isEmpty())
            continue;

        bool hostOnly = parsed->domain.isEmpty();
        if (hostOnly)
            parsed->domain = host;
        else if (!CookieUtil::domainMatch(parsed->domain, host))
            continue;
        if (parsed->path.isEmpty())
            parsed->path = CookieUtil::defaultPathForURL(response.url);
        parsed->created = WallTime::now().secondsSinceEpoch().milliseconds();

        auto& storage = cookies();
        storage.removeAllMatching([&](auto& stored) {
            return equalIgnoringASCIICase(stored.cookie.name, parsed->name)
                && equalIgnoringASCIICase(stored.cookie.domain, parsed->domain)
                && stored.cookie.path == parsed->path;
        });
        if (!isExpired(*parsed))
            storage.append({ WTF::move(*parsed), hostOnly });
    }
}

} // namespace ShotKit
