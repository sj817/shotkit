/*
 * Copyright (C) 2018 Sony Interactive Entertainment Inc.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 * notice, this list of conditions and the following disclaimer in the
 * documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE INC. AND ITS CONTRIBUTORS ``AS IS'' AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL APPLE INC. OR ITS CONTRIBUTORS BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

#include "config.h"
#include "CookieJarDB.h"
#include "CookieJar.h"

#include "CookieUtil.h"
#include "PublicSuffixStore.h"
#include "RegistrableDomain.h"
#include <algorithm>
#include <wtf/DateMath.h>
#include <wtf/MonotonicTime.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/URL.h>
#include <wtf/Vector.h>
#include <wtf/WallTime.h>
#include <wtf/text/MakeString.h>

namespace WebCore {

WTF_MAKE_TZONE_ALLOCATED_IMPL(CookieJarDB);

// At least 50 cookies per domain (RFC6265 6.1. Limits)
#define MAX_COOKIE_PER_DOMAIN 80

// Cookie text is normalized on the way in so that a null and an empty string never compare as two
// different keys, and so that callers always get a well-formed string back.
static String normalizedCookieText(const String& text)
{
    return text.isNull() ? emptyString() : text;
}

// A request host is matched against an exact domain and, when the host has a usable registrable
// domain, against every subdomain of it. A null suffix means only the exact domain applies, which
// is the case for IP literals and single label hosts.
static String subdomainSuffixForHost(const URL& url, const String& host)
{
    RegistrableDomain registrableDomain { url };
    if (CookieUtil::isIPAddress(host) || !host.contains('.') || registrableDomain.isEmpty())
        return { };

    return makeString('.', registrableDomain.string());
}

static bool matchesDomainPatterns(const String& domain, const String& exactDomain, const String& subdomainSuffix)
{
    if (domain == exactDomain)
        return true;

    return !subdomainSuffix.isNull() && domain.endsWith(subdomainSuffix);
}

// Session cookies are always readable; a cookie carrying an expiry date is dropped from lookups
// once that date has passed, and so is a non-session cookie without any expiry date.
static bool isExpiredCookie(const Cookie& cookie, double currentTimeMS)
{
    return !cookie.session && cookie.expires.value_or(0.0) < currentTimeMS;
}

CookieJarDB::CookieJarDB(const String& databasePath)
    : m_databasePath(databasePath)
{
}

CookieJarDB::~CookieJarDB() = default;

void CookieJarDB::open()
{
    // Cookies live in memory for the lifetime of the jar and are never persisted, so opening only
    // marks the storage as usable. The database path is kept for isEnabled() alone.
    m_isOpen = true;
}

bool CookieJarDB::isEnabled() const
{
    if (m_databasePath.isEmpty())
        return false;

    return (m_acceptPolicy == CookieAcceptPolicy::Always || m_acceptPolicy == CookieAcceptPolicy::OnlyFromMainDocumentDomain || m_acceptPolicy == CookieAcceptPolicy::ExclusivelyFromMainDocumentDomain);
}

bool CookieJarDB::checkCookieAcceptPolicy(const URL& firstParty, const URL& url)
{
    if (m_acceptPolicy == CookieAcceptPolicy::Always)
        return true;

    // See https://bugs.webkit.org/show_bug.cgi?id=193458#c0
    if (m_acceptPolicy != CookieAcceptPolicy::OnlyFromMainDocumentDomain && m_acceptPolicy != CookieAcceptPolicy::ExclusivelyFromMainDocumentDomain)
        return false;

    if (firstParty.host() == url.host())
        return true;

    if (RegistrableDomain(firstParty).matches(url))
        return true;

    // third-party resources can read or write cookies if they have pre-existing cookies.
    if (m_acceptPolicy == CookieAcceptPolicy::OnlyFromMainDocumentDomain && hasCookies(url))
        return true;

    return false;
}

bool CookieJarDB::hasCookies(const URL& url)
{
    String host = url.host().convertToASCIILowercase();
    if (host.isEmpty())
        return false;

    if (PublicSuffixStore::singleton().isPublicSuffix(host))
        return false;

    RegistrableDomain registrableDomain { url };

    // Unlike a request lookup, the pre-existing cookie check matches the registrable domain itself
    // as well as all of its subdomains.
    String exactDomain = host;
    String subdomainSuffix;
    if (!CookieUtil::isIPAddress(host) && host.contains('.') && !registrableDomain.isEmpty()) {
        exactDomain = registrableDomain.string();
        subdomainSuffix = makeString('.', registrableDomain.string());
    }

    for (const auto& record : m_cookies) {
        if (matchesDomainPatterns(record.cookie.domain, exactDomain, subdomainSuffix))
            return true;
    }

    return false;
}

std::optional<Vector<Cookie>> CookieJarDB::searchCookies(const URL& firstParty, const URL& requestUrl, const std::optional<bool>& httpOnly, const std::optional<bool>& secure, const std::optional<bool>& session)
{
    if (!isEnabled() || !m_isOpen)
        return std::nullopt;

    String requestHost = requestUrl.host().convertToASCIILowercase();
    if (requestHost.isEmpty())
        return std::nullopt;

    if (!checkCookieAcceptPolicy(firstParty, requestUrl))
        return std::nullopt;

    String requestPath = requestUrl.path().toString();
    if (requestPath.isEmpty())
        requestPath = "/"_s;

    auto subdomainSuffix = subdomainSuffixForHost(requestUrl, requestHost);
    auto currentTimeMS = WallTime::now().secondsSinceEpoch().milliseconds();

    Vector<size_t> matches;
    for (size_t index = 0; index < m_cookies.size(); ++index) {
        const auto& cookie = m_cookies[index].cookie;

        if (isExpiredCookie(cookie, currentTimeMS))
            continue;

        if (httpOnly && *httpOnly != cookie.httpOnly)
            continue;

        if (secure && *secure != cookie.secure)
            continue;

        if (session && *session != cookie.session)
            continue;

        if (!matchesDomainPatterns(cookie.domain, requestHost, subdomainSuffix))
            continue;

        matches.append(index);
    }

    // The most specific path wins, and cookies sharing a path length are returned from the least to
    // the most recently updated one.
    std::sort(matches.begin(), matches.end(), [&](size_t first, size_t second) {
        const auto& firstRecord = m_cookies[first];
        const auto& secondRecord = m_cookies[second];
        if (firstRecord.cookie.path.length() != secondRecord.cookie.path.length())
            return firstRecord.cookie.path.length() > secondRecord.cookie.path.length();
        return firstRecord.lastUpdated < secondRecord.lastUpdated;
    });

    Vector<Cookie> results;

    for (auto index : matches) {
        if (results.size() > MAX_COOKIE_PER_DOMAIN)
            break;

        const auto& stored = m_cookies[index].cookie;
        String cookieDomain = stored.domain.convertToASCIILowercase();
        const String& cookiePath = stored.path;

        if (!CookieUtil::domainMatch(cookieDomain, requestHost))
            continue;

        // https://tools.ietf.org/html/rfc6265#section-5.1.4 "Paths and Path-Match"
        bool isPathMatched = cookiePath == requestPath
            || (requestPath.startsWith(cookiePath) && cookiePath.endsWith('/'))
            || (requestPath.startsWith(cookiePath) && (requestPath.codeUnitAt(cookiePath.length()) == '/'));

        if (!isPathMatched)
            continue;

        Cookie cookie;
        cookie.name = stored.name;
        cookie.value = stored.value;
        cookie.domain = cookieDomain;
        cookie.path = cookiePath;
        cookie.expires = stored.expires;
        cookie.httpOnly = stored.httpOnly;
        cookie.secure = stored.secure;
        cookie.session = stored.session;
        results.append(WTF::move(cookie));
    }

    return results;
}

Vector<Cookie> CookieJarDB::getAllCookies()
{
    Vector<Cookie> result;
    if (!isEnabled() || !m_isOpen)
        return result;

    result.reserveInitialCapacity(m_cookies.size());
    for (const auto& record : m_cookies) {
        const auto& stored = record.cookie;

        Cookie cookie;
        cookie.name = stored.name;
        cookie.value = stored.value;
        cookie.domain = stored.domain.convertToASCIILowercase();
        cookie.path = stored.path;
        cookie.expires = stored.expires;
        cookie.httpOnly = stored.httpOnly;
        cookie.secure = stored.secure;
        cookie.session = stored.session;
        result.append(WTF::move(cookie));
    }
    return result;
}

bool CookieJarDB::hasHttpOnlyCookie(const String& name, const String& domain, const String& path)
{
    auto cookieName = normalizedCookieText(name);
    auto cookieDomain = normalizedCookieText(domain);
    auto cookiePath = normalizedCookieText(path);

    for (const auto& record : m_cookies) {
        const auto& cookie = record.cookie;
        if (cookie.httpOnly && cookie.name == cookieName && cookie.domain == cookieDomain && cookie.path == cookiePath)
            return true;
    }

    return false;
}

static bool checkSecureCookie(const Cookie& cookie)
{
    if (cookie.name.startsWith("__Secure-"_s) && !cookie.secure)
        return false;

    // Cookies for __Host must have the Secure attribute, path explicitly set to "/", and no domain attribute
    if (cookie.name.startsWith("__Host-"_s) && (!cookie.secure || cookie.path != "/"_s || !cookie.domain.isEmpty()))
        return false;

    return true;
}

bool CookieJarDB::canAcceptCookie(const Cookie& cookie, const URL& firstParty, const URL& url, CookieJarDB::Source source)
{
    if (PublicSuffixStore::singleton().isPublicSuffix(cookie.domain))
        return false;

    bool fromJavaScript = source == CookieJarDB::Source::Script;
    if (fromJavaScript && (cookie.httpOnly || hasHttpOnlyCookie(cookie.name, cookie.domain, cookie.path)))
        return false;

    if (!CookieUtil::domainMatch(cookie.domain, url.host().convertToASCIILowercase()))
        return false;

    if (!checkCookieAcceptPolicy(firstParty, url))
        return false;

    return true;
}

bool CookieJarDB::setCookie(const Cookie& cookie)
{
    auto expires = cookie.expires.value_or(0.0);
    if (!cookie.session && MonotonicTime::fromRawSeconds(expires / msPerSecond) <= MonotonicTime::now())
        return deleteCookieInternal(cookie.name, cookie.domain, cookie.path);

    // FIXME: We should have some eviction policy when a domain goes over MAX_COOKIE_PER_DOMAIN
    Cookie stored;
    stored.name = normalizedCookieText(cookie.name);
    stored.value = normalizedCookieText(cookie.value);
    stored.domain = normalizedCookieText(cookie.domain);
    stored.path = normalizedCookieText(cookie.path);
    if (auto expiresMS = cookie.session ? 0 : static_cast<int64_t>(expires))
        stored.expires = static_cast<double>(expiresMS);
    stored.httpOnly = cookie.httpOnly;
    stored.secure = cookie.secure;
    stored.session = cookie.session;

    // A cookie is uniquely identified by its name, domain and path, so an existing one is replaced
    // in place and gets a fresh update stamp.
    for (auto& record : m_cookies) {
        if (record.cookie.isKeyEqual(stored)) {
            record.cookie = WTF::move(stored);
            record.lastUpdated = ++m_lastUpdate;
            return true;
        }
    }

    m_cookies.append(CookieRecord { WTF::move(stored), ++m_lastUpdate });
    return true;
}

bool CookieJarDB::setCookie(const URL& firstParty, const URL& url, const String& body, CookieJarDB::Source source, std::optional<Seconds> cappedLifetime)
{
    if (!isEnabled() || !m_isOpen)
        return false;

    if (url.isEmpty() || body.isEmpty())
        return false;

    auto cookie = CookieUtil::parseCookieHeader(body);
    if (!cookie || (cookie->name.isEmpty() && cookie->value.isEmpty()))
        return false;

    if (!checkSecureCookie(*cookie))
        return false;

    if (cookie->domain.isEmpty())
        cookie->domain = url.host().convertToASCIILowercase();

    if (cookie->path.isEmpty())
        cookie->path = CookieUtil::defaultPathForURL(url);

    if (!canAcceptCookie(*cookie, firstParty, url, source))
        return false;

    if (cappedLifetime && cookie->expires) {
        ASSERT(*cappedLifetime >= 0_s);
        auto cappedExpires = WallTime::now() + *cappedLifetime;
        if (cappedExpires < WallTime::fromRawSeconds(*cookie->expires / msPerSecond))
            cookie->expires = cappedExpires.secondsSinceEpoch().milliseconds();
    }

    return setCookie(*cookie);
}

HashSet<String> CookieJarDB::allDomains()
{
    HashSet<String> domains;
    for (const auto& record : m_cookies)
        domains.add(record.cookie.domain);
    return domains;
}

bool CookieJarDB::deleteCookie(const String& url, const String& name)
{
    if (!isEnabled() || !m_isOpen)
        return false;

    String urlCopied = String(url);
    if (urlCopied.startsWith('.'))
        urlCopied = urlCopied.substring(1);

    URL urlObj({ }, urlCopied);
    if (urlObj.isValid()) {
        String hostStr(urlObj.host().toString());
        String pathStr(urlObj.path().toString());
        return deleteCookieInternal(name, hostStr, pathStr);
    }

    return false;
}

bool CookieJarDB::deleteCookieInternal(const String& name, const String& domain, const String& path)
{
    auto cookieName = normalizedCookieText(name);
    auto cookieDomain = normalizedCookieText(domain);
    bool matchPath = !path.isEmpty();

    m_cookies.removeAllMatching([&](const auto& record) {
        const auto& cookie = record.cookie;
        return cookie.name == cookieName && cookie.domain == cookieDomain && (!matchPath || cookie.path == path);
    });

    return true;
}

bool CookieJarDB::deleteCookies(const String&)
{
    // NOT IMPLEMENTED
    // TODO: this function will be called if application calls WKCookieManagerDeleteCookiesForHostname() in WKCookieManager.h.
    return false;
}

bool CookieJarDB::deleteCookiesForHostname(const String& hostname, IncludeHttpOnlyCookies includeHttpOnlyCookies)
{
    auto cookieDomain = normalizedCookieText(hostname);
    bool includeHttpOnly = includeHttpOnlyCookies == IncludeHttpOnlyCookies::Yes;

    m_cookies.removeAllMatching([&](const auto& record) {
        const auto& cookie = record.cookie;
        return cookie.domain == cookieDomain && (includeHttpOnly || !cookie.httpOnly);
    });

    return true;
}

bool CookieJarDB::deleteAllCookies()
{
    if (!isEnabled() || !m_isOpen)
        return false;

    m_cookies.clear();
    return true;
}

} // namespace WebCore
