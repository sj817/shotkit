if (WIN32)
    include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformWin.cmake)
elseif (APPLE)
    include(${CMAKE_CURRENT_SOURCE_DIR}/PlatformCocoa.cmake)
    list(APPEND PAL_UNIFIED_SOURCE_EXCLUDES
        "(^|/)avfoundation/(OutputContext|OutputDevice)\\.mm"
    )
else ()
    list(APPEND PAL_SOURCES
        crypto/openssl/CryptoDigestOpenSSL.cpp
        system/ClockGeneric.cpp
        system/Sound.cpp
        text/KillRing.cpp
    )
    list(APPEND PAL_LIBRARIES OpenSSL::Crypto)
endif ()
