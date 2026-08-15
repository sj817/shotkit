/*
 * ShotSession.cpp — 单次渲染的纯内存 CookieJar，见 ShotSession.h。
 */

#include "config.h"
#include "ShotSession.h"

#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/ResourceRequest.h>
#include <wtf/URL.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/Vector.h>
#include <wtf/WallTime.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

#if USE(CURL)
#include <WebCore/Cookie.h>
#include <WebCore/CookieUtil.h>
#include <WebCore/CurlResponse.h>
#endif

#if PLATFORM(COCOA)
#include <WebCore/EmptyClients.h>
#include <WebCore/NetworkStorageSession.h>
#include <pal/SessionID.h>
#include <wtf/CompletionHandler.h>
#include <wtf/RetainPtr.h>
#endif

namespace ShotKit {

using namespace WebCore;

namespace {

#if PLATFORM(COCOA)
std::unique_ptr<NetworkStorageSession>& cocoaStorageSession()
{
    static NeverDestroyed<std::unique_ptr<NetworkStorageSession>> session;
    return session.get();
}

NetworkStorageSession& ensureCocoaStorageSession()
{
    auto& session = cocoaStorageSession();
    if (!session) {
        NetworkStorageSession::permitProcessToUseCookieAPI(true);
        auto identifier = "ShotKit-InMemory"_s.createCFString();
        auto platformSession = NetworkStorageSession::createCFStorageSessionForIdentifier(identifier.get(), NetworkStorageSession::ShouldDisableCFURLCache::Yes);
        auto cookieStorage = adoptCF(_CFURLStorageSessionCopyCookieStorage(kCFAllocatorDefault, platformSession.get()));
        session = makeUnique<NetworkStorageSession>(PAL::SessionID::defaultSessionID(), WTF::move(platformSession), WTF::move(cookieStorage), NetworkStorageSession::IsInMemoryCookieStore::Yes);
        setEmptyFrameNetworkingContextStorageSession(session.get());
    }
    return *session;
}
#endif

#if USE(CURL)

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
#endif

} // anonymous namespace

void beginRenderSession()
{
#if PLATFORM(COCOA)
    ensureCocoaStorageSession().deleteAllCookies([] { });
#else
    cookies().clear();
#endif
}

NetworkStorageSession* activeNetworkStorageSession()
{
#if PLATFORM(COCOA)
    return &ensureCocoaStorageSession();
#else
    return nullptr;
#endif
}

void appendRequestCookies(ResourceRequest& request)
{
#if USE(CURL)
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
#else
    UNUSED_PARAM(request);
#endif
}

void storeResponseCookies(const ResourceRequest&, const CurlResponse& response)
{
#if USE(CURL)
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
#else
    UNUSED_PARAM(response);
#endif
}

} // namespace ShotKit
