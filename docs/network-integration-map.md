# WebCore + curl 单进程网络接入图（port=Shot, M2）

> 由调研整理，签名逐字摘录。所有路径基于 `D:\Github\webkit`。写 M2 网络栈时照此实现。

## 关键架构结论（先读）

`ResourceLoader::start()` **不可用**：它终结于 `ResourceHandle::create(...)`（curl 后端已删，`ResourceLoader.cpp:279`）。故自定义 `LoaderStrategy` **不能靠 `resourceLoader->start()` 触网**。做法：创建 `SubresourceLoader` 后，**自己用 `CurlRequest` 驱动**，从 `CurlRequestClient` 回调里泵 `ResourceLoader` 的**公开**虚函数（`didReceiveResponse`→`didReceiveData/didReceiveBuffer`→`didFinishLoading`/`didFail`）。
- `data:` URL：`ResourceLoader::start()` 内部走 `loadDataURL()` 短路（`ResourceLoader.cpp:254-257`），可直接 `start()`。
- 便捷助手：`ResourceLoader::deliverResponseAndData(ResourceResponse&&, RefPtr<FragmentedSharedBuffer>&&)`（`ResourceLoader.h:78`，缓冲式一把梭）。

## 1. 资源加载入口缝
`CachedResource::load()` → `loaderStrategy()->loadResource(frame, resource, request, options, completionHandler)`（`CachedResource.cpp:275`）。
- 纯虚：`LoaderStrategy.h:64` `virtual void loadResource(LocalFrame&, CachedResource&, ResourceRequest&&, const ResourceLoaderOptions&, CompletionHandler<void(RefPtr<SubresourceLoader>&&)>&&) = 0;`
- 单进程蓝本 `WebResourceLoadScheduler::loadResource`（`WebResourceLoadScheduler.cpp:95`）：
  `SubresourceLoader::create(frame, resource, WTF::move(request), options, [完成回调里] { if(loader) scheduleLoad(loader.get()); completionHandler(WTF::move(loader)); });`
- `scheduleLoad`（`:137`）最终调 `resourceLoader->start()`（`:292` servePendingRequests）——**这一步换成起 CurlRequest**。
- `SubresourceLoader::create`（`SubresourceLoader.cpp:145`）→ `init`（`:186`）→ `ResourceLoader::init`（`ResourceLoader.cpp:137`，只校验 documentLoader/frame，**不触网**，回调 `completionHandler(bool)`）。

## 2. 要泵的 ResourceLoader 公开虚函数（`ResourceLoader.h`）
- `:118` `willSendRequest(ResourceRequest&&, const ResourceResponse& redirectResponse, CompletionHandler<void(ResourceRequest&&)>&&)` ★重定向
- `:120` `didReceiveResponse(ResourceResponse&&, CompletionHandler<void()>&& policyCompletionHandler)` ★**必须调 completion 才继续**（策略门；对应 curl 的 `completeDidReceiveResponse`）
- `:122` `didReceiveBuffer(const FragmentedSharedBuffer&, long long encodedDataLength, DataPayloadType)` ★（curl 给 `Ref<SharedBuffer>`，首选这个）
- `:121` `didReceiveData(const SharedBuffer&, long long encodedDataLength, DataPayloadType)` ★
- `:123` `didFinishLoading(const NetworkLoadMetrics&)` ★
- `:124` `didFail(const ResourceError&)` ★
- `DataPayloadType`：`DataPayloadWholeResource` / `DataPayloadBytes`。
- `cancel()` / `cancel(const ResourceError&, ...)`。

## 3. CurlRequest 驱动 API（`CurlRequest.h`）
- 工厂 `:56` `static Ref<CurlRequest> create(const ResourceRequest&, CurlRequestClient&, CaptureNetworkLoadMetrics = CaptureNetworkLoadMetrics::Basic)`
- **启动 = `resume()`**（`:70`）：创建即挂起，`resume()` 才起（`file:` 走 invokeDidReceiveResponseForFile，否则丢给 curl worker 线程 job manager）。
- `:82` `completeDidReceiveResponse()`——RESUME 握手，在 loader 接受响应后调。
- `:63` `invalidateClient()`（丢弃前置空 client 指针）；`:71` `cancel()`。
- `:65` `setUserPass(const String&, const String&)`；`:67` `disableServerTrustEvaluation()`（headless 可在创建时调，跳过证书校验）。
- 类型：`ThreadSafeRefCounted<CurlRequest>`，用 `Ref/RefPtr` 持有。

