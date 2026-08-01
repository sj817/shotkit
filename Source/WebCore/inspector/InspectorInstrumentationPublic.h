/*
 * Copyright (C) 2019 Apple Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE INC. AND ITS CONTRIBUTORS ``AS IS''
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL APPLE INC. OR ITS CONTRIBUTORS
 * BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 */

#pragma once

#include <atomic>
namespace WebCore {

#define FAST_RETURN_IF_NO_FRONTENDS(value)                          \
    if (!InspectorInstrumentationPublic::hasFrontends()) [[likely]] \
        return value;

class WEBCORE_EXPORT InspectorInstrumentationPublic {
public:
#if defined(SHOT_NO_INSPECTOR)
    // ShotKit never connects a Web Inspector frontend, so this is a compile-time
    // constant. Folding it collapses every FAST_RETURN_IF_NO_FRONTENDS fast path,
    // which un-anchors all InspectorInstrumentation::*Impl slow paths (and with
    // them the agents they reach) so LTO can drop them.
    static constexpr bool hasFrontends() { return false; }
#else
    static bool hasFrontends() { return s_frontendCounter; }
#endif
    static std::atomic<int> s_frontendCounter;
};

}
