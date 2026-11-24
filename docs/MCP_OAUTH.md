# 外部 AI 的 OAuth 连接

实现 MCP HTTP 授权规范的一个受限子集：授权码、强制 S256 PKCE、精确回调、单个 MCP resource、显式后台同意、轮换刷新和撤销。保留原手工 Bearer 与 Skill，不增加自动采用或发布权限。SDK固定为1.32.2，本批不升级依赖，不宣称完整 OAuth 2.1 或所有客户端兼容。

依据 [MCP 2026-07-28 授权规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[RFC9700](https://www.rfc-editor.org/rfc/rfc9700.html)、[RFC6749](https://www.rfc-editor.org/rfc/rfc6749.html)。CIMD为推荐的资料发现方式，兼容有界动态客户端注册；CIMD客户端仅支持公共客户端认证 `none`，动态注册另支持 `client_secret_basic` 和 `client_secret_post`。不支持隐式流、密码流、自定义回调scheme、客户端凭据流、JWT客户端认证、自动step-up或服务器会话恢复。

## 连接过程

外部客户端从资源元数据和授权服务器元数据发现端点，提交自己的实际 client_id、回调、resource 和 PKCE。公开授权请求只创建10分钟待办，不使用Cookie直接授权，也不包含网站正文。管理员登录后台后核对自报名称、实际标识、回调和权限，明确选择页面、记录与详情模板范围。

同意后仅返回3分钟一次性授权码；必须带原 PKCE、原回调和精确 resource 兑换。access token有效1小时，refresh family总期限7天。刷新轮换会撤销旧access；旧refresh重放会原子撤销整个family，要求重新连接。后台撤销现行连接或OAuth撤销端点都能阻止后续访问，其他客户端不能撤销不属于自己的family。

OAuth生成的Bearer额外绑定本站完整 `/api/mcp` 地址，不能用于外部AI REST或其他API；原手工Bearer保持既有能力。账号过期、停用或失去管理员权限仍由每次机器请求与刷新重新核对。scope和原生页面／记录／模板ID白名单不能通过刷新扩大。

## 安全和隐私

- Cookie同意接口同源写入，等候正文及动态参数后复核真实会话，事务中再核对；登出或降权后不消费待办、不颁码。
- audience以当前配置的完整公开MCP地址、精确Host及无查询/片段的`/api/mcp`共同校验，兼容Next内部重建的localhost URL；缺失Host时仅接受公开来源本身。更换站点来源后原OAuth连接需要重新授权，不采信转发头来扩大入口。
- 公开OAuth端点不把Cookie当客户端认证；Basic、post和公共认证不能混用，重复参数与无效编码拒绝，所有返回禁止缓存。
- CIMD仅完整公网HTTPS路径；保守拒绝查询参数、账号、片段及首页路径。DNS全部结果必须公网，TLS连接固定到已检查地址，维持证书验证；不跟随重定向，最多64KiB JSON和10秒截止，不发送站点AI密钥。
- Node test仅能注入网络运输层，实际URL及DNS分类仍执行；没有HTTP、部署环境或后台开关能放宽私网限制。
- 明文授权码、access、refresh及客户端密钥不写数据库或审计；仅保存随机标识、摘要、范围及时间。客户端密钥只在注册回执返回一次。
- 客户端名称由连接方自行提供，后台不把该名称标成已验证公司；以实际标识、回调和用户明确取舍作为同意依据。

公开注册与授权待办各有500条有界上限及过期清理。公网部署的流量控制和客户端信任策略仍由部署方维护。OAuth颁发来源要求HTTPS，仅明确loopback允许HTTP；非loopback明文来源返回503，原手工Bearer行为保持。MCP传输维持既有同源或无Origin客户端策略，本批不额外开放第三方网页的MCP跨域运输。

## 验证

`tests/mcp-oauth.test.ts` 使用临时SQLite覆盖PKCE、精确回调/resource、范围、客户端认证、过期、降权、手工撤销、轮换重放、容量、私密字段及CIMD安全边界。

`tests/mcp-oauth-http.test.ts` 在随机本机HTTP端口运行生产OAuth/MCP handlers及真实BetterAuth，固定SDK实际完成发现、注册、PKCE、Cookie同意、兑换、MCP工具和刷新重放；另在真实正文/params异步等待中撤销会话，检查无颁码副作用。

`tests/ui/mcp-oauth.spec.ts` 由隔离UI包装器运行，核对默认最小范围、390px授权页、明确同意/拒绝和SDK MCP连接。浏览器测试客户端仅截获自己的同源回调接收页，不改OAuth、MCP或认证响应；不调用模型或公网服务。
