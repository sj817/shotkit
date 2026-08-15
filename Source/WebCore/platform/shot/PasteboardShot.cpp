/*
 * Copyright (C) 2026 ShotKit contributors.
 *
 * ShotKit is headless and never exposes a system clipboard. These no-op
 * implementations satisfy WebCore's editing seams without pulling in a UI
 * toolkit or clipboard service.
 */

#include "config.h"
#include "Pasteboard.h"

namespace WebCore {

std::unique_ptr<Pasteboard> Pasteboard::createForCopyAndPaste(std::unique_ptr<PasteboardContext>&& context)
{
    return makeUnique<Pasteboard>(WTF::move(context));
}

Pasteboard::Pasteboard(std::unique_ptr<PasteboardContext>&& context)
    : m_context(WTF::move(context))
{
}

bool Pasteboard::hasData()
{
    return false;
}

Vector<String> Pasteboard::typesSafeForBindings(const String&)
{
    return { };
}

Vector<String> Pasteboard::typesForLegacyUnsafeBindings()
{
    return { };
}

String Pasteboard::readOrigin()
{
    return { };
}

String Pasteboard::readString(const String&)
{
    return { };
}

String Pasteboard::readStringInCustomData(const String&)
{
    return { };
}

void Pasteboard::writeString(const String&, const String&)
{
}

void Pasteboard::clear()
{
}

void Pasteboard::clear(const String&)
{
}

void Pasteboard::read(PasteboardPlainText& text, PlainTextURLReadingPolicy, std::optional<size_t>)
{
    text.text = { };
}

void Pasteboard::read(PasteboardWebContentReader&, WebContentReadingPolicy, std::optional<size_t>)
{
}

void Pasteboard::read(PasteboardFileReader&, std::optional<size_t>)
{
}

void Pasteboard::write(const Color&)
{
}

void Pasteboard::write(const PasteboardURL&)
{
}

void Pasteboard::writeTrustworthyWebURLsPboardType(const PasteboardURL&)
{
}

void Pasteboard::write(const PasteboardImage&)
{
}

void Pasteboard::write(const PasteboardBuffer&)
{
}

void Pasteboard::write(const PasteboardWebContent&)
{
}

void Pasteboard::writeCustomData(const Vector<PasteboardCustomData>&, PasteboardWriteType)
{
}

Pasteboard::FileContentState Pasteboard::fileContentState()
{
    return FileContentState::NoFileOrImageData;
}

bool Pasteboard::canSmartReplace()
{
    return false;
}

void Pasteboard::writeMarkup(const String&)
{
}

void Pasteboard::writePlainText(const String&, SmartReplaceOption)
{
}

} // namespace WebCore
