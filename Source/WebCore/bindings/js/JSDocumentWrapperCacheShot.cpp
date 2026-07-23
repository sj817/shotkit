/*
 * Copyright (C) 2007-2021 Apple Inc. All rights reserved.
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Library General Public
 * License as published by the Free Software Foundation; either
 * version 2 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Library General Public License for more details.
 *
 * You should have received a copy of the GNU Library General Public License
 * along with this library; see the file COPYING.LIB.  If not, write to
 * the Free Software Foundation, Inc., 51 Franklin Street, Fifth Floor,
 * Boston, MA 02110-1301, USA.
 */

// ShotKit: the generated toJS for the Document family calls these two free
// helpers, which upstream defines in JSDocumentCustom.cpp. Shot degenerates
// the Document binding and excludes that custom translation unit, so the
// helpers live here verbatim (see Source/WebCore/ShotPruning.cmake).

#include "config.h"
#include "JSDocument.h"

#include "FrameDestructionObserverInlines.h"
#include "JSDOMGlobalObjectInlines.h"
#include "JSDOMWindowCustom.h"
#include "LocalFrame.h"
#include "NodeTraversal.h"

namespace WebCore {
using namespace JSC;

JSObject* cachedDocumentWrapper(JSGlobalObject& lexicalGlobalObject, JSDOMGlobalObject& globalObject, Document& document)
{
    if (auto* wrapper = getCachedWrapper(globalObject.world(), document))
        return wrapper;

    RefPtr window = document.window();
    if (!window)
        return nullptr;

    auto* documentGlobalObject = toJSDOMGlobalObject<JSDOMWindow>(lexicalGlobalObject.vm(), toJS(&lexicalGlobalObject, *window));
    if (!documentGlobalObject)
        return nullptr;

    // Creating a wrapper for domWindow might have created a wrapper for document as well.
    return getCachedWrapper(documentGlobalObject->world(), document);
}

void reportMemoryForDocumentIfFrameless(JSGlobalObject& lexicalGlobalObject, Document& document)
{
    // Make sure the document is kept around by the window object, and works right with the back/forward cache.
    if (document.frame())
        return;

    VM& vm = lexicalGlobalObject.vm();
    size_t memoryCost = 0;
    for (CheckedPtr<Node> node = &document; node; node = NodeTraversal::next(*node))
        memoryCost += node->approximateMemoryCost();

    // FIXME: Adopt reportExtraMemoryVisited, and switch to reportExtraMemoryAllocated.
    // https://bugs.webkit.org/show_bug.cgi?id=142595
    vm.heap.deprecatedReportExtraMemory(memoryCost);
}

} // namespace WebCore
