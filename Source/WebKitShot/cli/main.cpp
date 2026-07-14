/*
 * shotcli — libshot C ABI 的薄命令行封装。
 *
 *   shotcli (--html <file> | --stdin | --url <url>) --out <image>
 *   shotcli --serve
 *           [--width W] [--height H] [--scale S] [--full-page]
 *           [--format png|webp|webp-lossless] [--quality 0..100]
 *           [--mime-type TYPE] [--timeout MS] [--base-url URL] [--ua STRING]
 *
 * 见仓库根 AGENTS.md。
 */

#include "shot.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace {

struct JSONValue {
    enum class Type { Null, String, Number, Boolean } type { Type::Null };
    std::string string;
    double number { 0 };
    bool boolean { false };
};

class JSONLineParser {
public:
    explicit JSONLineParser(const std::string& input)
        : m_input(input)
    {
    }

    bool parse(std::map<std::string, JSONValue>& result, std::string& error)
    {
        skipWhitespace();
        if (!consume('{'))
            return fail(error, "expected an object");
        skipWhitespace();
        if (consume('}'))
            return finish(error);

        while (m_position < m_input.size()) {
            std::string key;
            if (!parseString(key, error))
                return false;
            skipWhitespace();
            if (!consume(':'))
                return fail(error, "expected ':' after key");
            skipWhitespace();
            JSONValue value;
            if (!parseValue(value, error))
                return false;
            result[std::move(key)] = std::move(value);
            skipWhitespace();
            if (consume('}'))
                return finish(error);
            if (!consume(','))
                return fail(error, "expected ',' or '}'");
            skipWhitespace();
        }
        return fail(error, "unterminated object");
    }

private:
    bool finish(std::string& error)
    {
        skipWhitespace();
        if (m_position != m_input.size())
            return fail(error, "trailing characters after object");
        return true;
    }

    bool parseValue(JSONValue& value, std::string& error)
    {
        if (m_position >= m_input.size())
            return fail(error, "missing value");
        if (m_input[m_position] == '"') {
            value.type = JSONValue::Type::String;
            return parseString(value.string, error);
        }
        if (match("true")) {
            value.type = JSONValue::Type::Boolean;
            value.boolean = true;
            return true;
        }
        if (match("false")) {
            value.type = JSONValue::Type::Boolean;
            return true;
        }
        if (match("null"))
            return true;

        char* end = nullptr;
        const char* start = m_input.c_str() + m_position;
        value.number = std::strtod(start, &end);
        if (end == start || !std::isfinite(value.number))
            return fail(error, "expected string, number, boolean, or null");
        m_position += static_cast<size_t>(end - start);
        value.type = JSONValue::Type::Number;
        return true;
    }

    bool parseString(std::string& output, std::string& error)
    {
        if (!consume('"'))
            return fail(error, "expected a string");
        while (m_position < m_input.size()) {
            unsigned char character = m_input[m_position++];
            if (character == '"')
                return true;
            if (character < 0x20)
                return fail(error, "control character in string");
            if (character != '\\') {
                output.push_back(static_cast<char>(character));
                continue;
            }
            if (m_position >= m_input.size())
                return fail(error, "unterminated escape");
            switch (m_input[m_position++]) {
            case '"': output.push_back('"'); break;
            case '\\': output.push_back('\\'); break;
            case '/': output.push_back('/'); break;
            case 'b': output.push_back('\b'); break;
            case 'f': output.push_back('\f'); break;
            case 'n': output.push_back('\n'); break;
            case 'r': output.push_back('\r'); break;
            case 't': output.push_back('\t'); break;
            default:
                return fail(error, "unsupported string escape (use UTF-8 directly)");
            }
        }
        return fail(error, "unterminated string");
    }

    bool match(std::string_view token)
    {
        if (m_input.compare(m_position, token.size(), token))
            return false;
        m_position += token.size();
        return true;
    }

    bool consume(char character)
    {
        if (m_position >= m_input.size() || m_input[m_position] != character)
            return false;
        ++m_position;
        return true;
    }

    void skipWhitespace()
    {
        while (m_position < m_input.size() && (m_input[m_position] == ' ' || m_input[m_position] == '\t' || m_input[m_position] == '\r' || m_input[m_position] == '\n'))
            ++m_position;
    }

    bool fail(std::string& error, const char* message)
    {
        error = std::string(message) + " at byte " + std::to_string(m_position);
        return false;
    }

    const std::string& m_input;
    size_t m_position { 0 };
};

static std::string jsonQuote(std::string_view input)
{
    std::string output = "\"";
    for (unsigned char character : input) {
        switch (character) {
        case '"': output += "\\\""; break;
        case '\\': output += "\\\\"; break;
        case '\b': output += "\\b"; break;
        case '\f': output += "\\f"; break;
        case '\n': output += "\\n"; break;
        case '\r': output += "\\r"; break;
        case '\t': output += "\\t"; break;
        default:
            if (character < 0x20) {
                char escaped[7];
                std::snprintf(escaped, sizeof(escaped), "\\u%04x", character);
                output += escaped;
            } else
                output.push_back(static_cast<char>(character));
        }
    }
    output.push_back('"');
    return output;
}

