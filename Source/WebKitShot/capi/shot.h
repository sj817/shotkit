/*
 * shot.h — ShotKit C ABI（libshot 导出的唯一表面）。
 *
 * 线程模型：shot_init 把当前线程绑定为主线程，此后所有调用须同线程。
 * 见仓库根 CLAUDE.md 第 6 节。
 */

#ifndef SHOTKIT_SHOT_H
#define SHOTKIT_SHOT_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#  ifdef BUILDING_LIBSHOT
#    define SHOT_API __declspec(dllexport)
#  else
#    define SHOT_API __declspec(dllimport)
#  endif
#else
#  define SHOT_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    SHOT_OK = 0,
    SHOT_ERR_INIT_FAILED = 1,
    SHOT_ERR_WRONG_THREAD = 2,
    SHOT_ERR_INVALID_ARG = 3,
    SHOT_ERR_NAVIGATION_FAILED = 4,   /* DNS/TLS/HTTP 抓取失败 */
    SHOT_ERR_TIMEOUT = 5,
    SHOT_ERR_RENDER_FAILED = 6,
    SHOT_ERR_FILE_ACCESS_DENIED = 7,
} shot_status;

typedef struct shot_renderer shot_renderer;  /* 不透明，非线程安全 */

typedef struct {
    const char* ca_bundle_path;   /* NULL=平台默认 */
    const char* extra_font_dir;   /* 可选私有字体目录（暂未接线） */
} shot_init_options;

typedef struct {
    int width;                    /* 视口 CSS px，<=0 用默认 1280 */
    int height;                   /* 默认 800 */
    double device_scale;          /* dpr，<=0 用 1.0 */
    int full_page;                /* 1=按 contentsSize 全页 */
    int timeout_ms;               /* <=0 用 30000 */
    int best_effort_on_timeout;   /* 超时仍尽力出图 */
    const char* user_agent;       /* NULL=默认 */
    const char* base_url;         /* 仅 HTML 模式：解析外链子资源 */
    int allow_file_urls;          /* 是否允许 file:// */
    uint32_t background_rgba;     /* 0=透明（暂未接线，页面自带背景优先） */
} shot_render_options;

typedef struct { uint8_t* data; size_t size; } shot_png;

/* 进程内仅一次；绑定当前线程为主线程。 */
SHOT_API shot_status shot_init(const shot_init_options*);
SHOT_API void        shot_shutdown(void);

/* 用默认值填充 options（推荐先调用，再改需要的字段）。 */
SHOT_API void        shot_render_options_default(shot_render_options*);

SHOT_API shot_renderer* shot_renderer_create(void);
SHOT_API void           shot_renderer_destroy(shot_renderer*);

SHOT_API shot_status shot_render_html(shot_renderer*, const char* html_utf8, size_t len,
                                      const shot_render_options*, shot_png* out);
SHOT_API shot_status shot_render_url(shot_renderer*, const char* url,
                                     const shot_render_options*, shot_png* out);
SHOT_API void        shot_png_free(shot_png*);
SHOT_API const char* shot_last_error(shot_renderer*);

#ifdef __cplusplus
}
#endif

#endif /* SHOTKIT_SHOT_H */
