# ShotKit 是静态标记渲染器，页面脚本永不执行。优先物理移除与渲染核心
# 零耦合的浏览器 API，避免生成对应 JS* 包装器。每个模块单独打通
# source/IDL/工厂/自定义绑定闭环后再加入这里。
#
# 明确不在此裁剪的保真路径：
#   - platform/image-decoders（PNG/JPEG/GIF/BMP/ICO/WebP 等网页图片）
#   - svg/ 与 mathml/
#   - xml/ 及 ENABLE_XSLT 的 libxslt 路径
#   - CSS、字体、loader 与 curl HTTP(S)

set(_shot_original_idl_files ${WebCore_IDL_FILES} ${WebCore_SUPPLEMENTAL_IDL_FILES})

foreach (_shot_idl_list
    WebCore_NON_SVG_IDL_FILES
    WebCore_IDL_FILES
    WebCore_SUPPLEMENTAL_IDL_FILES
)
    if (DEFINED ${_shot_idl_list})
        list(FILTER ${_shot_idl_list} EXCLUDE REGEX "(^|/)Modules/webdatabase/")
    endif ()
endforeach ()

# Sources.txt 静态列出了所有 IDL 对应的 JS*.cpp。仅从绑定输入移除 IDL
# 还不够：增量构建时统一源生成器会重新收进旧的派生文件。同步排除每个
# 被裁 IDL 的生成源，保证干净构建和增量构建得到同一结果。
set(_shot_retained_idl_files ${WebCore_NON_SVG_IDL_FILES} ${WebCore_IDL_FILES} ${WebCore_SUPPLEMENTAL_IDL_FILES})
foreach (_shot_idl IN LISTS _shot_original_idl_files)
    if (NOT _shot_idl IN_LIST _shot_retained_idl_files)
        get_filename_component(_shot_idl_name "${_shot_idl}" NAME_WE)
        string(REPLACE "+" "\\+" _shot_idl_name_regex "${_shot_idl_name}")
        list(APPEND WebCore_UNIFIED_SOURCE_EXCLUDES "(^|/)JS${_shot_idl_name_regex}\\.cpp$")
    endif ()
endforeach ()
unset(_shot_idl)
unset(_shot_idl_name)
unset(_shot_idl_name_regex)
unset(_shot_original_idl_files)
unset(_shot_retained_idl_files)
