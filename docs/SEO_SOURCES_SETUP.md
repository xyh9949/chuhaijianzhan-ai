# 搜索数据接口配置

入口：**搜索优化 → 连接数据与接口**。AI统一在 **站点设置 → AI服务** 配置，业务中的快捷入口打开同一设置表单；连接Google或查询关键词本身不调用AI，不修改或发布网站。

## Google Search Console

1. 使用自己的Google Cloud项目，启用Search Console API，创建OAuth同意屏幕和**Web application**客户端。管理员自行维护项目、账号、测试用户或正式应用审核。
2. 在后台保存自己的Client ID与Client secret；密钥留空保留，明确清除才删除，不会回显。
3. 将后台显示的**完整回调地址**原样加入Google客户端的Authorized redirect URIs，例如`https://your-admin.example/api/seo/sources/gsc/callback`。本机开发使用后台实际显示的localhost/127.0.0.1与端口，不自行猜一个来源。公网部署使用HTTPS；Google要求回调地址与配置精确匹配。
4. 点击连接，前往Google登录并同意只读Search Console权限。系统使用固定Google端点、离线授权、PKCE和10分钟一次性state；没有申请写入、提交索引或管理资源权限。
5. 返回后台，从当前账号授权列表选择网站资源。URL前缀资源和`sc-domain:example.com`域名资源均使用Google返回的原始名称；不能填写未获授权的其他网站。
6. 主动选择日期、国家/设备过滤并同步。更换客户端、重新授权账号或所选网站后连接版本变化，旧报告明确标为历史，需重新同步，不能与新账号数据混用。

连接为当前独立实例的管理员共享配置，报告仅创建它的管理员可读。断开按钮只移除**本机保存的令牌与资源选择**，不删除网站或已保存报告，也不会替你远程撤销Google账号所有相关授权；如需彻底撤销，请在自己的Google账号第三方连接权限中移除本应用。

Google Web Server OAuth官方配置、回调匹配和离线refresh token说明见[OAuth文档](https://developers.google.com/identity/protocols/oauth2/web-server)。Search Console按网站当前授权读取，只有API密钥而没有用户授权，不能代替访问权限。

### 数据口径

- 本阶段读取Web搜索的page/query维度，最终数据`dataState=final`，日期按Google的`America/Los_Angeles`口径。最近日期可能尚未出现，不补成0。
- 每次最多两页，每页2500行，总5000行；达到应用上限会明确标记。即使正常读到最后一页，Google也只保证头部行，不保证全部搜索词；隐私省略、过滤和内部限制始终使报告属于部分覆盖。
- 行里真实的0点击/0点击率保留；无行结果是“本次没有返回行”，不是“网站流量为0”。不把可见行合计冒充网站完整总量。
- 平均排名是Google该范围内的统计值，不是某时某地固定的实时排名，不由模型补猜。API行为与范围见[Search Analytics query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)。

## 真实关键词指标

本批接入**DataForSEO Google Ads Search Volume Live**，使用你自己的API登录名与API密码，通常不同于网站登录密码。没有平台共享账号、默认余额或自动充值。

1. 保存自己的API账号/密码；留空保留，明确清除才删。保存配置不会调用付费查询。
2. 输入1–100个不同关键词、供应商国家/地区`location_code`和语言代码。美国2840和语言en是已核官方示例；其他地区和语言使用供应商官方列表的原始代码，接口接受安全的连字符/下划线标识格式不等于已验证供应商支持，不能把显示名称或其他平台编号直接当作可用项。
3. 可选查询日期范围；确认“可能消耗我自己的接口额度”后才发一次请求。不自动重试、换供应商或拆成隐藏的多次付费请求。网络失败也可能已被供应商计费，先核对账号记录再手工重试。

官方接口、字段及统计定义见[Search Volume Live](https://docs.dataforseo.com/v3/keywords_data-google_ads-search_volume-live/)，国家/语言可用项见[Locations](https://docs.dataforseo.com/v3/keywords_data-google_ads-locations/)与[Languages](https://docs.dataforseo.com/v3/keywords_data-google_ads-languages/)。本批不是任意SEO API的通用适配，也没有接入Google Ads开发者令牌接口。

`search_volume`是供应商基于Google Ads的**近似月均搜索量**，不是网站实得流量或实时Google查询次数。空值/null表示供应商未给数据，不能填成0。CPC币种USD；`competition`及`competition_index`只指付费广告竞争，不能标成自然搜索难度。月度细项和平均值不能与GSC实际点击/展现直接相加。报告保留国家、语言、请求或实际月度周期；供应商未提供时区或月度细项时明确说明，不猜一个统计周期。

## 已有关键词CSV

可以导入用户已有导出的标准CSV，最多2MiB/1000行，不调用AI或供应商。来源名称、公开来源网址、日期周期、国家和语言必填；来源链接不含账号、查询参数或片段。系统不联网认证人工声明的来源，所以报告会提示“来源和口径未联网验证”。

```csv
keyword,search_volume,cpc,competition,competition_index
wooden chair,0,1.20,LOW,5
project furniture,null,,,
```

`keyword`必须，其他列可省略或留空/null。0与缺失严格区分，重复词、错误列数和非法数值整批拒绝。CPC输入需是USD，不同币种先转换或留空；广告竞争只能LOW/MEDIUM/HIGH或空。CSV单元格仅当文字/数值读取，不执行公式。报告中的原CSV行号保留，方便回查。

## 私密、限制与维护

客户端密钥、API密码、access/refresh token及PKCE verifier使用实例固定secret派生AES-GCM加密；用途隔离，前端仅收到是否配置，不进入公开快照、整站包、AI提示或浏览器恢复。恢复完整实例必须保留原固定secret。完整数据库备份仍属私密资料。

数据源HTTP只允许固定官方HTTPS域，DNS固定目标、无重定向，DNS及正文共用30秒截止，每次回复4MiB；同步单实例并发1。每人100份报告、每份2MiB；付费请求前预留记录容量，失败仅清本次占位、不覆盖旧报告。进程中断的pending记录后续容量检查按5分钟清理。生成建议/应用内容有各自显式按钮，不因同步自动发送给AI。

删除报告只清该报告；已采用的内容或独立保存的优化建议不会回滚，其证据快照按优化记录自身期限保留。改变配置或断开不会把旧报告改写成新来源。

开发验收可由部署环境显式配置`FORM_STUDIO_SEO_MOCK=true`与仅loopback的`FORM_STUDIO_SEO_MOCK_ORIGIN`。该模式不访问真实接口，所有报告醒目标为模拟；网页没有自定义token URL或任意接口转发入口。只能使用合成账号和资料，不把真实凭据送模拟服务。正常部署不设置这些测试变量。

本批本机协议/模拟OAuth验收不能替代你的Google项目启用、同意屏幕审核、真实账号权限、供应商余额或业务数据质量；没有代你注册、授权真实账号或发起收费查询。升级后回归只读scope/state/PKCE/回调、令牌加密与刷新、配置版本绑定、覆盖/零值口径、费用确认、报告隔离及应用/撤销保护。