### CurlRequestClient 5 个纯虚（`CurlRequestClient.h:40`，派生 AbstractRefCounted → 实现类须 RefCounted）
```cpp
virtual void curlDidSendData(CurlRequest&, unsigned long long bytesSent, unsigned long long totalBytesToBeSent) = 0;
virtual void curlDidReceiveResponse(CurlRequest&, CurlResponse&&) = 0;
virtual void curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&&) = 0;
virtual void curlDidComplete(CurlRequest&, NetworkLoadMetrics&&) = 0;
virtual void curlDidFailWithError(CurlRequest&, ResourceError&&, CertificateInfo&&) = 0;
```

## 4. NetworkDataTaskCurl 蓝本机制（`NetworkProcess/curl/NetworkDataTaskCurl.cpp`，只取 client+cookie+redirect，丢 Download/NetworkProcess 分支）
- `createCurlRequest`（`:134`）：先 `appendCookieHeader`（读 cookie）再 `CurlRequest::create(request, *this, ...)`；挂起态，`resume()` 起。
- `curlDidReceiveResponse`（`:159`）：建 `m_response`；`handleCookieHeaders`（写 cookie）；3xx→`willPerformHTTPRedirection`；401/407→auth；否则 `invokeDidReceiveResponse`。
- `invokeDidReceiveResponse`（`:296`）：`didReceiveResponse(resp, [curlRequest]{ curlRequest->completeDidReceiveResponse(); })`。**你的 loader 版照此。**
- `curlDidReceiveData`（`:191`）→ `loader->didReceiveBuffer(buffer, size, DataPayloadBytes)`。
- `curlDidComplete`（`:217`）→ `loader->didFinishLoading(metrics)`。
- `curlDidFailWithError`（`:235`）：证书错→server-trust；否则 `loader->didFail(error)`。
- `willPerformHTTPRedirection`（`:334`）：≤20 跳；按 `shouldRedirectAsGET` 改方法；剥跨源 auth/origin 头；重估 cookie；**cancel 旧 CurlRequest，对新目标建新的并 resume**。SubresourceLoader 版走 `willSendRequest(newReq, redirectResp, callback)`，在 callback 里 cancel+重建。
- 读 cookie `appendCookieHeader`（`:542`）：`storageSession->cookieRequestHeaderFieldValue(firstPartyForCookies, SameSiteInfo::create(request), url, std::nullopt, std::nullopt, includeSecureCookies, ApplyTrackingPrevention::Yes, ShouldRelaxThirdPartyCookieBlocking::No, IsKnownCrossSiteTracker::No).first` → 设 `HTTPHeaderName::Cookie`。
- 写 cookie `handleCookieHeaders`（`:552`）：扫响应头 `set-cookie:` → `storageSession->setCookiesFromHTTPResponse(request.firstPartyForCookies(), response.url, setCookieString)`。
- TLS：`error.isCertificationVerificationError()`（`:240`）→ headless 可 `disableServerTrustEvaluation()` 或自动接受。

## 5. ephemeral 会话 + cookie
- 唯一 curl 构造：`NetworkStorageSession.h:187` `NetworkStorageSession(PAL::SessionID, const String& alternativeServicesDirectory = nullString())`。
- 实现 `NetworkStorageSessionCurl.cpp:90`：`m_cookieDatabase(makeUniqueRef<CookieJarDB>(sessionID.isEphemeral() ? ":memory:"_s : defaultCookieJarPath()))`。**ephemeral SessionID 自动给 `:memory:` cookie 库，不落盘。**
- 构造：`NetworkStorageSession(PAL::SessionID::generateEphemeralSessionID())`。`cookieDatabase()` 首用惰性 open。
- `CookieJar::create`（`CookieJar.h:54`）：`static Ref<CookieJar> create(Ref<StorageSessionProvider>&&)`。须给 `StorageSessionProvider` 子类返回你的 `NetworkStorageSession*`。**`NetworkingContext` 本身派生 `StorageSessionProvider`（`NetworkingContext.h:45`），故 context 可兼任 provider。**

