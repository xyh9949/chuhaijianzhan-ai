# 资料导入增强（0.33）

本文补充并替代0.14阶段文档中“无本地OCR、不保留原件、不抽图、不做多来源合并”的旧限制。已有文字层PDF、Excel显示格式/公式缓存、隐藏范围、产品原子导入和BYOK企业资料整理均沿用。

## 实现入口

- `ai-source-enhance-files.ts` / `ai-source-enhance-worker.ts`：可终止离线worker；PDF.js渲染只供OCR，Tesseract.js使用固定本地eng/chi_sim训练数据；ExcelJS读取真实drawing锚点，Sharp校验和重编码真实嵌入图。
- `ai-source-private.ts`：数据目录 `private/ai-sources/<actor SHA256>/<server source UUID>/`。固定文件名、UUID和目录边界校验，原文件名和邮箱不参与路径。原件及图片从不写入公开media记录，明确采用单张才调用原`uploadMedia`。
- `ai-source-enhance.ts`：本人管理员、来源期限/原件hash、解析后权限与会话回调、并发后改保护、缩略图和采用回执。
- `ai-source-merge.ts`：复用`cms_ai_source.kind='brief'`，operation区分证据和预览；多个来源hash冻结、字段策略、精确表单patch和撤销回执。无新增数据库表、无新模型或自动发布动作。
- `AiSourceEnhance` / `AiSourceMerge`：原资料导入入口内的渐进式Ant Design流程，无新增后台顶级菜单。

## API

所有写入要求同源、管理员和当前会话；异步body/params完整读取后复查，worker解码/素材解码结束与最终写事务内再查。服务本身还直接查询当前账号角色、停用状态和本人来源归属。

| 路径（相对`/api/ai/sources`） | 动作与返回 |
| --- | --- |
| `/:id/enhance` POST | `{pageNumbers?,ocr,images,language}`；PDF最多5页，Excel只抽图；返回更新的私有SourceRecord |
| `/:id/file` GET | 本人鉴权附件下载原件以核对；no-store、nosniff、sandbox，不内联执行文档 |
| `/:id/images/:imageId` GET | 本人鉴权640px以内WebP缩略图，无公开缓存 |
| `/:id/images/adopt` POST | `{imageId,expectedRevision}`；返回StudioEnvelope、media和更新source；同一次失联采用按真实重编码hash恢复，不重复入库 |
| `/:id/preview` POST | 旧产品预检增加可选`rowImages:[{row,imageId}]`；只接受本来源已采用且当前素材仍存在的图片 |
| `/merge/prepare` POST | `{baseBrief,selections}`；最多5文件，明确页/工作表行；返回带出处、OCR说明的证据，未选/隐藏数据不进入 |
| `/merge/preview` POST | `{evidenceSetId,choices}`；逐字段keep/ignore/replace/append，返回前后表单和原文证据 |
| `/merge/:id` GET | 本人只读恢复证据或预览；预览含choices/evidenceSetId，不自动采用或再调用模型 |
| `/merge/confirm` POST | `{previewId,currentBrief}`；来源和表单冻结校验后返回精确patch；只回填原建站表单 |
| `/merge/undo` POST | 同上；本次字段后来未改才可回退，保留其他字段手改 |

扫描识别稿的`page.ocr`始终有`needsReview:true`、语言、0–100识别置信值和时间；`originalText`保留原文字层，`text`供既有查看/整理流程使用识别文字。置信值是识别器的输出，不能当事实正确率。单份BYOK整理若含OCR也额外提示核对名称、数字和单位。

图片metadata包含真实PDF页/对象编号，或Excel表/行/列/隐藏范围。`possiblePageScan`只是宽高比提示，不证明是产品图。页面渲染图绝不放入images返回值；不将全部PDF视觉元素声称为已完整提取。

## 资源与私有期限

原上传限制仍为10 MiB、PDF100页/15万字、XLSX10表/1000非空行/64列、ZIP展开与压缩比预检。增强只处理已经过原上传验证且hash匹配的私有原件。

- 同实例资料解析/增强共享一个并发位；关闭/取消/超时等待终止worker后才释放。
- PDF每次1–5页；OCR渲染单页600万像素以内、长边2600，逐页处理，单页识别文字最多30000字，总PDF文字仍最多150000字。
- 90秒看门狗；主worker与Tesseract子worker各384 MiB V8堆，原生画布/WASM不计入该堆。进程RSS增量超过512 MiB时保守停止本次任务（其他并发工作可能触发保守拒绝），部署仍需容器/服务总内存上限；不是操作系统沙箱保证。
- 真实嵌入图单张600万像素/2 MiB、本次最多40张/24 MiB、来源累计80张；超限或不支持格式明确给未提取说明。PDF绘图指令检查最多20000项；XLSX图片引用最多100项。普通未知URL不探测、不下载。
- 本人原件+图片暂存总80 MiB。来源读权限2小时到期，后续本人主动写操作回收过期物理目录。不是准点物理擦除；实例私密备份可能保留历史资料。
- 多来源一次最多80段/64000字符，PDF长页按连续原文分片，不将截取前缀冒充完整页面。来源或表单后改拒旧采用；确认回执保留7天可安全撤销。删除来源撤回含该来源的未确认合并，已确认回执继续用于撤销与回查。

Tesseract训练数据由固定依赖复制到本次临时目录，终止后清理；禁用缓存写入和CDN，主/子worker的fetch/http/https均阻断，PDF求值/远程字体/文档链接也不触发请求。不得改依赖源码或让用户提供语言包路径。

## 验证与升级

本机测试使用临时SQLite和合成文档，不接正式库、不调用真实AI。新增`ai-source-enhance-files`5项测试实际执行英/中英OCR、PDF位图、跨页共享图、XLSX锚图和取消；`ai-source-enhance`4项覆盖私有原件/图片、fresh权限、采用幂等/失联恢复、行级配图和公开隔离；`ai-source-merge`6项覆盖真实选择范围、零值、隐藏排除、冲突策略、冻结/回填/撤销、后改保护、完整长页分片和删除来源的派生撤回。原资料相关测试也须继续通过。

`tests/fixtures/source-ocr-en-zh.png`是仓库生成的虚构公司文字位图，供Windows/Linux同一真实扫描识别测试，不依赖容器安装中文字体。UI回归`ai-source-materials.spec.ts`覆盖扫描识别→私有审阅→明确入库→行级配图→多源合并对比→确认→撤销，以及手机宽度与无自动AI/发布调用。未执行环境必须按实际结果另记，不以存在测试代码冒称通过。

固定版本与许可证由项目锁文件和依赖清单统一维护。升级PDF.js/ExcelJS/Tesseract/Canvas/Sharp后回归以上真实格式、中英识别、离线依赖、取消、资源拒绝和Linux运行。Next生产追踪需包含Tesseract及训练数据、原生Canvas和worker运行依赖；父项目统一配置外部包与追踪。回滚按同版本源码/私有数据备份在隔离环境验证，不能用旧数据库覆盖新业务数据；移除增强UI/API不影响已采用的普通素材、产品或可编辑页面。
