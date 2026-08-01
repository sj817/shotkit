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

#pragma once

#include "Cookie.h"
#include "CookieJar.h"
#include <wtf/HashSet.h>
#include <wtf/Noncopyable.h>
#include <wtf/Seconds.h>
#include <wtf/TZoneMalloc.h>
#include <wtf/Vector.h>
#include <wtf/text/StringHash.h>

namespace WebCore {

enum class CookieAcceptPolicy {
    Always,
    Never,
    OnlyFromMainDocumentDomain,
    ExclusivelyFromMainDocumentDomain
};

class CookieJarDB {
    WTF_MAKE_TZONE_ALLOCATED(CookieJarDB);
    WTF_MAKE_NONCOPYABLE(CookieJarDB);

public:
    enum class Source : uint8_t {
        Network,
        Script
    };

    WEBCORE_EXPORT void open();
    bool isEnabled() const;

    void setAcceptPolicy(CookieAcceptPolicy policy) { m_acceptPolicy = policy; }
    CookieAcceptPolicy acceptPolicy() const { return m_acceptPolicy; }

    HashSet<String> allDomains();
    std::optional<Vector<Cookie>> searchCookies(const URL& firstParty, const URL& requestUrl, const std::optional<bool>& httpOnly, const std::optional<bool>& secure, const std::optional<bool>& session);
    Vector<Cookie> getAllCookies();
    WEBCORE_EXPORT bool setCookie(const URL& firstParty, const URL&, const String& cookie, Source, std::optional<Seconds> cappedLifetime = std::nullopt);
    bool setCookie(const Cookie&);

    bool deleteCookie(const String& url, const String& name);
    bool deleteCookies(const String& url);
    bool deleteCookiesForHostname(const String& hostname, IncludeHttpOnlyCookies);
    bool deleteAllCookies();

    WEBCORE_EXPORT CookieJarDB(const String& databasePath);
    WEBCORE_EXPORT ~CookieJarDB();

private:
    // A stored cookie plus the stamp that orders equally specific matches from the least to the
    // most recently updated one.
    struct CookieRecord {
        Cookie cookie;
        uint64_t lastUpdated { 0 };
    };

    CookieAcceptPolicy m_acceptPolicy { CookieAcceptPolicy::Always };
    String m_databasePath;

    bool m_isOpen { false };

    bool deleteCookieInternal(const String& name, const String& domain, const String& path);
    bool hasHttpOnlyCookie(const String& name, const String& domain, const String& path);
    bool canAcceptCookie(const Cookie&, const URL& firstParty, const URL&, CookieJarDB::Source);
    bool checkCookieAcceptPolicy(const URL& firstParty, const URL&);
    bool hasCookies(const URL&);

    Vector<CookieRecord> m_cookies;
    uint64_t m_lastUpdate { 0 };
};

} // namespace WebCore
