# WebCore platform layer for the Shot port.
if (WIN32)
    include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformWin.cmake)
elseif (APPLE)
    include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformMac.cmake)
    # PlatformMac normally builds WebCore.framework and codesigns it. Shot
    # folds WebCore OBJECT files into libshot, so OBJECT targets cannot carry
    # that framework POST_BUILD command.
    set(WebCore_POST_BUILD_COMMAND "")
    # NSURLSession's WebCore bridge is for PlatformMediaResource/AVFoundation.
    # Those types are absent with ENABLE_VIDEO=OFF; static document networking
    # uses ResourceHandleCocoa (NSURLConnection/CFNetwork) instead.
    list(REMOVE_ITEM WebCore_SOURCES
        dom/DataTransferMac.mm
        loader/cocoa/DiskCacheMonitorCocoa.mm
        platform/network/cocoa/RangeResponseGenerator.mm
        platform/network/cocoa/WebCoreNSURLSession.mm
        platform/mediastream/cocoa/ScreenCaptureKitCaptureSource.mm
        platform/mediastream/cocoa/ScreenCaptureKitSharingSessionManager.mm
    )
    list(APPEND WebCore_UNIFIED_SOURCE_EXCLUDES
        "(^|/)Modules/applepay(-ams-ui)?/"
        "(^|/)Modules/WebGPU/Implementation/"
        "(^|/)dom/DataTransferMac\\.mm"
        "(^|/)loader/cocoa/DiskCacheMonitorCocoa\\.mm"
        "(^|/)page/scrolling/(cocoa|mac)/"
        "(^|/)platform/audio/cocoa/"
        "(^|/)platform/audio/ios/"
        "(^|/)platform/audio/mac/"
        "(^|/)platform/graphics/avfoundation/"
        "(^|/)platform/graphics/cv/"
        "(^|/)platform/cocoa/(SharedVideoFrameInfo|VideoFullscreenCaptions|WebAVPlayerLayer)"
        "(^|/)platform/graphics/cocoa/(AV1UtilitiesCocoa|AudioTrackPrivateWebM|CMUtilities|CVPixelBufferUtilities|H264UtilitiesCocoa|HEVCUtilitiesCocoa|ISOBMFFPreParser|ISOBMFFTrackInfoParser|MediaPlayer.*|PlatformMediaEngineConfigurationFactoryCocoa|PlatformTimeRangesCocoa|ShareableCVPixelBuffer|ShareableCVPixelFormat|SourceBufferParser.*|TextTrackRepresentationCocoa|VP9UtilitiesCocoa|VideoMediaSampleRenderer|VideoTargetFactory|VideoTrackPrivateWebM|WebCoreDecompressionSession|WebMAudioUtilitiesCocoa)"
        "(^|/)platform/ios/(PlaybackSession|VideoPresentation|WebAVPlayer|WebVideoFullscreen)"
        "(^|/)platform/mediastream/cocoa/ScreenCaptureKit(CaptureSource|SharingSessionManager)"
        "(^|/)platform/network/cocoa/(RangeResponseGenerator|WebCoreNSURLSession)"
        "SerializedPlatformDataCue"
    )
    list(FILTER WebCore_SOURCES EXCLUDE REGEX "(^|/)Modules/WebGPU/Implementation/")
    list(FILTER WebCore_SOURCES EXCLUDE REGEX "(^|/)platform/audio/(cocoa|ios|mac)/")
    list(FILTER WebCore_SOURCES EXCLUDE REGEX "(^|/)dom/DataTransferMac\\.mm")
    list(FILTER WebCore_SOURCES EXCLUDE REGEX "(^|/)loader/cocoa/DiskCacheMonitorCocoa\\.mm")
    list(FILTER WebCore_SOURCES EXCLUDE REGEX "(^|/)page/scrolling/(cocoa|mac)/")
    list(FILTER WebCore_SOURCES EXCLUDE REGEX "(^|/)platform/graphics/(avfoundation|cv)/")
    list(FILTER WebCore_SOURCES EXCLUDE REGEX "(^|/)platform/cocoa/(SharedVideoFrameInfo|VideoFullscreenCaptions|WebAVPlayerLayer)")
    list(FILTER WebCore_SOURCES EXCLUDE REGEX "(^|/)platform/graphics/cocoa/(AV1UtilitiesCocoa|AudioTrackPrivateWebM|CMUtilities|CVPixelBufferUtilities|H264UtilitiesCocoa|HEVCUtilitiesCocoa|ISOBMFFPreParser|ISOBMFFTrackInfoParser|MediaPlayer.*|PlatformMediaEngineConfigurationFactoryCocoa|PlatformTimeRangesCocoa|ShareableCVPixelBuffer|ShareableCVPixelFormat|SourceBufferParser.*|TextTrackRepresentationCocoa|VP9UtilitiesCocoa|VideoMediaSampleRenderer|VideoTargetFactory|VideoTrackPrivateWebM|WebCoreDecompressionSession|WebMAudioUtilitiesCocoa)")
    list(FILTER WebCore_SOURCES EXCLUDE REGEX "(^|/)platform/ios/(PlaybackSession|VideoPresentation|WebAVPlayer|WebVideoFullscreen)")
    list(FILTER WebCore_SOURCES EXCLUDE REGEX "(^|/)platform/mediastream/cocoa/ScreenCaptureKit(CaptureSource|SharingSessionManager)")
    list(FILTER WebCore_SOURCES EXCLUDE REGEX "(^|/)platform/network/cocoa/(RangeResponseGenerator|WebCoreNSURLSession)")
    list(FILTER WebCore_SOURCES EXCLUDE REGEX "SerializedPlatformDataCue")
    list(APPEND WebCore_SOURCES
        platform/graphics/cocoa/CVPixelBufferUtilities.cpp
        platform/graphics/cocoa/MediaPlayerEnumsCocoa.mm
        platform/graphics/cocoa/ShareableCVPixelBuffer.cpp
    )
