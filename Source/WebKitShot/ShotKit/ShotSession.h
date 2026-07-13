/*
 * ShotSession.h — 进程级 ephemeral 网络会话（内存 cookie 库）。
 *
 * ephemeral SessionID 会让 curl 的 NetworkStorageSession 自动用 :memory: cookie 库
 *（NetworkStorageSessionCurl.cpp:90），不落盘。整个进程共享一个会话。
 * 见 Source/WebKitShot/docs/network-integration-map.md 第 5 节。
 */

#pragma once

namespace WebCore {
class CurlResponse;
class NetworkStorageSession;
class ResourceRequest;
}

namespace ShotKit {

// 进程级单例（惰性创建、故意泄漏，随进程退出）。首次调用须在主线程、ShotKit::initialize 之后。
WebCore::NetworkStorageSession& networkStorageSession();

// 请求发出前，把匹配的 cookie 追加到 Cookie 头。
void appendRequestCookies(WebCore::ResourceRequest&);

// 响应到达后，把 Set-Cookie 写回内存 cookie 库。
void storeResponseCookies(const WebCore::ResourceRequest&, const WebCore::CurlResponse&);

} // namespace ShotKit
