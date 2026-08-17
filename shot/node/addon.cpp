/*
 * shot.node — Node-API binding over ShotKit's synchronous C ABI.
 *
 * WebCore remains confined to one dedicated native thread. The Node thread
 * only validates/copies requests and resolves promises with encoded buffers.
 */

#define NAPI_VERSION 8
#include <node_api.h>

#include "shot.h"

#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

struct NativeRequest {
    bool isURL { false };
    std::vector<uint8_t> html;
    std::string url;
    int width { 1280 };
    int height { 800 };
    double scale { 1 };
    bool fullPage { false };
    int timeoutMs { 30000 };
    bool allowFileURLs { false };
    shot_output_format format { SHOT_FORMAT_PNG };
    double quality { 0.8 };
    std::string userAgent;
    std::string baseURL;
    std::string mimeType { "text/html" };
    std::string selector;
};

enum class TaskKind : uint8_t { Initialize, Render };

struct Task {
    TaskKind kind { TaskKind::Render };
    napi_deferred deferred { nullptr };
    NativeRequest request;
    shot_status status { SHOT_OK };
    shot_image image { nullptr, 0 };
    std::string error;
    double durationMs { 0 };
};

class Dispatcher {
public:
    explicit Dispatcher(napi_env env)
        : m_env(env)
    {
    }

    ~Dispatcher()
    {
        shutdown();
    }

    bool createCompletionChannel()
    {
        napi_value resourceName;
        if (napi_create_string_utf8(m_env, "shotkit:completion", NAPI_AUTO_LENGTH, &resourceName) != napi_ok)
            return false;
        if (napi_create_threadsafe_function(m_env, nullptr, nullptr, resourceName, 0, 1, nullptr, nullptr, this, completeOnNodeThread, &m_completion) != napi_ok)
            return false;
        napi_unref_threadsafe_function(m_env, m_completion);
        return true;
    }

    napi_value enqueue(napi_env env, TaskKind kind, NativeRequest&& request = { })
    {
        napi_value promise;
        napi_deferred deferred;
        if (napi_create_promise(env, &deferred, &promise) != napi_ok)
            return nullptr;

        auto task = std::make_unique<Task>();
        task->kind = kind;
        task->deferred = deferred;
        task->request = std::move(request);

        bool startThread = false;
        {
            std::lock_guard lock(m_mutex);
            if (m_stopping) {
                rejectImmediately(env, deferred, SHOT_ERR_INIT_FAILED, "ShotKit native dispatcher is shutting down");
                return promise;
            }
            startThread = !m_started;
            if (startThread)
                m_started = true;
            m_tasks.push_back(std::move(task));
        }

        if (!m_pendingOnNodeThread++)
            napi_ref_threadsafe_function(env, m_completion);
        if (startThread)
            m_thread = std::thread([this] { workerMain(); });
        m_condition.notify_one();
        return promise;
    }

    void shutdown()
    {
        {
            std::lock_guard lock(m_mutex);
            if (m_stopping)
                return;
            m_stopping = true;
            while (!m_tasks.empty()) {
                auto task = std::move(m_tasks.front());
                m_tasks.pop_front();
                shot_image_free(&task->image);
            }
        }
        m_condition.notify_all();
        if (m_thread.joinable())
            m_thread.join();
        if (m_completion) {
            napi_release_threadsafe_function(m_completion, napi_tsfn_abort);
            m_completion = nullptr;
        }
    }

private:
    static napi_value makeError(napi_env env, shot_status status, const std::string& message)
    {
        napi_value text;
        napi_value error;
        napi_create_string_utf8(env, message.c_str(), message.size(), &text);
        napi_create_error(env, nullptr, text, &error);
        napi_value statusValue;
        napi_create_int32(env, status, &statusValue);
        napi_set_named_property(env, error, "status", statusValue);
        return error;
    }

    static void rejectImmediately(napi_env env, napi_deferred deferred, shot_status status, const char* message)
    {
        napi_reject_deferred(env, deferred, makeError(env, status, message));
    }

    static void finalizeImage(napi_env, void*, void* hint)
    {
        auto image = static_cast<shot_image*>(hint);
        shot_image_free(image);
        delete image;
    }

