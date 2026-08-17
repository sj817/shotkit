/* C ABI ownership regression: init/render stay on one thread; image free does not. */

#include "shot.h"

#include <condition_variable>
#include <cstdio>
#include <mutex>
#include <thread>

int main()
{
    std::mutex mutex;
    std::condition_variable condition;
    shot_renderer* renderer = nullptr;
    shot_image image { nullptr, 0 };
    bool ready = false;
    bool released = false;
    int workerResult = 0;

    std::thread owner([&] {
        auto fail = [&](int code) {
            {
                std::lock_guard lock(mutex);
                workerResult = code;
            }
            condition.notify_one();
        };
        if (shot_init(nullptr) != SHOT_OK || shot_init(nullptr) != SHOT_OK) {
            fail(1);
            return;
        }
        renderer = shot_renderer_create();
        if (!renderer) {
            fail(2);
            return;
        }
        shot_render_options options;
        shot_render_options_default(&options);
        options.width = 160;
        options.height = 90;
        static constexpr char html[] = "<!doctype html><body style='margin:0;background:#36c'>thread</body>";
        if (shot_render_html(renderer, html, sizeof(html) - 1, &options, &image) != SHOT_OK) {
            shot_renderer_destroy(renderer);
            renderer = nullptr;
            fail(3);
            return;
        }
        {
            std::lock_guard lock(mutex);
            ready = true;
        }
        condition.notify_one();
        {
            std::unique_lock lock(mutex);
            condition.wait(lock, [&] { return released; });
        }
        for (int iteration = 1; iteration < 1000; ++iteration) {
            shot_image repeated { nullptr, 0 };
            if (shot_render_html(renderer, html, sizeof(html) - 1, &options, &repeated) != SHOT_OK) {
                workerResult = 7;
                break;
            }
            shot_image_free(&repeated);
        }
        shot_renderer_destroy(renderer);
    });

    {
        std::unique_lock lock(mutex);
        condition.wait(lock, [&] { return ready || workerResult; });
    }
    if (workerResult) {
        owner.join();
        return workerResult;
    }
    int result = 0;
    if (shot_init(nullptr) != SHOT_ERR_WRONG_THREAD) {
        std::fprintf(stderr, "shot_init did not reject the non-owner thread\n");
        result = 4;
    }
    shot_render_options options;
    shot_render_options_default(&options);
    shot_image forbidden { nullptr, 0 };
    if (!result && shot_render_html(renderer, "x", 1, &options, &forbidden) != SHOT_ERR_WRONG_THREAD) {
        std::fprintf(stderr, "shot_render_html did not reject the non-owner thread\n");
        result = 5;
    }
    shot_image_free(&image);
    if (image.data || image.size) {
        std::fprintf(stderr, "cross-thread shot_image_free did not clear the image\n");
        result = 6;
    }
    {
        std::lock_guard lock(mutex);
        released = true;
    }
    condition.notify_one();
    owner.join();
    return result ? result : workerResult;
}
