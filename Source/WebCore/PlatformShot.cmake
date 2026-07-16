# WebCore platform layer for the Shot port.
if (WIN32)
    include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformWin.cmake)
elseif (APPLE)
    include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformMac.cmake)
else ()
    include(platform/Adwaita.cmake)
    include(platform/Curl.cmake)
    include(platform/FreeType.cmake)
    include(platform/ImageDecoders.cmake)
    include(platform/OpenSSL.cmake)
    include(platform/Skia.cmake)
    include(platform/TextureMapper.cmake)

    list(APPEND WebCore_PRIVATE_INCLUDE_DIRECTORIES
        "${WEBCORE_DIR}/accessibility/playstation"
        "${WEBCORE_DIR}/platform/generic"
        "${WEBCORE_DIR}/platform/graphics/opentype"
        "${WEBCORE_DIR}/platform/mediacapabilities"
        "${WEBCORE_DIR}/platform/network/curl"
        "${WEBCORE_DIR}/platform/playstation"
        "${WEBCORE_DIR}/platform/video-codecs"
        "${WEBCORE_DIR}/rendering/playstation"
    )

    # These PlayStation files are dependency-free headless stubs rather than
    # console APIs: MIME mappings, screen geometry, AX wrappers and online
    # state. They are temporary sources for the new Linux Shot platform seam.
    list(APPEND WebCore_SOURCES
        accessibility/playstation/AXObjectCachePlayStation.cpp
        accessibility/playstation/AccessibilityObjectPlayStation.cpp

        platform/shot/EditorShot.cpp

        platform/Cursor.cpp
        platform/LocalizedStrings.cpp
        platform/StaticPasteboard.cpp
        platform/audio/PlatformMediaSessionManager.cpp

        platform/generic/KeyedDecoderGeneric.cpp
        platform/generic/KeyedEncoderGeneric.cpp

        platform/graphics/PlatformDisplay.cpp
        platform/graphics/opentype/OpenTypeUtilities.cpp
        platform/graphics/playstation/SystemFontDatabasePlayStation.cpp

        platform/network/playstation/NetworkStateNotifierPlayStation.cpp
        platform/network/win/CurlSSLHandleWin.cpp

        platform/playstation/MIMETypeRegistryPlayStation.cpp
        platform/playstation/PlatformScreenPlayStation.cpp
        platform/playstation/UserAgentPlayStation.cpp

        platform/skia/DragImageSkia.cpp
        platform/text/Hyphenation.cpp
        platform/text/LocaleICU.cpp

        platform/unix/LoggingUnix.cpp
        platform/unix/SharedMemoryUnix.cpp
    )

    list(APPEND WebCore_LIBRARIES
        Fontconfig::Fontconfig
        Freetype::Freetype
        Threads::Threads
    )

    if (USE_WOFF2)
        list(APPEND WebCore_LIBRARIES Brotli::dec WOFF2::common)
    endif ()

    list(APPEND WebCore_PRIVATE_LIBRARIES ${SHARPYUV_LIBS})
endif ()
include(${CMAKE_CURRENT_SOURCE_DIR}/ShotPruning.cmake)
