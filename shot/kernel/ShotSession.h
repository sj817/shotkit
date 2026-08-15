/*
 * ShotSession.h — 单次渲染生命周期的内存 CookieJar。
 *
 * 不落盘、不使用 SQLite；每次公开 render 调用开始时清空，页面主请求、重定向和
 * 子资源之间仍共享 cookie，下一次截图绝不会继承状态。
 */

#pragma once

namespace WebCore {
class CurlResponse;
class NetworkStorageSession;
class ResourceRequest;
}

namespace ShotKit {

// 开始一次新的渲染，清空上一次截图留下的全部 cookie。
void beginRenderSession();

// Cocoa uses one private CFNetwork storage session for main and subresources.
WebCore::NetworkStorageSession* activeNetworkStorageSession();

// 请求发出前，把匹配的 cookie 追加到 Cookie 头。
void appendRequestCookies(WebCore::ResourceRequest&);

// 响应到达后，把 Set-Cookie 写回内存 cookie 库。
void storeResponseCookies(const WebCore::ResourceRequest&, const WebCore::CurlResponse&);

} // namespace ShotKit
