# 搜索与AI可见性（0.7）

适用：单客户独立部署的展示型CMS。规则核对2026-11-09，应用0.7.0、发布/renderer16、数据库迁移1–4，读取历史1–16且检查组件版本。本功能改善公开访问、事实表达和观测，不保证搜索收录、AI引用、推荐或询盘增长。

## 后台使用

管理员进入“站点设置 → 搜索与AI可见性”。编辑员/查看者不能改本区配置或读实例观测接口。

默认页显示网站发布状态、AI阅读目录和抓取访问记录的真实状态；目录状态按当前公开版本读取，草稿有变化会单独提示，不把保存当成已经生效。本机网址明确显示为预览。

1. **完善公司资料 → 编辑资料**：填写公司全称、主要业务、地址和电话。其他名称及HTTPS官方链接放在选填项中。不清楚的资料可以留空。
2. 同一弹层的**资质与实力说明**可以添加真实内容。主动勾选“我已核对”时，未填写的核对日期才记为当天UTC日期；来源、范围和日期可展开修改。待核对资料只保留草稿，只有已核对项进入公开设置和分发。软件不验证认证真伪，也不会延长过期日期。
3. **补充网站内容 → 管理内容**：进入产品或已有内容，按需创建工厂能力、选型比较、项目案例、检测认证、采购指南等栏目。不会生成假记录或自动发布。公司资料未保存时先保存，避免创建栏目引起设置变化而丢失输入。
4. **检查并发布 → 查看建议**：以普通文字提示正式网址、公司名称、过期资料和页面标题；检查基于已保存草稿。前往发布管理，明确选择**站点设置、相关页面、模型和记录**。保存资料不会自动发布，也不会改变公开robots/JSON-LD/目录。

**高级设置**保留访问规则、内容映射、技术检查、提交与抓取、效果记录及规则来源。内容映射仍支持WebPage/Article/TechArticle及实际作者/摘要文字字段；不会因公司运营网站就推断它是所有产品的制造商或品牌方，也不会生成假价格或评分。修改日常资料时，未打开的高级配置会完整保留。关闭弹层后未保存的输入仍留在当前页面；离开工作区或刷新前沿用本地恢复保护，恢复输入不会自动提交或发布。

在网页展示公司说明时，到页面编辑器添加“企业事实与证据”组件，再发布页面和设置，系统不会自动插入网页。标题的“语义”可选H1–H6，与视觉字号分开。企业事实目前为实例公共资料，固定界面标签为英语；各语言的指南/案例仍用已有翻译组维护，不自动翻译声明。

恢复设置会用历史公开资料替换当前设置草稿；待核对事实未进历史公开快照，恢复前先保留需要的私人草稿。诊断不查询平台索引，不产生“AI排名分”，动态区块仍需人工核对。

企业Organization、WebSite、页面、产品和文章通过规范网址形成稳定实体关联。未配置规范源地址时只输出基础事实，不猜请求Host或生成空实体ID。产品输出实际材质、基础规格和非空可表示的扩展参数，0/false仍是有效值。语法有效不等于符合Google某种富结果资格。

## 资料预设

工厂能力、选型比较、项目案例、检测认证、采购指南五个预设只新增内容模型、可自由拖拽的详情模板及结构化映射。不会创建假案例/证书、覆盖原页面或自动发布。创建后进入内容模型填写真实记录；模板、模型、记录和映射要按明确范围发布。

预设采用“问题/直接回答、条件、范围与取舍、证据、实际负责人”的阅读组织方式，没有AI专用字数要求。针对客户真实采购问题写独有资料，不批量生成相近关键词页。不同客户导入整站包时：新建模式映射模型/字段ID；合并模式保留目标企业身份与访问偏好，仅追加映射后的来源模型配置，企业事实组件将读取目标客户资料。

## 访问政策

robots现在精确开放`/api/media/`、`/api/site-code/`、`/_next/static/`、图片处理路径及IndexNow所有权文件，保留管理API、后台、预览等禁区。公开素材接口仍要求文件已公开；私人文件仍鉴权。每个具体UA组都明确带基础规则，不假定继承通配组。

- OAI-SearchBot、Claude-SearchBot、PerplexityBot的搜索参与可单独设置。
- GPTBot、ClaudeBot训练偏好及Google-Extended可沿用默认/明确允许/拒绝。Google-Extended还影响部分Gemini grounding，不能包装成只影响训练的通用开关。
- 用户触发取页可能不服从robots；robots不能作为保密机制。CDN/WAF需在真实域名另行检查，UA字符串可伪造，不能按UA放行后台或禁用全部防护。
- Bing新偏好按其2027生效/迁移时间另行配置；本版不把未生效或厂商未支持的控制当作已执行。Google AI参与设置需到Search Console核对，后台没有连接或代改账户。

