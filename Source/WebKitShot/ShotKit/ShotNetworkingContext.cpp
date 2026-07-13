/*
 * ShotNetworkingContext.cpp — 见 ShotNetworkingContext.h。
 */

#include "config.h"
#include "ShotNetworkingContext.h"

#include "ShotSession.h"
#include <WebCore/NetworkStorageSession.h>
#include <WebCore/ResourceError.h>

namespace ShotKit {

WebCore::NetworkStorageSession* ShotNetworkingContext::storageSession() const
{
    return &networkStorageSession();
}

WebCore::ResourceError ShotNetworkingContext::blockedError(const WebCore::ResourceRequest&) const
{
    // 无头渲染不主动拦截请求；返回空错误即可。
    return { };
}

} // namespace ShotKit
