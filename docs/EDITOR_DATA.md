# 响应式编辑数据与升级

页面根属性及每个组件的 `props.design` 使用相同结构：`{ desktop: {}, tablet: {}, mobile: {} }`。未设置的属性按桌面 → 平板 → 手机继承；平板断点为站点容器宽度不超过 1024px，手机为不超过 700px。删除某项覆盖会重新继承上一级；`backgroundImage: ''` 是明确清除背景图片。

属性类型、范围、选项和安全图片路径以 `src/lib/responsive-style.ts` 的 `DESIGN_FIELDS` 与 `validateDesign` 为唯一规则来源。服务端保存和发布均验证根节点与所有嵌套组件，design 字段不接受任意 CSS 字符串、未知属性、未知断点或外部背景图片。现有 `content` 插槽和旧版 `zones` 继续递归检查标识、数量和深度。

不含 `design` 的原页面继续使用原有组件属性，无需批量重写或数据库迁移。新结构作为页面 JSON 的可选扩展写入草稿与不可变发布快照，0.3 快照 `schemaVersion` 为 1，0.4 新发布版本为 2 并继续兼容 1。选页发布不会携带未选页面的样式更改；切换线上版本不修改草稿；恢复选中页面草稿会完整恢复其断点覆盖。

根节点及全部断点中的 `backgroundImage` 都计入素材依赖，即使该图片当前被较小断点覆盖或组件隐藏，也不能从草稿素材库直接删除。发布时检查素材元数据与实际文件；历史快照引用的文件继续保留，恢复页面时能重新加入素材库。空字符串不视为引用。

升级前备份数据库、媒体和应用源码。在独立实例中验证旧页面渲染、嵌套布局、三端继承、保存重载、选页发布、版本切换和历史素材恢复，再替换应用。不要用旧版应用打开含新样式的客户实例后再次发布：旧版渲染器不能理解新样式；回退应用时使用对应应用版本和数据备份。

验证入口：`npx tsx --test tests/editor-validation.test.ts`，测试只使用系统临时目录中的独立 SQLite 实例，不读写正式 `data/`。

0.4 的自由 CSS/JS 使用独立管理员字段 customCode，不混入 design。同步区块通过 SharedBlock 节点引用，全站头尾绑定 siteLayout；数据契约见 GLOBAL_DESIGN.md。

0.5 增加 contentModels / contentEntries 与产品扩展值。组件 bindings 及 root.props.bindingContext 保存动态数据来源，ContentList 保存字段映射。新快照版本 3 继续读取 1/2；模型和记录须显式选择发布。详见 CONTENT_MODELS.md。

0.6 的内容详情页由 PageItem.contentModelId 关联模型，ContentEntry.slug 指定可选短路径；ContentLoop.itemBlockId 引用 SharedBlock 卡片模板。运行时逐记录传入当前项并隔离节点样式 ID，编辑器在单卡画布调整结构。新快照版本 4 兼容 1/2/3。详见 CONTENT_TEMPLATES.md。

0.8新增自由面板：Tabs/Accordion 的 items[].content 与 Carousel 的 slides[].content 使用 Puck 原生数组 slot。panelMode=free 明确区分新版排版；旧 body/images 保持原样，用户主动转换才生成可编辑子节点。新发布协议17继续读1–16，SQL迁移仍1–4。图层、复制、预算、素材依赖和高级定位同时遍历所有内容插槽，详见 BUSINESS_BLOCKS.md。

0.9新增原生产品图片：Product.images为可选有序URL数组，最多20张且不重复；image必须与首张一致。字段缺失时读取原image作为单图，显式空数组表示清空，不能恢复旧封面。新发布/renderer18，读取1–18，SQL仍1–4，无批量数据重写。ProductDetail多图按相册渲染，图库尺寸/适应方式沿用三端design；引用、发布、恢复、分发与结构化资料覆盖全部图片。数据及验收见PRODUCT_IMAGES.md。

## 0.10的排版正文与兼容

应用0.10.0新发布快照/renderer为19，继续读取1–19，数据库迁移仍1–4。`ContentEntry.richTextFields?: Record<fieldId, RichNode>`为可选格式副本，只能对应当前内容模型中的`textarea`字段；模型类型与原字段ID保持不变，不把已有字段迁成新类型。打开旧记录时，只在编辑器内按原文字生成显示用文档，不改写草稿或历史快照。

`customFields[fieldId]`始终保存严格等于`richTextPlainText(doc)`的字符串，供搜索、SEO、查询和普通文本绑定使用；有排版副本时必须存在这份字符串，即使图片正文的投影为空也要保留`''`。投影按块间双换行组合，`hardBreak`为单换行；图片只计入下方说明，不把替代文字或素材URL混入正文。`richTextHasContent`将图片本身视为有效内容，表单不能因为纯文本为空而丢弃图片正文。

排版文档为受控JSON：允许段落、H2/H3、文字、列表、引用、换行与本实例图片，以及粗体、斜体、下划线和安全链接。图片`attrs`为`src/alt/caption/width/align`；宽度只允许25/50/75/100，对齐只允许left/center/right。普通文本节点不能携带任意HTML、样式或事件。校验、纯文本投影与有内容判断以`lib/presentation-content.ts`为准，图片仍经过原素材类型、文件和权限检查。

原`Text`组件绑定该多行文本字段时，运行期优先安全渲染排版副本；详情页、共享区块及循环卡片复用同一绑定记录解析，不需要重建旧模板。标题/其他普通文本用途仍取纯文本。正文内图片进入引用、删除保护、所选发布、历史版本、恢复和整站分发；分发同时映射排版字典的字段ID、图片地址及站内链接。

已有非空排版副本的文章，整条更新时省略`richTextFields`会返回422，防止不认识新字段的旧客户端悄悄丢格式。明确提交`richTextFields:{}`才表示清除全部排版，之后仍需提交所需普通文字。历史版本的显式恢复沿独立恢复流程处理。原CSV/JSON字段映射导入仍是普通文本；完整排版通过整站分发保留。

旧18程序不能读取19发布快照，也不能正确编辑新排版数据。升级前保留匹配的程序构建、配置及完整实例备份；回退先备份当前资料，再选择兼容程序或独立恢复目标，不直接用旧备份覆盖后来新增的文章与图片。用户操作、维护验证入口与本轮进度见[ARTICLE_WRITING.md](ARTICLE_WRITING.md)。
