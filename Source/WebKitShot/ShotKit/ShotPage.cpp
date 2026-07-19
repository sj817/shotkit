/*
 * ShotPage.cpp — HTML/URL → PNG 渲染核心。
 *
 * 调用链复刻 SVGImage::dataChanged：pageConfigurationWithEmptyClients → Page::create →
 * LocalFrameView → frame->init() → DocumentWriter(begin/addData/end) → 泵 RunLoop 等加载完成 →
 * updateLayout → snapshotFrameRect → encodeData("image/png")。
 * URL 模式：先用平台网络栈抓主资源字节（跟随重定向），再喂 DocumentWriter；
 * 子资源经 ShotLoaderStrategy 自动加载。见 docs/network-integration-map.md 与仓库根 AGENTS.md。
 */

#include "config.h"
#include "ShotPage.h"

#include "ShotLoaderStrategy.h"
#include "ShotSession.h"
#include <chrono>
#include <optional>
#include <thread>
#if USE(CURL)
#include <WebCore/CurlRequest.h>
#include <WebCore/CurlRequestClient.h>
#include <WebCore/CurlResponse.h>
#endif
#include <WebCore/DestinationColorSpace.h>
#include <WebCore/Document.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentLoader.h>
#include <WebCore/DocumentView.h>
#include <WebCore/DocumentWriter.h>
#include <WebCore/EmptyClients.h>
#include <WebCore/FrameLoader.h>
#include <WebCore/FrameSnapshotting.h>
#include <WebCore/HTTPHeaderNames.h>
#include <WebCore/ImageBuffer.h>
#include <WebCore/ImageUtilities.h>
#include <WebCore/IntRect.h>
#include <WebCore/IntSize.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/LocalFrameView.h>
#include <WebCore/NetworkLoadMetrics.h>
#if PLATFORM(COCOA)
#include <WebCore/NetworkStorageSession.h>
#include <WebCore/NetworkingContext.h>
#include <WebCore/ResourceHandle.h>
#include <WebCore/StoredCredentialsPolicy.h>
#endif
#include <WebCore/Page.h>
#include <WebCore/PageConfiguration.h>
#include <WebCore/PixelFormat.h>
#include <WebCore/ResourceError.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/Settings.h>
#include <WebCore/SharedBuffer.h>
#include <pal/SessionID.h>
#include <wtf/MonotonicTime.h>
#include <wtf/Ref.h>
#include <wtf/RefCounted.h>
#include <wtf/RunLoop.h>
#include <wtf/Seconds.h>
#include <wtf/StdLibExtras.h>
#include <wtf/URL.h>

