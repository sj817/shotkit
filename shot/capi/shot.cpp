/*
 * shot.cpp — C ABI 实现，薄封装 ShotKit 内核。见 shot.h。
 */

#include "config.h"
#include "shot.h"

#include "ShotGlobal.h"
#include "ShotPage.h"
#include <mutex>
#include <span>
#include <string>
#include <thread>
#include <utility>
#include <wtf/AutodrainedPool.h>
#include <wtf/FastMalloc.h>
#include <wtf/Vector.h>
#include <wtf/text/WTFString.h>

struct shot_renderer {
    std::string lastError;
};

static std::mutex s_initMutex;
static std::thread::id s_ownerThread;

static bool isOwnerThread()
{
    std::lock_guard lock(s_initMutex);
    return s_ownerThread != std::thread::id { } && s_ownerThread == std::this_thread::get_id();
}

static ShotKit::RenderOptions convertOptions(const shot_render_options* o)
{
    ShotKit::RenderOptions r;
    if (!o)
        return r;
    if (o->width > 0)
        r.width = o->width;
    if (o->height > 0)
        r.height = o->height;
    if (o->device_scale > 0)
        r.deviceScale = o->device_scale;
    r.fullPage = o->full_page != 0;
    if (o->timeout_ms > 0)
        r.timeoutMs = o->timeout_ms;
    r.bestEffortOnTimeout = o->best_effort_on_timeout != 0;
    r.allowFileURLs = o->allow_file_urls != 0;
    r.backgroundRGBA = o->background_rgba;
    if (o->base_url)
        r.baseURL = WTF::String::fromUTF8(o->base_url);
    if (o->input_mime_type)
        r.inputMIMEType = WTF::String::fromUTF8(o->input_mime_type);
    if (o->user_agent)
        r.userAgent = WTF::String::fromUTF8(o->user_agent);
    if (o->selector)
        r.selector = WTF::String::fromUTF8(o->selector);
    switch (o->output_format) {
    case SHOT_FORMAT_WEBP:
        r.outputFormat = ShotKit::OutputFormat::WebPLossy;
        break;
    case SHOT_FORMAT_WEBP_LOSSLESS:
        r.outputFormat = ShotKit::OutputFormat::WebPLossless;
        break;
    case SHOT_FORMAT_PNG:
    default:
        r.outputFormat = ShotKit::OutputFormat::PNG;
        break;
    }
    if (o->output_quality >= 0.0 && o->output_quality <= 1.0)
        r.outputQuality = o->output_quality;
    return r;
}

// 内核只有 selector 路径会填 detail；其余失败仍是笼统的 "render failed"，状态码也维持原样，
// 免得既有调用方的错误分支被这次改动挪位置。
static shot_status reportFailure(shot_renderer* r, const WTF::String& detail)
{
    if (r)
        r->lastError = detail.isEmpty() ? "render failed" : detail.utf8().data();
    return detail.isEmpty() ? SHOT_ERR_RENDER_FAILED : SHOT_ERR_SELECTOR_NOT_FOUND;
}

static shot_status emitImage(WTF::Vector<uint8_t>&& image, shot_image* out)
{
    if (image.isEmpty())
        return SHOT_ERR_RENDER_FAILED;
    auto buffer = image.releaseBuffer();
    auto span = buffer.leakSpan();
    out->data = span.data();
    out->size = span.size();
    return SHOT_OK;
}

extern "C" {

shot_status shot_init(const shot_init_options*)
{
    std::lock_guard lock(s_initMutex);
    auto currentThread = std::this_thread::get_id();
    if (s_ownerThread != std::thread::id { })
        return s_ownerThread == currentThread ? SHOT_OK : SHOT_ERR_WRONG_THREAD;

    AutodrainedPool pool;
    if (!ShotKit::initialize())
        return SHOT_ERR_INIT_FAILED;
    s_ownerThread = currentThread;
    return SHOT_OK;
}

void shot_shutdown(void)
{
    // 与 WebCore worker 相同，必须在 owner 线程仍存活且 renderer 已销毁时
    // 先清理 ThreadGlobalData；否则 pthread/FLS 析构 FontCache 时会重入已处于
    // teardown 的 threadGlobalData。
    if (isOwnerThread())
        ShotKit::shutdownThread();
}

void shot_render_options_default(shot_render_options* o)
{
    if (!o)
        return;
    o->width = 1280;
    o->height = 800;
    o->device_scale = 1.0;
    o->full_page = 0;
    o->timeout_ms = 30000;
    o->best_effort_on_timeout = 1;
    o->user_agent = nullptr;
    o->base_url = nullptr;
    o->input_mime_type = "text/html";
    o->allow_file_urls = 0;
    o->background_rgba = 0xFFFFFFFFu;
    o->output_format = SHOT_FORMAT_PNG;
    o->output_quality = 0.8;
    o->selector = nullptr;
}

shot_renderer* shot_renderer_create(void)
{
    if (!isOwnerThread())
        return nullptr;
    return new shot_renderer();
}

void shot_renderer_destroy(shot_renderer* r)
{
    if (!isOwnerThread())
        return;
    delete r;
}

shot_status shot_render_html(shot_renderer* r, const char* html, size_t len, const shot_render_options* o, shot_image* out)
{
    if (!isOwnerThread())
        return SHOT_ERR_WRONG_THREAD;
    if (!out || (!html && len))
        return SHOT_ERR_INVALID_ARG;
    AutodrainedPool pool;
    out->data = nullptr;
    out->size = 0;
    WTF::Vector<uint8_t> image;
    auto opts = convertOptions(o);
    WTF::String renderError;
    if (!ShotKit::renderMarkupToImage(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(html), len), opts, image, &renderError))
        return reportFailure(r, renderError);
    return emitImage(std::move(image), out);
}

shot_status shot_render_url(shot_renderer* r, const char* url, const shot_render_options* o, shot_image* out)
{
    if (!isOwnerThread())
        return SHOT_ERR_WRONG_THREAD;
    if (!out || !url)
        return SHOT_ERR_INVALID_ARG;
    AutodrainedPool pool;
    out->data = nullptr;
    out->size = 0;
    WTF::Vector<uint8_t> image;
    auto opts = convertOptions(o);
    WTF::String renderError;
    if (!ShotKit::renderURLToImage(WTF::String::fromUTF8(url), opts, image, &renderError))
        return reportFailure(r, renderError);
    return emitImage(std::move(image), out);
}

void shot_image_free(shot_image* p)
{
    if (p && p->data) {
        WTF::fastFree(p->data);
        p->data = nullptr;
        p->size = 0;
    }
}

void shot_png_free(shot_png* p)
{
    shot_image_free(p);
}

const char* shot_last_error(shot_renderer* r)
{
    return r && isOwnerThread() ? r->lastError.c_str() : "";
}

} // extern "C"
