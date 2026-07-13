/*
 * shotcli — libshot C ABI 的薄命令行封装。
 *
 *   shotcli (--html <file> | --stdin | --url <url>) --out <image>
 *           [--width W] [--height H] [--scale S] [--full-page]
 *           [--format png|webp|webp-lossless] [--quality 0..100]
 *           [--mime-type TYPE] [--timeout MS] [--base-url URL] [--ua STRING]
 *
 * 见仓库根 AGENTS.md。
 */

#include "shot.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

static void usage()
{
    std::fprintf(stderr,
        "usage: shotcli (--html <file> | --stdin | --url <url>) --out <image>\n"
        "               [--width W] [--height H] [--scale S] [--full-page]\n"
        "               [--format png|webp|webp-lossless] [--quality 0..100]\n"
        "               [--mime-type TYPE] [--timeout MS] [--base-url URL]\n"
        "               [--ua STRING] [--allow-file-urls]\n");
}

int main(int argc, char** argv)
{
    std::string htmlPath;
    std::string urlArg;
    std::string outPath;
    std::string baseURLStore;
    std::string uaStore;
    std::string mimeTypeStore;
    bool useStdin = false;

    shot_render_options options;
    shot_render_options_default(&options);

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        auto next = [&](const char* name) -> std::string {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "error: %s needs a value\n", name);
                std::exit(2);
            }
            return argv[++i];
        };
        if (arg == "--html")
            htmlPath = next("--html");
        else if (arg == "--url")
            urlArg = next("--url");
        else if (arg == "--stdin")
            useStdin = true;
        else if (arg == "--out")
            outPath = next("--out");
        else if (arg == "--width")
            options.width = std::stoi(next("--width"));
        else if (arg == "--height")
            options.height = std::stoi(next("--height"));
        else if (arg == "--scale")
            options.device_scale = std::stod(next("--scale"));
        else if (arg == "--full-page")
            options.full_page = 1;
        else if (arg == "--timeout")
            options.timeout_ms = std::stoi(next("--timeout"));
        else if (arg == "--format") {
            auto format = next("--format");
            if (format == "png")
                options.output_format = SHOT_FORMAT_PNG;
            else if (format == "webp")
                options.output_format = SHOT_FORMAT_WEBP;
            else if (format == "webp-lossless")
                options.output_format = SHOT_FORMAT_WEBP_LOSSLESS;
            else {
                std::fprintf(stderr, "error: unsupported format %s\n", format.c_str());
                return 2;
            }
        } else if (arg == "--quality") {
            auto quality = std::stod(next("--quality"));
            if (quality < 0 || quality > 100) {
                std::fprintf(stderr, "error: --quality must be between 0 and 100\n");
                return 2;
            }
            options.output_quality = quality / 100.0;
        } else if (arg == "--mime-type") {
            mimeTypeStore = next("--mime-type");
            options.input_mime_type = mimeTypeStore.c_str();
        }
        else if (arg == "--base-url") {
            baseURLStore = next("--base-url");
            options.base_url = baseURLStore.c_str();
        } else if (arg == "--ua") {
            uaStore = next("--ua");
            options.user_agent = uaStore.c_str();
        } else if (arg == "--allow-file-urls")
            options.allow_file_urls = 1;
        else if (arg == "--help" || arg == "-h") {
            usage();
            return 0;
        } else {
            std::fprintf(stderr, "error: unknown argument %s\n", arg.c_str());
            usage();
            return 2;
        }
    }

    bool useURL = !urlArg.empty();
    if (outPath.empty() || (htmlPath.empty() && !useStdin && !useURL)) {
        usage();
        return 2;
    }

    std::vector<char> html;
    if (!useURL) {
        if (useStdin)
            html.assign(std::istreambuf_iterator<char>(std::cin), std::istreambuf_iterator<char>());
        else {
            std::ifstream in(htmlPath, std::ios::binary);
            if (!in) {
                std::fprintf(stderr, "error: cannot open %s\n", htmlPath.c_str());
                return 1;
            }
            html.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
        }
    }

    if (shot_init(nullptr) != SHOT_OK) {
        std::fprintf(stderr, "error: shot_init failed\n");
        return 1;
    }

    shot_renderer* renderer = shot_renderer_create();
    shot_image image = { nullptr, 0 };
    shot_status status = useURL
        ? shot_render_url(renderer, urlArg.c_str(), &options, &image)
        : shot_render_html(renderer, html.data(), html.size(), &options, &image);

    if (status != SHOT_OK) {
        std::fprintf(stderr, "error: render failed (status %d): %s\n", status, shot_last_error(renderer));
        return status;
    }

    {
        std::ofstream out(outPath, std::ios::binary);
        if (!out) {
            std::fprintf(stderr, "error: cannot write %s\n", outPath.c_str());
            return 1;
        }
        out.write(reinterpret_cast<const char*>(image.data), image.size);
        out.flush();
    }
    std::fprintf(stderr, "wrote %s (%zu bytes)\n", outPath.c_str(), image.size);
    shot_image_free(&image);

    // WebCore 线程级单例设计为进程退出时泄漏，正常退出会在静态析构中崩溃。截图已落盘，
    // 直接硬退出跳过一切静态析构/atexit（CLI 一次性场景专用；库形态见 shot_shutdown 注释）。
    std::fflush(nullptr);
    std::_Exit(0);
}
