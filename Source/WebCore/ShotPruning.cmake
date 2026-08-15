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

set(_shot_js_only_module_regex "(webdatabase|websockets)")

foreach (_shot_idl_list
    WebCore_NON_SVG_IDL_FILES
    WebCore_IDL_FILES
    WebCore_SUPPLEMENTAL_IDL_FILES
)
    if (DEFINED ${_shot_idl_list})
        list(FILTER ${_shot_idl_list} EXCLUDE REGEX "(^|/)Modules/${_shot_js_only_module_regex}/")
    endif ()
endforeach ()

# WebSocket and CloseEvent remain an internal ABI closure: core Event and
# EventTarget factories still name these wrappers even though no page script can
# reach them. WebSQL's generated bindings are removed. IndexedDB was deliberately
# retained because worker/structured-clone/inspector code has a broad internal
# closure; removing that closure produced no linked-size win under LTO.
set(_shot_internal_idl_files
    Modules/websockets/CloseEvent.idl
    Modules/websockets/WebSocket.idl
)
list(APPEND WebCore_NON_SVG_IDL_FILES ${_shot_internal_idl_files})
list(APPEND WebCore_IDL_FILES ${_shot_internal_idl_files})

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
unset(_shot_internal_idl_files)
unset(_shot_js_only_module_regex)

# 退化绑定二期 2b：degenerate-bindings.txt 中标记 strip-custom 的接口，其
# 生成代码已剥掉接口级 Custom* 扩展属性、不再引用手写 Custom 绑定；这里把
# 对应 JS*Custom.cpp 排除出编译（两处清单必须同步维护，见
# shot/degenerate-bindings.txt）。
set(_shot_strip_custom_bindings
    bindings/js/JSDocumentCustom.cpp
    bindings/js/JSElementCustom.cpp
    bindings/js/JSHistoryCustom.cpp
    bindings/js/JSMessageEventCustom.cpp
    bindings/js/JSPopStateEventCustom.cpp
    bindings/js/JSNavigatorCustom.cpp
    bindings/js/JSXMLHttpRequestCustom.cpp
    bindings/js/JSKeyframeEffectCustom.cpp
    bindings/js/JSShadowRootCustom.cpp
    bindings/js/JSIDBCursorCustom.cpp
    bindings/js/JSIDBCursorWithValueCustom.cpp
    bindings/js/JSIDBRequestCustom.cpp
    bindings/js/JSIDBRecordCustom.cpp
    bindings/js/JSWorkerGlobalScopeCustom.cpp
)
list(REMOVE_ITEM WebCore_SOURCES ${_shot_strip_custom_bindings})
foreach (_shot_custom IN LISTS _shot_strip_custom_bindings)
    get_filename_component(_shot_custom_name "${_shot_custom}" NAME_WE)
    # 不加 $ 锚：Sources.txt 条目可能带 @cost 等注记，排除匹配的是原始行。
    list(APPEND WebCore_UNIFIED_SOURCE_EXCLUDES "(^|/)${_shot_custom_name}\.cpp")
endforeach ()
unset(_shot_custom)
unset(_shot_custom_name)
unset(_shot_strip_custom_bindings)

# Document 家族的生成 toJS 调用 JSDocumentCustom.cpp 中的两个自由函数
# （cachedDocumentWrapper/reportMemoryForDocumentIfFrameless）；该 TU 已被
# 排除，改由 Shot 专属文件原样提供。
list(APPEND WebCore_SOURCES bindings/js/JSDocumentWrapperCacheShot.cpp)