    static void completeOnNodeThread(napi_env env, napi_value, void* context, void* data)
    {
        auto* dispatcher = static_cast<Dispatcher*>(context);
        std::unique_ptr<Task> task(static_cast<Task*>(data));
        if (!env) {
            shot_image_free(&task->image);
            return;
        }

        if (task->status != SHOT_OK) {
            auto message = task->error.empty() ? "ShotKit native operation failed" : task->error;
            napi_reject_deferred(env, task->deferred, makeError(env, task->status, message));
        } else if (task->kind == TaskKind::Initialize) {
            napi_value undefined;
            napi_get_undefined(env, &undefined);
            napi_resolve_deferred(env, task->deferred, undefined);
        } else {
            napi_value result;
            napi_value buffer;
            napi_value bytes;
            napi_value duration;
            napi_create_object(env, &result);

            auto* image = new shot_image { task->image.data, task->image.size };
            auto imageSize = image->size;
            task->image = { nullptr, 0 };
            auto bufferStatus = napi_create_external_buffer(env, image->size,
                reinterpret_cast<char*>(image->data), finalizeImage, image, &buffer);
            bool imageReleased = false;
            if (bufferStatus == napi_no_external_buffers_allowed) {
                bufferStatus = napi_create_buffer_copy(env, image->size, image->data, nullptr, &buffer);
                finalizeImage(env, nullptr, image);
                imageReleased = true;
            }
            if (bufferStatus != napi_ok) {
                if (!imageReleased)
                    finalizeImage(env, nullptr, image);
                napi_reject_deferred(env, task->deferred,
                    makeError(env, SHOT_ERR_RENDER_FAILED, "failed to create Node Buffer"));
                dispatcher->didComplete(env);
                return;
            }

            napi_create_double(env, static_cast<double>(imageSize), &bytes);
            napi_create_double(env, task->durationMs, &duration);
            napi_set_named_property(env, result, "data", buffer);
            napi_set_named_property(env, result, "bytes", bytes);
            napi_set_named_property(env, result, "durationMs", duration);
            napi_resolve_deferred(env, task->deferred, result);
        }
        dispatcher->didComplete(env);
    }

    void didComplete(napi_env env)
    {
        if (m_pendingOnNodeThread && !--m_pendingOnNodeThread)
            napi_unref_threadsafe_function(env, m_completion);
    }

    void workerMain()
    {
        for (;;) {
            std::unique_ptr<Task> task;
            {
                std::unique_lock lock(m_mutex);
                m_condition.wait(lock, [this] { return m_stopping || !m_tasks.empty(); });
                if (m_stopping)
                    break;
                task = std::move(m_tasks.front());
                m_tasks.pop_front();
            }

            if (task->kind == TaskKind::Initialize)
                initialize(*task);
            else
                render(*task);

            auto* completion = task.release();
            if (napi_call_threadsafe_function(m_completion, completion, napi_tsfn_nonblocking) != napi_ok) {
                shot_image_free(&completion->image);
                delete completion;
            }
        }

        if (m_renderer) {
            shot_renderer_destroy(m_renderer);
            m_renderer = nullptr;
        }
        shot_shutdown();
    }

    void initialize(Task& task)
    {
        if (m_renderer)
            return;
        task.status = shot_init(nullptr);
        if (task.status != SHOT_OK) {
            task.error = "shot_init failed";
            return;
        }
        m_renderer = shot_renderer_create();
        if (!m_renderer) {
            task.status = SHOT_ERR_INIT_FAILED;
            task.error = "shot_renderer_create failed";
        }
    }

    void render(Task& task)
    {
        if (!m_renderer) {
            task.status = SHOT_ERR_INIT_FAILED;
            task.error = "ShotKit is not initialized; call launch() first";
            return;
        }

        shot_render_options options;
        shot_render_options_default(&options);
        options.width = task.request.width;
        options.height = task.request.height;
        options.device_scale = task.request.scale;
        options.full_page = task.request.fullPage;
        options.timeout_ms = task.request.timeoutMs;
        options.allow_file_urls = task.request.allowFileURLs;
        options.output_format = task.request.format;
        options.output_quality = task.request.quality;
        options.user_agent = task.request.userAgent.empty() ? nullptr : task.request.userAgent.c_str();
        options.base_url = task.request.baseURL.empty() ? nullptr : task.request.baseURL.c_str();
        options.input_mime_type = task.request.mimeType.empty() ? nullptr : task.request.mimeType.c_str();
        options.selector = task.request.selector.empty() ? nullptr : task.request.selector.c_str();

        auto start = std::chrono::steady_clock::now();
        task.status = task.request.isURL
            ? shot_render_url(m_renderer, task.request.url.c_str(), &options, &task.image)
            : shot_render_html(m_renderer, reinterpret_cast<const char*>(task.request.html.data()), task.request.html.size(), &options, &task.image);
        task.durationMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        if (task.status != SHOT_OK)
            task.error = shot_last_error(m_renderer);
    }

    napi_env m_env { nullptr };
    napi_threadsafe_function m_completion { nullptr };
    std::mutex m_mutex;
    std::condition_variable m_condition;
    std::deque<std::unique_ptr<Task>> m_tasks;
    std::thread m_thread;
    shot_renderer* m_renderer { nullptr };
    size_t m_pendingOnNodeThread { 0 };
    bool m_started { false };
    bool m_stopping { false };
};

static Dispatcher* dispatcher(napi_env env)
{
    void* data = nullptr;
    napi_get_instance_data(env, &data);
    return static_cast<Dispatcher*>(data);
}

static bool getNamedValue(napi_env env, napi_value object, const char* name, napi_value& value)
{
    bool present = false;
    return napi_has_named_property(env, object, name, &present) == napi_ok
        && present && napi_get_named_property(env, object, name, &value) == napi_ok;
}