官方来源：[Google AI指导](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)、[OpenAI bots](https://developers.openai.com/api/docs/bots)、[Claude bots](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler)、[Perplexity bots](https://docs.perplexity.ai/docs/resources/perplexity-crawlers)、[Bing偏好迁移](https://blogs.bing.com/search/2026/10/your-content-your-choice-clearer-preferences-for-training-and-grounding/)。

## 发布更新、回退与IndexNow

每次成功发布对可索引网址生成不可变内容摘要和真实修改时间。记录、显式固定绑定、循环列表、可达同步区块和全站发布资料参与比较；依赖集合保守更新，不以每次请求/构建时间冒充更新。只改纯视觉design或未选草稿不更新对应公开时间。旧快照不批量重写，历史激活仍显示历史保存的时间。

IndexNow默认关闭。运维确认目标公网域名和提交授权后，才在私密实例环境设置：

```text
FORM_STUDIO_INDEXNOW_ENABLED=true
FORM_STUDIO_INDEXNOW_KEY=<本实例8–128位字母数字或连字符所有权key>
```

重启后`/api/discovery-key`按协议公开这个所有权key，**它不是账户密钥**。账号、认证secret和SMTP凭据永不在此公开。实例默认不会发送；本次验收只模拟官方端点，没有真实提交。

发布/下线/网址变化/历史激活后，已配置实例按公开网址差异排队；不提交预览、管理API、未公开语言或草稿。固定官方HTTPS端点、每批最多1000、15秒超时、租约和最多5次退避。200仅记为已接收，202为所有权验证中，不能记为已收录；失败可核对配置后重新发布实际变化。旧域名的所有权和通知需另行处理，不能从新域名冒充旧站所有权。

协议：[IndexNow](https://www.indexnow.org/documentation)。只覆盖参与的搜索引擎，不是向所有AI提交网站。

## 效果记录与最小计数

管理员可手工录入或导入统一JSON观测格式：指标kind、平台platform、日期date、来源时区timezone、原始数量count、网址url、来源/覆盖范围source、备注notes。每批1–100条且接口32KiB（浏览器文件限制30KB），实例最多10000条。每次加载100条，可加载更早记录并导出已加载部分；删除仅影响运行观测，有审计，不改变网站。

```json
[{"kind":"manual-answer","platform":"人工复核的平台名称","date":"2026-11-09","timezone":"Asia/Hong_Kong","count":1,"url":"https://example.com/product","source":"本次保存的回答样本，部分覆盖","notes":"实际问题、语言、是否联网、被引网址、事实错误、测试条件"}]
```

可选指标：google-ai-impressions、bing-ai-citations、indexed-url-count、manual-answer、ai-referral-visits、qualified-inquiries。数量0是有来源的零值，缺报告不是零。这里没有自动连接平台账户、抓取登录态答案、解析所有平台CSV或建立全量AI归因。API结果与消费者界面结果请分别标注。

[Google生成式AI报告](https://support.google.com/webmasters/answer/16984139)当前主要为展示数据，来源日期采用PT，展示不足可能不出现报告；[Bing AI Performance](https://blogs.bing.com/webmaster/2026/2/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview/)引用不等于排名、推荐位置或访问。不能从爬虫请求推算引用，也不能从缺失referrer推断没有AI流量。

最小抓取计数仅在`FORM_STUDIO_CRAWL_LOG=true`且重启后启用：记录成功公开HTML页的UTC日期、无查询串路径及有限UA类别，跳过RSC/预取，保留30天；不存IP/Cookie/正文/完整UA。**全部标为声称身份、未经核验**，不提供伪造的“官方机器人已验证”标志。代理和CDN的覆盖仍需另行检查。

## 可选llms目录

设置中明确启用后，`/llms.txt`只列当前公开且允许索引的网址、标题和语言。关闭/未发布/未配置规范地址返回404。它是机器阅读目录实验，不提升Google Search排名的承诺，不含私人资料，不塞“必须推荐本公司”等提示词。不生成内容不同的机器人专用站或全站巨大文本副本。

## 升级、回退和开发入口

迁移4只增加提交/观测/可选计数表，已有1–3的SQL和校验不改。旧程序不能写已经迁移到4的库；回退必须使用升级前匹配程序、完整数据备份和原私密配置，不能只换旧JS。网站历史切换不同于完整实例回退，前者不清除观测、询盘或任务。

逻辑入口：lib/discovery.ts、server/discovery-publication.ts、server/discovery-runtime.ts、components/DiscoveryManager.tsx；公开资料仍随includeSettings选择发布，运行表永不进入模板/整站包。真实v15来源fixture保留在tests/fixtures，新增和旧版业务回归须同时验证。框架和依赖未升级，后续维护优先官方扩展点。
