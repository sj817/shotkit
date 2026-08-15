if (WIN32)
    include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformWin.cmake)
elseif (APPLE)
    include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformCocoa.cmake)
else ()
    include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformJSCOnly.cmake)
    list(APPEND WTF_PUBLIC_HEADERS
        unix/UnixFileDescriptor.h
    )
endif ()
