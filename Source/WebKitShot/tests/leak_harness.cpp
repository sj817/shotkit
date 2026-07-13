/*
 * leak_harness — 在单进程内反复调用 shot_render_html，观察 RSS 是否平稳。
 *
 * AGENTS.md M5 鲁棒性/泄漏验收：重复 render 1000 次，RSS 平稳即通过。
 * shotcli 每次渲染后 _Exit(0)，无法在进程内跨渲染验证泄漏，故用此独立 harness。
 *
 * 构建（build 完成后，链接 libshot 导入库）：
 *   clang-cl /std:c++20 /MD /O2 leak_harness.cpp ^
 *     /I ..\capi /link ..\..\..\..\WebKitBuild\shot\lib\shot.lib
 * 运行时需 shot.dll 在 PATH 或同目录。
 */

#include "shot.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <windows.h>
#include <psapi.h>

static size_t rssBytes()
{
    PROCESS_MEMORY_COUNTERS pmc {};
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)))
        return pmc.WorkingSetSize;
    return 0;
}

int main(int argc, char** argv)
{
    int iterations = argc > 1 ? std::atoi(argv[1]) : 1000;

    static const char kHTML[] =
        "<!DOCTYPE html><html><head><style>"
        "body{margin:0;background:linear-gradient(#123,#4ab);font-family:sans-serif}"
        ".c{width:400px;margin:40px auto;padding:24px;border-radius:12px;background:#fff;color:#123}"
        "</style></head><body><div class=c><h1>soak</h1>"
        "<p>The quick brown fox jumps over the lazy dog. 中文 العربية.</p>"
        "<svg width=80 height=80><circle cx=40 cy=40 r=36 fill=tomato/></svg>"
        "</div></body></html>";

    if (shot_init(nullptr) != SHOT_OK) {
        std::fprintf(stderr, "shot_init failed\n");
        return 1;
    }
    shot_renderer* r = shot_renderer_create();

    shot_render_options opt;
    shot_render_options_default(&opt);
    opt.width = 480;
    opt.height = 320;
    opt.timeout_ms = 5000;

    size_t rssBaseline = 0, rssPeak = 0;
    for (int i = 0; i < iterations; ++i) {
        shot_png png { nullptr, 0 };
        shot_status s = shot_render_html(r, kHTML, sizeof(kHTML) - 1, &opt, &png);
        if (s != SHOT_OK) {
            std::fprintf(stderr, "iter %d: render failed status=%d\n", i, s);
            return 2;
        }
        if (!png.data || png.size < 8 || png.data[0] != 0x89 || png.data[1] != 'P') {
            std::fprintf(stderr, "iter %d: not a PNG (size=%zu)\n", i, png.size);
            return 3;
        }
        shot_png_free(&png);

        if (i == 20)  // 预热后取基线（前几次含一次性缓存分配）
            rssBaseline = rssBytes();
        size_t now = rssBytes();
        if (now > rssPeak)
            rssPeak = now;
        if ((i + 1) % 100 == 0)
            std::printf("iter %4d  RSS %6.1f MB\n", i + 1, now / 1048576.0);
    }

    double growthMB = (rssPeak > rssBaseline ? rssPeak - rssBaseline : 0) / 1048576.0;
    std::printf("baseline(@20) %.1f MB  peak %.1f MB  growth %.1f MB over %d iters\n",
        rssBaseline / 1048576.0, rssPeak / 1048576.0, growthMB, iterations);
    // 判据：预热后增长应远小于总量（<64MB 视为无明显泄漏；真泄漏会线性爬到数百 MB）。
    bool ok = growthMB < 64.0;
    std::printf("%s\n", ok ? "LEAK CHECK: PASS" : "LEAK CHECK: FAIL (growth too large)");
    std::fflush(nullptr);
    std::_Exit(ok ? 0 : 4);
}