static const JSONValue* findValue(const std::map<std::string, JSONValue>& object, const char* key)
{
    auto iterator = object.find(key);
    return iterator == object.end() ? nullptr : &iterator->second;
}

static bool getString(const std::map<std::string, JSONValue>& object, const char* key, std::string& value, bool required, std::string& error)
{
    auto* field = findValue(object, key);
    if (!field) {
        if (required)
            error = std::string("missing string field '") + key + "'";
        return !required;
    }
    if (field->type != JSONValue::Type::String) {
        error = std::string("field '") + key + "' must be a string";
        return false;
    }
    value = field->string;
    return true;
}

static bool applyInteger(const std::map<std::string, JSONValue>& object, const char* key, int& value, std::string& error)
{
    auto* field = findValue(object, key);
    if (!field)
        return true;
    if (field->type != JSONValue::Type::Number || std::floor(field->number) != field->number
        || field->number < std::numeric_limits<int>::min() || field->number > std::numeric_limits<int>::max()) {
        error = std::string("field '") + key + "' must be an integer";
        return false;
    }
    value = static_cast<int>(field->number);
    return true;
}

static bool applyNumber(const std::map<std::string, JSONValue>& object, const char* key, double& value, std::string& error)
{
    auto* field = findValue(object, key);
    if (!field)
        return true;
    if (field->type != JSONValue::Type::Number) {
        error = std::string("field '") + key + "' must be a number";
        return false;
    }
    value = field->number;
    return true;
}

static bool applyBoolean(const std::map<std::string, JSONValue>& object, const char* key, int& value, std::string& error)
{
    auto* field = findValue(object, key);
    if (!field)
        return true;
    if (field->type != JSONValue::Type::Boolean) {
        error = std::string("field '") + key + "' must be a boolean";
        return false;
    }
    value = field->boolean;
    return true;
}

static bool writeImage(const std::string& path, const shot_image& image, std::string& error)
{
    std::ofstream output(path, std::ios::binary);
    if (!output) {
        error = "cannot write " + path;
        return false;
    }
    output.write(reinterpret_cast<const char*>(image.data), image.size);
    output.flush();
    if (!output) {
        error = "failed while writing " + path;
        return false;
    }
    return true;
}

static std::string responseID(const std::map<std::string, JSONValue>& object)
{
    auto* id = findValue(object, "id");
    if (!id)
        return "null";
    if (id->type == JSONValue::Type::String)
        return jsonQuote(id->string);
    if (id->type == JSONValue::Type::Number) {
        std::ostringstream output;
        output.precision(17);
        output << id->number;
        return output.str();
    }
    return "null";
}

static void writeErrorResponse(const std::string& id, int status, const std::string& error)
{
    std::cout << "{\"id\":" << id << ",\"ok\":false,\"status\":" << status << ",\"error\":" << jsonQuote(error) << "}" << std::endl;
}

