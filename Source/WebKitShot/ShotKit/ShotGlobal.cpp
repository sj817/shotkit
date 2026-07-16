/*
 * ShotGlobal.cpp — ShotKit 进程级初始化实现。
 * 见仓库根 AGENTS.md。
 */

#include "config.h"
#include "ShotGlobal.h"

#include "ShotPlatformStrategies.h"
#include <JavaScriptCore/InitializeThreading.h>
#include <JavaScriptCore/Options.h>
#include <wtf/MainThread.h>
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

    s_initialized = true;
    return true;
}

} // namespace ShotKit