static bool getString(napi_env env, napi_value object, const char* name, std::string& output, bool required = false)
{
    napi_value value;
    if (!getNamedValue(env, object, name, value))
        return !required;
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string)
        return false;
    size_t length = 0;
    napi_get_value_string_utf8(env, value, nullptr, 0, &length);
    output.resize(length + 1);
    size_t copied = 0;
    if (napi_get_value_string_utf8(env, value, output.data(), output.size(), &copied) != napi_ok)
        return false;
    output.resize(copied);
    return true;
}

static bool getInt(napi_env env, napi_value object, const char* name, int& output)
{
    napi_value value;
    return getNamedValue(env, object, name, value) && napi_get_value_int32(env, value, &output) == napi_ok;
}

static bool getDouble(napi_env env, napi_value object, const char* name, double& output)
{
    napi_value value;
    return getNamedValue(env, object, name, value) && napi_get_value_double(env, value, &output) == napi_ok;
}

static bool getBool(napi_env env, napi_value object, const char* name, bool& output)
{
    napi_value value;
    return getNamedValue(env, object, name, value) && napi_get_value_bool(env, value, &output) == napi_ok;
}

static napi_value throwTypeError(napi_env env, const char* message)
{
    napi_throw_type_error(env, nullptr, message);
    return nullptr;
}

static napi_value initialize(napi_env env, napi_callback_info)
{
    return dispatcher(env)->enqueue(env, TaskKind::Initialize);
}

static napi_value render(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
        return throwTypeError(env, "render() expects one normalized request object");

    napi_valuetype type;
    if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object)
        return throwTypeError(env, "render() request must be an object");

    NativeRequest request;
    std::string kind;
    int format = 0;
    if (!getString(env, argv[0], "kind", kind, true)
        || !getInt(env, argv[0], "width", request.width)
        || !getInt(env, argv[0], "height", request.height)
        || !getDouble(env, argv[0], "scale", request.scale)
        || !getBool(env, argv[0], "fullPage", request.fullPage)
        || !getInt(env, argv[0], "timeoutMs", request.timeoutMs)
        || !getBool(env, argv[0], "allowFileURLs", request.allowFileURLs)
        || !getInt(env, argv[0], "format", format)
        || !getDouble(env, argv[0], "quality", request.quality)
        || !getString(env, argv[0], "userAgent", request.userAgent)
        || !getString(env, argv[0], "baseURL", request.baseURL)
        || !getString(env, argv[0], "mimeType", request.mimeType)
        || !getString(env, argv[0], "selector", request.selector))
        return throwTypeError(env, "render() received an invalid normalized request");

    if (request.width <= 0 || request.height <= 0 || !std::isfinite(request.scale) || request.scale <= 0 || request.timeoutMs <= 0
        || format < SHOT_FORMAT_PNG || format > SHOT_FORMAT_WEBP_LOSSLESS
        || !std::isfinite(request.quality) || request.quality < 0 || request.quality > 1)
        return throwTypeError(env, "render() request values are out of range");
    request.format = static_cast<shot_output_format>(format);

    napi_value input;
    if (!getNamedValue(env, argv[0], "input", input))
        return throwTypeError(env, "render() request is missing input");
    if (kind == "url") {
        request.isURL = true;
        size_t length = 0;
        if (napi_get_value_string_utf8(env, input, nullptr, 0, &length) != napi_ok)
            return throwTypeError(env, "URL input must be a string");
        request.url.resize(length + 1);
        size_t copied = 0;
        if (napi_get_value_string_utf8(env, input, request.url.data(), request.url.size(), &copied) != napi_ok)
            return throwTypeError(env, "failed to copy URL input");
        request.url.resize(copied);
    } else if (kind == "html") {
        bool isBuffer = false;
        if (napi_is_buffer(env, input, &isBuffer) != napi_ok || !isBuffer)
            return throwTypeError(env, "HTML input must be a Buffer");
        void* data = nullptr;
        size_t length = 0;
        if (napi_get_buffer_info(env, input, &data, &length) != napi_ok)
            return throwTypeError(env, "failed to read HTML Buffer");
        if (length) {
            auto* bytes = static_cast<uint8_t*>(data);
            request.html.assign(bytes, bytes + length);
        }
    } else
        return throwTypeError(env, "render() kind must be 'url' or 'html'");

    return dispatcher(env)->enqueue(env, TaskKind::Render, std::move(request));
}

static void cleanup(void* data)
{
    auto* state = static_cast<Dispatcher*>(data);
    state->shutdown();
    delete state;
}

} // namespace

NAPI_MODULE_INIT()
{
    auto* state = new Dispatcher(env);
    if (!state->createCompletionChannel()) {
        delete state;
        napi_throw_error(env, nullptr, "failed to create ShotKit completion channel");
        return nullptr;
    }
    napi_set_instance_data(env, state, nullptr, nullptr);
    napi_add_env_cleanup_hook(env, cleanup, state);

    napi_property_descriptor properties[] = {
        { "initialize", nullptr, initialize, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "render", nullptr, render, nullptr, nullptr, nullptr, napi_default, nullptr },
    };
    napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
    return exports;
}
