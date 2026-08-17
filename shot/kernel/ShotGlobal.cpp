/*
 * ShotGlobal.cpp — ShotKit 进程级初始化实现。
 * 见仓库根 AGENTS.md。
 */

#include "config.h"
#include "ShotGlobal.h"

#include "ShotPlatformStrategies.h"
#include <JavaScriptCore/InitializeThreading.h>
#include <JavaScriptCore/Options.h>
#include <WebCore/ServiceWorkerProvider.h>
#include <WebCore/ThreadGlobalData.h>
#include <wtf/CompletionHandler.h>
#include <wtf/MainThread.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>

namespace ShotKit {

static bool s_initialized = false;

// JSC's desktop Structure Heap defaults to a 4 GiB aligned reservation. The
// Windows fallback reserves size + alignment, which appears as roughly 8 GiB
// of virtual address space. Static ShotKit pages need only a tiny fraction of
// that; 32 MiB is the smallest value that leaves enough headroom for WebCore's
// first common VM while still bounding the fallback to 64 MiB.
static constexpr unsigned shotStructureHeapSizeInKB = 32 * 1024;
static constexpr unsigned shotGCAllocationCycleLimit = 16 * 1024 * 1024;

// ServiceWorkerProvider::singleton() does RELEASE_ASSERT(sharedProvider). ShotKit
// never registers or runs a service worker (page JS never executes), but several
// loader paths query the provider — e.g. DocumentLoader::matchRegistration and
// DocumentLoader::commitData — gated only on DocumentLoader::m_canUseServiceWorkers,
// which defaults to true and is corrected by FrameLoader::init. Register a sentinel
// so a future path that skips that correction returns "no worker" instead of crashing.
class ShotServiceWorkerProvider final : public WebCore::ServiceWorkerProvider {
public:
    WebCore::SWClientConnection& serviceWorkerConnection() final { RELEASE_ASSERT_NOT_REACHED(); }
    WebCore::SWClientConnection* existingServiceWorkerConnection() final { return nullptr; }
    void terminateWorkerForTesting(WebCore::ServiceWorkerIdentifier, CompletionHandler<void()>&& completionHandler) final { completionHandler(); }
};

bool initialize()
{
    if (s_initialized)
        return true;

    // 把当前线程确立为主线程，并初始化 JSC 运行时。
    // 注意：WTF::initializeMainThread() 内部已调用 RunLoop::initializeMain()
    //（MainThread.cpp），不可再次调用，否则 RELEASE_ASSERT(!s_mainRunLoop) 崩溃。
    WTF::initializeMainThread();
    JSC::initialize([] {
        JSC::Options::structureHeapSizeInKB() = shotStructureHeapSizeInKB;
        JSC::Options::forceMiniVMMode() = true;
        JSC::Options::gcMaxHeapSize() = shotGCAllocationCycleLimit;
        JSC::Options::useConcurrentGC() = false;
    });

    // 单进程嵌入必须提供 PlatformStrategies，否则 WebCore 多处解引用会崩溃。
    ShotPlatformStrategies::initialize();

    static NeverDestroyed<ShotServiceWorkerProvider> serviceWorkerProvider;
    WebCore::ServiceWorkerProvider::setSharedProvider(serviceWorkerProvider.get());

    s_initialized = true;
    return true;
}

void shutdownThread()
{
    // ThreadGlobalData owns FontCache and fonts. Letting pthread/FLS teardown
    // destroy those objects directly is unsafe because Font::~Font consults
    // the current thread's cache after WTF::Thread has begun dismantling its
    // client data. WebCore workers explicitly perform this cleanup before the
    // Thread object goes away; ShotKit's dedicated host thread must do so too.
    WebCore::threadGlobalDataSingleton().destroy();
}

} // namespace ShotKit
