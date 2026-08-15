/*
 * ShotGlobal.h — ShotKit 进程级初始化。
 *
 * 把当前调用线程绑定为 WebCore 主线程，初始化 WTF/JSC 与平台策略。
 * 进程内只应调用一次；此后所有渲染必须在同一线程进行。
 * 见仓库根 AGENTS.md。
 */

#pragma once

namespace ShotKit {

// 初始化 WebCore 运行环境（线程、JSC、PlatformStrategies）。幂等。
// 返回 false 表示初始化失败。
bool initialize();

} // namespace ShotKit
