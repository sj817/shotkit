/*
 * Copyright (C) 2026 ShotKit contributors.
 *
 * Headless static rendering never exposes editing or a platform pasteboard.
 * These are the platform seams required by Editor's cross-platform core.
 */

#include "config.h"
#include "Editor.h"

#include "DocumentFragment.h"
#include "SimpleRange.h"

namespace WebCore {

void Editor::pasteWithPasteboard(Pasteboard*, OptionSet<PasteOption>)
{
}

void Editor::platformCopyFont()
{
}

void Editor::platformPasteFont()
{
}

RefPtr<DocumentFragment> Editor::webContentFromPasteboard(Pasteboard&, const SimpleRange&, bool, bool& chosePlainText)
{
    chosePlainText = false;
    return nullptr;
}

} // namespace WebCore
