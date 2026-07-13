/*
 * config.h — ShotKit 前置配置头（每个 .cpp 首个 include）。
 * 仿 Tools/DumpRenderTree/config.h：一个消费 WebCore 内部 API 的工具目标所需的最小前置。
 */

#pragma once

#if defined(HAVE_CONFIG_H) && HAVE_CONFIG_H && defined(BUILDING_WITH_CMAKE)
#include "cmakeconfig.h"
#endif

#include <JavaScriptCore/JSExportMacros.h>
#include <WebCore/PlatformExportMacros.h>
#include <pal/ExportMacros.h>

#ifdef __cplusplus
#undef new
#undef delete
#include <wtf/FastMalloc.h>
#include <wtf/TZoneMalloc.h>
#endif