namespace ShotKit {

using namespace WebCore;

// ---- 建 Page + 主 frame（单进程嵌入，全空客户端）----
static Ref<Page> createShotPage(const RenderOptions& options, RefPtr<LocalFrame>& outMainFrame)
{
    auto pageConfiguration = pageConfigurationWithEmptyClients(std::nullopt, PAL::SessionID::defaultSessionID());
    if (auto* mainFrameParameters = std::get_if<PageConfiguration::LocalMainFrameCreationParameters>(&pageConfiguration.mainFrameCreationParameters))
        mainFrameParameters->effectiveSandboxFlags = { };
    Ref<Page> page = Page::create(WTF::move(pageConfiguration));

    page->settings().setScriptEnabled(false);
    page->settings().setAcceleratedCompositingEnabled(false);
    page->settings().setShouldAllowUserInstalledFonts(false);
    page->settings().setLoadsImagesAutomatically(true);
    page->setDeviceScaleFactor(options.deviceScale);

    RefPtr localMainFrame = page->localMainFrame();
    if (!localMainFrame)
        return page;

    localMainFrame->setView(LocalFrameView::create(*localMainFrame));
    localMainFrame->init();

    if (RefPtr view = localMainFrame->view())
        view->resize(options.width, options.height);

    outMainFrame = WTF::move(localMainFrame);
    return page;
}

// ---- 泵 RunLoop 直到加载完成（frame 完成 + 无在途 curl 子资源 + 10ms 收尾窗口）或硬超时 ----
static void pumpUntilLoaded(LocalFrame& frame, const RenderOptions& options)
{
    auto start = MonotonicTime::now();
    Seconds timeout = Seconds::fromMilliseconds(std::max(1, options.timeoutMs));
    // 所有主/子资源都由同步计数约束；只留一个很短的事件收尾窗口，避免每张图固定
    // 浪费 200ms。图片解码在快照绘制时同步完成。
    Seconds quietWindow = Seconds::fromMilliseconds(10);
    std::optional<MonotonicTime> quietStart;
    auto* strategy = activeShotLoaderStrategy();

    while (true) {
        RunLoop::cycle();

        bool pending = strategy && strategy->hasPendingLoads();
        bool idle = frame.loader().isComplete() && !pending;
        auto now = MonotonicTime::now();

        if (idle) {
            if (!quietStart)
                quietStart = now;
            else if (now - *quietStart >= quietWindow)
                return;
        } else
            quietStart = std::nullopt;

        if (now - start >= timeout)
            return; // 硬超时

        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

// ---- 把已备好的文档字节喂进 frame、等加载、截图、编码 PNG ----
static bool writeAndSnapshot(LocalFrame& frame, const URL& baseURL, const String& mimeType, Ref<SharedBuffer>&& data, const RenderOptions& options, WTF::Vector<uint8_t>& outImage)
{
    Ref loader = frame.loader();
    RefPtr activeDocumentLoader = loader->activeDocumentLoader();
    if (!activeDocumentLoader)
        return false;

    auto& writer = activeDocumentLoader->writer();
    writer.setMIMEType(mimeType.isEmpty() ? "text/html"_s : mimeType);
    writer.begin(baseURL);
    writer.addData(data);
    writer.end();

    pumpUntilLoaded(frame, options);

    RefPtr document = frame.document();
    if (!document)
        return false;
#if ENABLE(XSLT)
    if (document->isXMLDocument()) {
        // The XML parser may schedule the zero-delay XSLT application while
        // the document is still marked as parsing. Browser ports get another
        // loader turn after that point; ShotKit's short quiet window can
        // otherwise take the snapshot first. Keep this extra turn off the hot
        // HTML path.
        document->applyPendingXSLTransformsNowIfScheduled();
        pumpUntilLoaded(frame, options);
        document = frame.document();
        if (!document)
            return false;
    }
#endif
    document->updateLayoutIgnorePendingStylesheets();

    RefPtr frameView = frame.view();
    if (!frameView)
        return false;

    IntSize snapshotSize(options.width, options.height);
    if (options.fullPage) {
        IntSize contents = frameView->contentsSize();
        if (!contents.isEmpty()) {
            frameView->resize(options.width, contents.height());
            document->updateLayoutIgnorePendingStylesheets();
            snapshotSize = IntSize(options.width, contents.height());
        }
    }

    SnapshotOptions snapshotOptions {
        { },
        PixelFormat::BGRA8,
        DestinationColorSpace::SRGB()
    };
    RefPtr<ImageBuffer> imageBuffer = snapshotFrameRect(frame, IntRect(IntPoint(), snapshotSize), WTF::move(snapshotOptions));
    if (!imageBuffer)
        return false;

    String outputMIMEType = "image/png"_s;
    std::optional<double> outputQuality;
    switch (options.outputFormat) {
    case OutputFormat::PNG:
        break;
    case OutputFormat::WebPLossy:
        outputMIMEType = "image/webp"_s;
        outputQuality = std::clamp(options.outputQuality, 0.0, 0.99);
        break;
    case OutputFormat::WebPLossless:
        outputMIMEType = "image/webp"_s;
        outputQuality = 1.0;
        break;
    }

    outImage = encodeData(WTF::move(imageBuffer), outputMIMEType, outputQuality);
    return !outImage.isEmpty();
}

bool renderMarkupToImage(std::span<const uint8_t> markup, const RenderOptions& options, WTF::Vector<uint8_t>& outImage)
{
    beginRenderSession();
    RefPtr<LocalFrame> mainFrame;
    Ref<Page> page = createShotPage(options, mainFrame);
    if (!mainFrame)
        return false;

    URL baseURL;
    if (!options.baseURL.isEmpty())
        baseURL = URL(URL(), options.baseURL);

    return writeAndSnapshot(*mainFrame, baseURL, options.inputMIMEType.isEmpty() ? "text/html"_s : options.inputMIMEType, SharedBuffer::create(markup), options, outImage);
}

// ---- 主资源抓取器：Win/Linux 用 CurlRequest；Cocoa 用同步 CFNetwork ----
namespace {

#if USE(CURL)
class ShotURLFetcher final : public WTF::RefCounted<ShotURLFetcher>, public WebCore::CurlRequestClient {
public:
    static Ref<ShotURLFetcher> create(const URL& url) { return adoptRef(*new ShotURLFetcher(url)); }
    ~ShotURLFetcher() { if (m_curlRequest) m_curlRequest->invalidateClient(); }

    void start() { startRequest(ResourceRequest(URL(m_url))); }

    bool isDone() const { return m_done; }
    bool succeeded() const { return m_success; }
    const URL& finalURL() const { return m_finalURL; }
    const String& mimeType() const { return m_mimeType; }
    Ref<SharedBuffer> takeData() { return SharedBuffer::create(m_bytes.span()); }

    void ref() const final { WTF::RefCounted<ShotURLFetcher>::ref(); }
    void deref() const final { WTF::RefCounted<ShotURLFetcher>::deref(); }

private:
    explicit ShotURLFetcher(const URL& url)
        : m_url(url)
        , m_finalURL(url)
    {
    }

    void startRequest(ResourceRequest&& request)
    {
        appendRequestCookies(request);
        m_curlRequest = CurlRequest::create(request, *this);
        m_curlRequest->resume();
    }

    void finish(bool success)
    {
        m_success = success;
        m_done = true;
        if (m_curlRequest) {
            m_curlRequest->invalidateClient();
            m_curlRequest = nullptr;
        }
    }

    void curlDidSendData(CurlRequest&, unsigned long long, unsigned long long) final { }

    void curlDidReceiveResponse(CurlRequest& request, CurlResponse&& received) final
    {
        Ref protectedThis { *this };
        ResourceResponse response(received);
        storeResponseCookies(request.resourceRequest(), received);

        auto code = response.httpStatusCode();
        String location = response.httpHeaderField(HTTPHeaderName::Location);
        bool isRedirect = code >= 300 && code < 400 && code != 304 && code != 305 && code != 306 && !location.isEmpty();
        if (isRedirect) {
            if (++m_redirectCount > 20) {
                finish(false);
                return;
            }
            URL base = response.url();
            URL next(base, location);
            if (next.protocolIsFile()) {
                finish(false);
                return;
            }
            m_finalURL = next;
            if (m_curlRequest) {
                m_curlRequest->invalidateClient();
                m_curlRequest->cancel();
                m_curlRequest = nullptr;
            }
            startRequest(ResourceRequest(WTF::move(next)));
            return;
        }

        // 4xx/5xx 也照常渲染响应体（错误页往往有内容）。
        m_mimeType = response.mimeType();
        m_finalURL = response.url();
        if (m_curlRequest)
            m_curlRequest->completeDidReceiveResponse();
    }

    void curlDidReceiveData(CurlRequest&, Ref<SharedBuffer>&& buffer) final
    {
        Ref protectedThis { *this };
        auto contiguous = buffer->makeContiguous();
        m_bytes.append(contiguous->span());
    }

    void curlDidComplete(CurlRequest&, NetworkLoadMetrics&&) final
    {
        Ref protectedThis { *this };
        finish(true);
    }

    void curlDidFailWithError(CurlRequest&, ResourceError&&, CertificateInfo&&) final
    {
        Ref protectedThis { *this };
        finish(false);
    }

    URL m_url;
    URL m_finalURL;
    String m_mimeType;
    WTF::Vector<uint8_t> m_bytes;
    RefPtr<CurlRequest> m_curlRequest;
    unsigned m_redirectCount { 0 };
    bool m_done { false };
    bool m_success { false };
};
#endif

#if PLATFORM(COCOA)
class ShotSynchronousNetworkingContext final : public NetworkingContext {
public:
    static Ref<ShotSynchronousNetworkingContext> create() { return adoptRef(*new ShotSynchronousNetworkingContext); }

private:
    bool shouldClearReferrerOnHTTPSToHTTPRedirect() const final { return true; }
    NetworkStorageSession* storageSession() const final { return activeNetworkStorageSession(); }
    bool localFileContentSniffingEnabled() const final { return false; }
    RetainPtr<CFDataRef> sourceApplicationAuditData() const final { return nullptr; }
    ResourceError blockedError(const ResourceRequest& request) const final { return ResourceError("ShotKit"_s, 0, request.url(), "blocked"_s); }
};
#endif

} // anonymous namespace

bool renderURLToImage(const WTF::String& urlString, const RenderOptions& options, WTF::Vector<uint8_t>& outImage)
{
    beginRenderSession();
    URL url(URL(), urlString);
    if (!url.isValid())
        return false;
    if (url.protocolIsFile() && !options.allowFileURLs)
        return false;

    // 抓主资源。
#if PLATFORM(COCOA)
    ResourceRequest request(URL { url });
    request.setTimeoutInterval(std::max(0.001, options.timeoutMs / 1000.0));
    ResourceError error;
    ResourceResponse response;
    Vector<uint8_t> bytes;
    Ref context = ShotSynchronousNetworkingContext::create();
    ResourceHandle::loadResourceSynchronously(context.ptr(), request, StoredCredentialsPolicy::Use, nullptr, error, response, bytes);
    if (!error.isNull())
        return false;

    RefPtr<LocalFrame> mainFrame;
    Ref<Page> page = createShotPage(options, mainFrame);
    if (!mainFrame)
        return false;

    URL finalURL = response.url().isValid() ? response.url() : url;
    return writeAndSnapshot(*mainFrame, finalURL, response.mimeType(), SharedBuffer::create(bytes.span()), options, outImage);
#else
    Ref<ShotURLFetcher> fetcher = ShotURLFetcher::create(url);
    fetcher->start();

    auto start = MonotonicTime::now();
    Seconds timeout = Seconds::fromMilliseconds(std::max(1, options.timeoutMs));
    while (!fetcher->isDone()) {
        RunLoop::cycle();
        if (MonotonicTime::now() - start >= timeout) {
            fetcher = ShotURLFetcher::create(url); // 放弃（原 fetcher 仍会自行了结）
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (!fetcher->succeeded())
        return false;

    RefPtr<LocalFrame> mainFrame;
    Ref<Page> page = createShotPage(options, mainFrame);
    if (!mainFrame)
        return false;

    return writeAndSnapshot(*mainFrame, fetcher->finalURL(), fetcher->mimeType(), fetcher->takeData(), options, outImage);
#endif
}

} // namespace ShotKit