## 6. FrameNetworkingContext
- `NetworkingContext.h:45` 相关纯虚（USE(CURL)/PLATFORM(WIN)）：
  - `:51` `virtual bool shouldClearReferrerOnHTTPSToHTTPRedirect() const = 0;`（`FrameNetworkingContext` 已实现，`:36`）
  - `:63`(WIN) `virtual ResourceError blockedError(const ResourceRequest&) const = 0;`（**须实现**）
  - Cocoa-only 纯虚在 `#if PLATFORM(COCOA)`，Windows 不需要。
- `FrameNetworkingContext`（`FrameNetworkingContext.h:29`）已实现 shouldClearReferrer + isValid，持 `WeakPtr<LocalFrame>`。`ShotNetworkingContext : FrameNetworkingContext` 只需：`blockedError`（WIN）+ storage-session hook（返回你的 `NetworkStorageSession*`）+ `static create(LocalFrame*)`。
- 注意：`FrameNetworkingContext.h` include `Document.h`/`LocalFrameInlines.h`，须在能见完整 `LocalFrame` 的 TU 编译。

## 7. PlatformStrategies（`PlatformStrategies.h`）
- 纯虚工厂：`:56 createLoaderStrategy()` / `:57 createPasteboardStrategy()` / `:58 createMediaStrategy()` / `:59 createBlobRegistry()`。
- 访问器返 checked：`CheckedPtr<LoaderStrategy> loaderStrategy()`（`:43`）等。
- **BlobRegistry**：`BlobRegistryImpl` **不**继承 `BlobRegistry`（是独立具体类，`BlobRegistryImpl.h:53`）。`createBlobRegistry()` 不能直接返回它。须写小适配器 `class ... : public BlobRegistry`，内含 `BlobRegistryImpl m_blobRegistry;`，转发全部纯虚（registerInternalFileBlobURL/registerInternalBlobURL/registerBlobURL/registerInternalBlobURLOptionallyFileBacked/registerInternalBlobURLForSlice/unregisterBlobURL/registerBlobURLHandle/unregisterBlobURLHandle/blobType/blobSize/writeBlobsToTemporaryFilesForIndexedDB），并 override `blobRegistryImpl()` 返 `&m_blobRegistry`。抄 `Source/WebKitLegacy` 的 `WebBlobRegistry`。M2 若不用 blob: 可暂返 nullptr。

## 装配顺序
1. `ShotPlatformStrategies`：createLoaderStrategy→ShotLoadScheduler；createBlobRegistry→BlobRegistry 适配器（暂可 nullptr）；media/pasteboard 最小桩。
2. `ShotLoadScheduler : LoaderStrategy`：近乎照抄 WebResourceLoadScheduler，但 serve 路径用 `resourceLoader->start()` 换成：建 `ShotResourceHandle`(CurlRequestClient) 绑该 loader，`CurlRequest::create(loader->request(), handle)`，`resume()`。
3. `ShotResourceHandle : RefCounted<...>, CurlRequestClient`：实现 5 回调，转发 loader 公开虚函数，守 `completeDidReceiveResponse()` 握手，cookie 读写走 ephemeral `NetworkStorageSession`。
4. `ShotNetworkingContext : FrameNetworkingContext`：实现 `blockedError`(WIN) + storage-session hook。
5. 一个 ephemeral `NetworkStorageSession(PAL::SessionID::generateEphemeralSessionID())` → 自动 `:memory:` cookie 库。

## 主资源（shot_render_url）走法
不走 `FrameLoader::load` 导航（避开 EmptyFrameLoaderClient 的 final 坏策略方法）。用**独立** `CurlRequest` + 一个缓冲式 `CurlRequestClient` 抓 URL 全字节（跟随重定向、取最终 URL 作 base）→ 喂 `DocumentWriter`（M1 已跑通路径）。子资源经 LoaderStrategy 自动加载。仅 iframe 仍需真 FrameLoaderClient（后置）。