static int runServer(const shot_render_options& defaults)
{
    if (shot_init(nullptr) != SHOT_OK) {
        std::cout << "{\"ready\":false,\"protocol\":1,\"error\":\"shot_init failed\"}" << std::endl;
        return 1;
    }

    shot_renderer* renderer = shot_renderer_create();
    std::cout << "{\"ready\":true,\"protocol\":1}" << std::endl;

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty())
            continue;
        std::map<std::string, JSONValue> request;
        std::string error;
        JSONLineParser parser(line);
        if (!parser.parse(request, error)) {
            writeErrorResponse("null", SHOT_ERR_INVALID_ARG, error);
            continue;
        }

        auto id = responseID(request);
        std::string operation;
        if (!getString(request, "op", operation, false, error)) {
            writeErrorResponse(id, SHOT_ERR_INVALID_ARG, error);
            continue;
        }
        if (operation == "shutdown") {
            std::cout << "{\"id\":" << id << ",\"ok\":true,\"status\":0,\"shutdown\":true}" << std::endl;
            break;
        }
        if (!operation.empty() && operation != "render") {
            writeErrorResponse(id, SHOT_ERR_INVALID_ARG, "field 'op' must be 'render' or 'shutdown'");
            continue;
        }

        std::string url;
        std::string html;
        std::string htmlFile;
        std::string outputPath;
        std::string baseURL;
        std::string userAgent;
        std::string mimeType;
        if (!getString(request, "url", url, false, error)
            || !getString(request, "html", html, false, error)
            || !getString(request, "html_file", htmlFile, false, error)
            || !getString(request, "out", outputPath, true, error)
            || !getString(request, "base_url", baseURL, false, error)
            || !getString(request, "ua", userAgent, false, error)
            || !getString(request, "mime_type", mimeType, false, error)) {
            writeErrorResponse(id, SHOT_ERR_INVALID_ARG, error);
            continue;
        }
        bool hasURL = findValue(request, "url");
        bool hasHTML = findValue(request, "html");
        bool hasHTMLFile = findValue(request, "html_file");
        int inputCount = hasURL + hasHTML + hasHTMLFile;
        if (inputCount != 1) {
            writeErrorResponse(id, SHOT_ERR_INVALID_ARG, "provide exactly one of 'url', 'html', or 'html_file'");
            continue;
        }
        if ((hasURL && url.empty()) || (hasHTMLFile && htmlFile.empty())) {
            writeErrorResponse(id, SHOT_ERR_INVALID_ARG, "fields 'url' and 'html_file' cannot be empty");
            continue;
        }
        if (hasHTMLFile) {
            std::ifstream input(htmlFile, std::ios::binary);
            if (!input) {
                writeErrorResponse(id, SHOT_ERR_INVALID_ARG, "cannot open " + htmlFile);
                continue;
            }
            html.assign(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
        }

        shot_render_options options = defaults;
        if (!applyInteger(request, "width", options.width, error)
            || !applyInteger(request, "height", options.height, error)
            || !applyInteger(request, "timeout_ms", options.timeout_ms, error)
            || !applyNumber(request, "scale", options.device_scale, error)
            || !applyBoolean(request, "full_page", options.full_page, error)
            || !applyBoolean(request, "allow_file_urls", options.allow_file_urls, error)) {
            writeErrorResponse(id, SHOT_ERR_INVALID_ARG, error);
            continue;
        }
        if (options.width <= 0 || options.height <= 0 || options.timeout_ms <= 0 || options.device_scale <= 0) {
            writeErrorResponse(id, SHOT_ERR_INVALID_ARG, "width, height, timeout_ms, and scale must be positive");
            continue;
        }
        double quality = options.output_quality * 100.0;
        if (!applyNumber(request, "quality", quality, error) || quality < 0 || quality > 100) {
            writeErrorResponse(id, SHOT_ERR_INVALID_ARG, error.empty() ? "field 'quality' must be between 0 and 100" : error);
            continue;
        }
        options.output_quality = quality / 100.0;

        std::string format;
        if (!getString(request, "format", format, false, error)) {
            writeErrorResponse(id, SHOT_ERR_INVALID_ARG, error);
            continue;
        }
        if (!format.empty()) {
            if (format == "png")
                options.output_format = SHOT_FORMAT_PNG;
            else if (format == "webp")
                options.output_format = SHOT_FORMAT_WEBP;
            else if (format == "webp-lossless")
                options.output_format = SHOT_FORMAT_WEBP_LOSSLESS;
            else {
                writeErrorResponse(id, SHOT_ERR_INVALID_ARG, "field 'format' must be png, webp, or webp-lossless");
                continue;
            }
        }
        if (!baseURL.empty())
            options.base_url = baseURL.c_str();
        if (!userAgent.empty())
            options.user_agent = userAgent.c_str();
        if (!mimeType.empty())
            options.input_mime_type = mimeType.c_str();

        auto start = std::chrono::steady_clock::now();
        shot_image image { nullptr, 0 };
        shot_status status = hasURL
            ? shot_render_url(renderer, url.c_str(), &options, &image)
            : shot_render_html(renderer, html.data(), html.size(), &options, &image);
        if (status == SHOT_OK && !writeImage(outputPath, image, error))
            status = SHOT_ERR_RENDER_FAILED;
        auto bytes = image.size;
        shot_image_free(&image);
        auto duration = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();

        if (status != SHOT_OK) {
            if (error.empty())
                error = shot_last_error(renderer);
            writeErrorResponse(id, status, error);
            continue;
        }
        std::cout << "{\"id\":" << id << ",\"ok\":true,\"status\":0,\"bytes\":" << bytes << ",\"duration_ms\":" << duration << "}" << std::endl;
    }

    shot_renderer_destroy(renderer);
    std::fflush(nullptr);
    std::_Exit(0);
}

} // namespace

static void usage()
{
    std::fprintf(stderr,
        "usage: shotcli (--html <file> | --stdin | --url <url>) --out <image>\n"
        "       shotcli --serve\n"
        "               [--width W] [--height H] [--scale S] [--full-page]\n"
        "               [--format png|webp|webp-lossless] [--quality 0..100]\n"
        "               [--mime-type TYPE] [--timeout MS] [--base-url URL]\n"
        "               [--ua STRING] [--allow-file-urls]\n"
        "\n"
        "--serve reads one JSON object per line from stdin and writes one JSON response\n"
        "per line to stdout. Each render request requires 'out' and exactly one of\n"
        "'url', 'html', or 'html_file'. Send {\"op\":\"shutdown\"} to stop.\n");
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
    bool serve = false;

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
        else if (arg == "--serve")
            serve = true;
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

    if (serve)
        return runServer(options);

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

    std::string writeError;
    if (!writeImage(outPath, image, writeError)) {
        std::fprintf(stderr, "error: %s\n", writeError.c_str());
        return 1;
    }
    std::fprintf(stderr, "wrote %s (%zu bytes)\n", outPath.c_str(), image.size);
    shot_image_free(&image);

    // WebCore 线程级单例设计为进程退出时泄漏，正常退出会在静态析构中崩溃。截图已落盘，
    // 直接硬退出跳过一切静态析构/atexit（CLI 一次性场景专用；库形态见 shot_shutdown 注释）。
    std::fflush(nullptr);
    std::_Exit(0);
}
