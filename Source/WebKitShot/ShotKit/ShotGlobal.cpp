/*
 * ShotGlobal.cpp — ShotKit 进程级初始化实现。
 * 见仓库根 AGENTS.md。
 */

#include "config.h"
#include "ShotGlobal.h"

#include "ShotPlatformStrategies.h"
#include <JavaScriptCore/InitializeThreading.h>
#include <wtf/MainThread.h>
#include <wtf/RunLoop.h>

namespace ShotKit {

static bool s_initialized = false;

bool initialize()
{
    if (s_initialized)
        return true;

    // 把当前线程确立为主线程，并初始化 JSC 运行时。
    // 注意：WTF::initializeMainThread() 内部已调用 RunLoop::initializeMain()
    //（MainThread.cpp），不可再次调用，否则 RELEASE_ASSERT(!s_mainRunLoop) 崩溃。
    WTF::initializeMainThread();
    JSC::initialize();

    // 单进程嵌入必须提供 PlatformStrategies，否则 WebCore 多处解引用会崩溃。
    ShotPlatformStrategies::initialize();

    s_initialized = true;
    return true;
}

} // namespace ShotKit
