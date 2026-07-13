/*
 * shot.cpp — C ABI 实现，薄封装 ShotKit 内核。见 shot.h。
 */

#include "config.h"
#include "shot.h"

#include "ShotGlobal.h"
#include "ShotPage.h"
#include <cstdlib>
#include <cstring>
#include <span>
#include <string>
#include <wtf/Vector.h>
#include <wtf/text/WTFString.h>

struct shot_renderer {
    std::string lastError;
};

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
    if (o->base_url)
        r.baseURL = WTF::String::fromUTF8(o->base_url);
    if (o->user_agent)
        r.userAgent = WTF::String::fromUTF8(o->user_agent);
    return r;
}

static shot_status emitPNG(const WTF::Vector<uint8_t>& png, shot_png* out)
{
    if (png.isEmpty())
        return SHOT_ERR_RENDER_FAILED;
    out->data = static_cast<uint8_t*>(malloc(png.size()));
    if (!out->data)
        return SHOT_ERR_RENDER_FAILED;
    memcpy(out->data, png.span().data(), png.size());
    out->size = png.size();
    return SHOT_OK;
}

extern "C" {

shot_status shot_init(const shot_init_options*)
{
    return ShotKit::initialize() ? SHOT_OK : SHOT_ERR_INIT_FAILED;
}

void shot_shutdown(void)
{
    // WebCore 的线程级单例被设计为进程退出时泄漏，不做静态析构（否则触发字体缓存
    // teardown 崩溃）。库形态下宿主进程继续存活，故此处 no-op。
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
    o->allow_file_urls = 0;
    o->background_rgba = 0xFFFFFFFFu;
}

shot_renderer* shot_renderer_create(void)
{
    return new shot_renderer();
}

void shot_renderer_destroy(shot_renderer* r)
{
    delete r;
}

shot_status shot_render_html(shot_renderer* r, const char* html, size_t len, const shot_render_options* o, shot_png* out)
{
    if (!out || (!html && len))
        return SHOT_ERR_INVALID_ARG;
    out->data = nullptr;
    out->size = 0;
    WTF::Vector<uint8_t> png;
    auto opts = convertOptions(o);
    if (!ShotKit::renderHTMLToPNG(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(html), len), opts, png)) {
        if (r)
            r->lastError = "render failed";
        return SHOT_ERR_RENDER_FAILED;
    }
    return emitPNG(png, out);
}

shot_status shot_render_url(shot_renderer* r, const char* url, const shot_render_options* o, shot_png* out)
{
    if (!out || !url)
        return SHOT_ERR_INVALID_ARG;
    out->data = nullptr;
    out->size = 0;
    WTF::Vector<uint8_t> png;
    auto opts = convertOptions(o);
    if (!ShotKit::renderURLToPNG(WTF::String::fromUTF8(url), opts, png)) {
        if (r)
            r->lastError = "render failed";
        return SHOT_ERR_RENDER_FAILED;
    }
    return emitPNG(png, out);
}

void shot_png_free(shot_png* p)
{
    if (p && p->data) {
        free(p->data);
        p->data = nullptr;
        p->size = 0;
    }
}

const char* shot_last_error(shot_renderer* r)
{
    return r ? r->lastError.c_str() : "";
}

} // extern "C"