else ()
    include(platform/Adwaita.cmake)
    include(platform/Curl.cmake)
    include(platform/ImageDecoders.cmake)
    include(platform/OpenSSL.cmake)
    include(platform/Skia.cmake)
    include(platform/TextureMapper.cmake)

    list(APPEND WebCore_PRIVATE_INCLUDE_DIRECTORIES
        "${WEBCORE_DIR}/accessibility/playstation"
        ${EGL_INCLUDE_DIRS}
        "${WEBCORE_DIR}/platform/generic"
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
        platform/graphics/playstation/SystemFontDatabasePlayStation.cpp

        platform/graphics/egl/GLContext.cpp
        platform/graphics/egl/GLContextWrapper.cpp
        platform/graphics/egl/GLDisplay.cpp
        platform/graphics/egl/GLFence.cpp
        platform/graphics/egl/GLFenceEGL.cpp
        platform/graphics/egl/GLFenceGL.cpp

        platform/network/playstation/NetworkStateNotifierPlayStation.cpp
        platform/network/win/CurlSSLHandleWin.cpp

        platform/playstation/MIMETypeRegistryPlayStation.cpp
        platform/playstation/PlatformScreenPlayStation.cpp
        platform/playstation/UserAgentPlayStation.cpp

        platform/shot/PasteboardShot.cpp
        platform/text/Hyphenation.cpp
        platform/text/LocaleICU.cpp

        platform/unix/LoggingUnix.cpp
        platform/unix/SharedMemoryUnix.cpp
    )

    list(APPEND WebCore_LIBRARIES
        Fontconfig::Fontconfig
        Freetype::Freetype
        ${EGL_LIBRARIES}
        OpenGL::GLES
        Threads::Threads
    )

    if (USE_WOFF2)
        list(APPEND WebCore_LIBRARIES Brotli::dec WOFF2::common)
    endif ()

    list(APPEND WebCore_PRIVATE_LIBRARIES ${SHARPYUV_LIBS})
endif ()
include(${CMAKE_CURRENT_SOURCE_DIR}/ShotPruning.cmake)
