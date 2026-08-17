/* C ABI ownership regression: init/render stay on one thread; image free does not. */

#include "shot.h"

#include <condition_variable>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <thread>

#if !defined(_WIN32)
#include <execinfo.h>
#include <unistd.h>

static void printCrashBacktrace(int signal)
{
    static constexpr char message[] = "capi-thread: fatal signal, backtrace follows\n";
    write(STDERR_FILENO, message, sizeof(message) - 1);
    void* frames[64];
    int count = backtrace(frames, 64);
    backtrace_symbols_fd(frames, count, STDERR_FILENO);
    _Exit(128 + signal);
}
#endif

int main(int argc, char** argv)
{
#if !defined(_WIN32)
    std::signal(SIGABRT, printCrashBacktrace);
    std::signal(SIGSEGV, printCrashBacktrace);
#if defined(SIGTRAP)
    std::signal(SIGTRAP, printCrashBacktrace);
#endif
#endif
    int iterations = argc > 1 ? std::atoi(argv[1]) : 1000;
    if (iterations < 1)
        return 64;
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
        std::fprintf(stderr, "capi-thread: initialized\n");
        renderer = shot_renderer_create();
        if (!renderer) {
            shot_shutdown();
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
            shot_shutdown();
            fail(3);
            return;
        }
        std::fprintf(stderr, "capi-thread: first render complete\n");
        {
            std::lock_guard lock(mutex);
            ready = true;
        }
        condition.notify_one();
        {
            std::unique_lock lock(mutex);
            condition.wait(lock, [&] { return released; });
        }
        for (int iteration = 1; iteration < iterations; ++iteration) {
            shot_image repeated { nullptr, 0 };
            if (shot_render_html(renderer, html, sizeof(html) - 1, &options, &repeated) != SHOT_OK) {
                workerResult = 7;
                break;
            }
            shot_image_free(&repeated);
            if (!((iteration + 1) % 100))
                std::fprintf(stderr, "capi-thread: %d renders complete\n", iteration + 1);
        }
        shot_renderer_destroy(renderer);
        shot_shutdown();
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
    std::fprintf(stderr, "capi-thread: cross-thread checks complete\n");
    {
        std::lock_guard lock(mutex);
        released = true;
    }
    condition.notify_one();
    owner.join();
    return result ? result : workerResult;
}
