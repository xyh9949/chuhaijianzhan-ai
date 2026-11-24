# 认证、权限与维护

更新：2026-11-13。本文对应当前代码与锁文件：Better Auth 1.7.18、better-sqlite3 13.0.3、Next.js 16.4.5；本机验证环境为 Node.js 22.15.0。本文描述单站独立部署，不涉及多租户或第三方账号。

## 当前实现与边界

- 认证入口在 `src/server/auth.ts`，使用 Better Auth 的邮箱密码、密码哈希、签名 Cookie 与数据库会话；没有自造密码或会话协议。
- 账号表为 `auth_user`、`auth_account`、`auth_session`、`auth_verification`；与 `cms_*` 表共享 `FORM_STUDIO_DATA_DIR/studio.sqlite`。这些表属于运行数据，网站发布、切换历史发布和恢复页面草稿不恢复账号、密码或会话。
- 密码长度为 12–128 个字符。公开注册、改邮箱、自助删除账号均关闭；认证 HTTP 路由采用白名单，`/api/auth/admin/*` 不对外暴露。成员管理只经本项目受权限保护的 `/api/members` 路由执行。
- 会话保存在 SQLite，默认有效期 7 天、更新间隔 1 天；持久 Cookie 为 HttpOnly，HTTPS 配置启用 Secure。Cookie 缓存关闭；受保护业务接口每次查询当前账号角色和停用状态，重启应用不会单纯因为进程重启而丢失有效会话。
- SMTP 由站点设置统一配置，已支持邮件恢复密码及受控本机恢复；询盘通知关闭时，完整 SMTP 仍可发送恢复信。未启用邮箱验证、MFA 或第三方登录。创建成员是直接建立账号，不是发送邀请。
- 认证 POST 请求体上限为 64 KiB，成员 JSON 为 32 KiB；读取时按流累计限制，不能只靠 Content-Length。认证和成员响应使用 `Cache-Control: no-store`。

## 角色与授权

| 能力 | admin 管理员 | editor 编辑者 | viewer 查看者 |
| --- | --- | --- | --- |
| 登录、查看后台内容 | 可以 | 可以 | 可以 |
| 编辑内容、上传素材等 `edit` 操作 | 可以 | 可以 | 不可以 |
| 正式发布与切换线上版本 `publish` | 可以 | 不可以 | 不可以 |
| 管理成员等 `manage` 操作 | 可以 | 不可以 | 不可以 |
| 提供当前密码后修改自己的密码 | 可以 | 可以 | 可以 |

权限最终由服务端 `requireActor`、`requirePermission` 决定，隐藏按钮不能代替鉴权。账号停用后不能登录。修改成员角色或停用状态会在同一 SQLite 即时事务内更新账号并撤销该成员所有会话；本人降权也会退出，重新登录后按新权限使用。

最后一名可用管理员不可降权或停用；检查和更新使用同一写事务，已验证两个管理员并发停用仍保留一名。该约束适用于本项目 API，不防止持有数据库写权限的人直接修改数据。

管理员可重置其他成员密码；密码写入通过库的 `setUserPassword`，随后撤销该成员全部会话。二者是顺序操作，不宣称跨认证库调用和 SQL 撤销构成单个事务；若接口报错，需核查密码是否已改变，避免盲目重复。管理员修改自己的密码必须使用“账户安全”并提交当前密码；当前界面同时撤销其他设备会话。

## 初始化和迁移命令

以下命令在 Form Studio 源码根目录执行。服务器使用锁文件安装依赖，确保 better-sqlite3 原生模块与目标系统和 Node 版本匹配。

```powershell
npm ci
npm run setup
```

`setup` 首次生成随机持久密钥并保存到 `.env.local`，提示输入管理员邮箱和不回显的密码，显示名默认“管理员”。只在账号表为空且取得本机初始化锁时，经 Better Auth 服务端 `createUser` 创建首管理员。重复执行保留已有账号，不重置密码，也不补建管理员。

默认配置：

| 配置 | 默认或要求 |
| --- | --- |
| `BETTER_AUTH_URL` | `http://127.0.0.1:3200`；部署时设为实际 HTTPS origin |
| `BETTER_AUTH_SECRET` | 首次随机生成；运行时必须已存在且至少 32 字符，禁止临时自动生成 |
| `FORM_STUDIO_DATA_DIR` | 初始化时写入项目 `data` 的绝对路径；应指向独立持久目录 |

无人值守初始化可由受保护的进程环境注入 `AUTH_SETUP_EMAIL`、`AUTH_SETUP_PASSWORD`，可选 `AUTH_SETUP_NAME`。密码不作为命令行参数、不写入配置、不打印；启动流程结束后应清除部署工具中的临时环境变量。不要把真实密码写进脚本、工单、终端历史或分发包。

只执行迁移、不创建或改动账号：

```powershell
npm run setup -- --migrate-only
```

使用指定配置文件的精确参数是 `--setup-env-file`，不是 Node 自带的 `--env-file`：

```powershell
npm run setup -- --setup-env-file "C:\path\to\instance.env" --migrate-only
```

该参数只决定 **setup 脚本**读取/保存的位置；启动 Next 时仍需由进程环境或 Next 支持的环境文件提供相同配置，不会自动记住外部文件路径。已有进程环境优先于文件；若环境中的 secret 与文件里的 secret 不同则报错，防止无意轮换密钥。部署前还需核对 URL 与数据目录，避免迁移到另一份库。

迁移调用官方 `getMigrations(auth.options).runMigrations()`，不在普通请求中自动升级认证表。首次建库会同时建立项目 `cms_*` 基础表。迁移前必须备份；若库报告不安全 schema 变化，保留错误并制定显式迁移，不通过删表重新初始化解决。

setup 使用数据目录下 `.auth-setup.lock` 互斥，完成后关闭连接并移除锁。异常退出可能留下锁；先确认没有初始化进程，再由维护人员移除残留锁，不能并发强行初始化。

## 部署来源、Cookie 与限流

部署配置必须使用精确 origin，例如 `https://admin.example.com`；不接受路径、账号密码、query 或 fragment。`trustedOrigins` 当前仅包含该配置 origin。所有受保护写入及认证 POST 都要求 `Origin` 与配置值完全相同；`localhost` 与 `127.0.0.1`、HTTP 与 HTTPS、不同端口均不是同一来源。无 Origin 的脚本请求会收到 403，不能为方便测试而关闭校验。

生产 HTTPS 由可信反向代理终止时，`BETTER_AUTH_URL` 仍填写外部 HTTPS 地址，使 Cookie 带 Secure。代理应将浏览器同源的 `/api` 请求转发到应用，保留 Cookie、Set-Cookie 和 Origin，不缓存认证与后台响应。切换域名或协议后应重新登录。不要用客户端 Host 动态扩展 trustedOrigins，也不要设置通配来源。

当前限流为内存存储：默认每路径每 IP 60 秒 100 次，邮箱登录 60 秒 10 次；重启会重置限流记录。未设置专门的 `advanced.ipAddress` / `trustedProxies`。Better Auth 默认可采用单值 `x-forwarded-for`，而无可识别 IP 的请求退到共享路径桶；直接暴露允许伪造转发头的后端不能据此宣称可靠按真实 IP 限流。

正式部署需使后端只接受受控代理访问，由代理覆盖外部传入的 IP 头，并按实际代理地址配置官方 IP 选项。`trustedProxies` 只解释转发链，不能验证直接发送方；需同时验证伪造头不会绕过限流、不同真实用户不会全部共用限流桶。现有本地测试没有完成具体服务器的代理与公网防护验收。

运行要求为一个 Node 应用实例和可写持久磁盘；不支持静态导出、Edge Runtime、无持久磁盘的临时函数或把 SQLite 文件放进静态 public 目录。当前 npm 启动命令监听 `127.0.0.1:3200`；公网部署由服务器代理接入，不需要把数据库或媒体目录直接开放为可执行资源。

## 备份、恢复与升级

项目已有 SQLite 在线备份脚本，包含已提交的 WAL 数据及媒体文件：

```powershell
node scripts/backup.cjs
node scripts/backup.cjs "C:\path\to\new-backup-directory"
```

默认输出到 `backups/<时间戳>`；目标目录必须不存在且不得位于数据目录内部。脚本写出 `studio.sqlite`、可用的 `media/` 与 `BACKUP.json`，**不包含**环境配置、认证密钥、应用源码或锁文件。不要在应用运行时只复制 `studio.sqlite` 主文件，因为启用 WAL 后最新提交可能仍在日志文件中。媒体备份依赖当前“文件不覆盖、不物理删除”的实现；以后更改素材清理策略时必须重新设计一致性边界。

每个可恢复备份集还应安全保管匹配的 `BETTER_AUTH_SECRET`、URL/数据目录配置、源码版本、锁文件和迁移说明。密钥与含密码哈希/会话的数据库属于敏感资产，使用限制访问且加密的备份存储，不能与公开源码包一并发送。`.env.local` 创建时申请 0600 权限；Windows 上仍需用目录 ACL 确保仅运行/维护账号可读，不可把该模式位当作完整访问控制。

恢复时先停应用，把备份还原到新的独立数据目录，配套使用匹配密钥与代码版本，重新配置该目录后再启动验证；不要把旧 WAL/SHM 混入还原库。当前没有一键数据库恢复接口或自动降级迁移。恢复后应验证登录、管理员数量、权限、媒体引用与发布内容，并安排撤销旧会话。旧数据库可能重新带回备份时的密码、停用状态和仍有效会话，不能把“数据库已恢复”理解为“账号安全状态已同步至最新”。

网站发布回滚仅切换网站快照，不能撤销认证数据库升级。升级前备份并在独立副本执行迁移和回归；至少测试已有账号登录、已有有效会话、停用/降权即时生效、最后管理员保护、改密/重置、Origin、Cookie 与请求体限制。当前成员规则直接使用 `auth_user` 的 role/banned/banExpires/updatedAt 和 `auth_session.userId`，升级 Better Auth 时必须核对这些 schema 与官方 API；不修改 node_modules 作为持久方案。

如升级失败，停服务后使用配套旧代码与升级前完整备份恢复到独立目录；不能直接用旧代码打开已做不可逆迁移的新库。运行时不会自动轮换 secret；确需轮换时单独制定会话失效与恢复计划。

## 忘记密码与首管理员丢失

登录页可申请邮件恢复，复用 Better Auth 官方一次性密码恢复，链接有效15分钟；成功后撤销该账号全部旧会话，要求重新登录。未知邮箱、停用账号、SMTP 未配置或投递失败使用相同泛化回执，不承诺发送成功。申请通过 Next `after` 在响应后投递，进程异常退出可能丢信，可稍后重试。链接只来自配置的可信 origin，不接受外部 redirect。

另一名可用管理员也可以在成员管理中重置目标成员密码。SMTP 不可用或唯一管理员丢失密码时，维护人员可停服后在项目根目录运行 `npx tsx scripts/auth-recover.ts --port 3200 --acknowledge-stopped`，核对既有配置及管理员邮箱，隐式输入密码；命令先完整备份，再经原生申请/重置 API 恢复既有且未停用的管理员。不会新建、提权、解禁、直接写哈希或伪造会话。端口检查及 CLI 互斥锁不代替真正停服，维护人员必须核对实际实例和端口。重复 setup 不会恢复已有账号。

完整操作、接口、维护窗口、投递及升级边界见 [账号恢复与本机维护](ACCOUNT_RECOVERY.md)。备份自身不能找回未知明文密码，仍应安全保存凭据与匹配认证密钥。

## API 与验证入口

| 接口 | 用途与边界 |
| --- | --- |
| `POST /api/auth/sign-in/email`、`sign-out` | 登录、注销，由库写入/清除会话 Cookie |
| `GET /api/auth/get-session`、`list-sessions` | 当前会话、本人会话列表 |
| `POST /api/auth/change-password` | currentPassword/newPassword，界面传 revokeOtherSessions=true |
| `POST /api/auth/revoke-session`、`revoke-sessions`、`revoke-other-sessions` | 本人会话撤销，参数遵循 Better Auth |
| `POST /api/account-recovery/request` | 同源 `{ email }`，正常情况统一泛化回执，响应后查询并投递 |
| `POST /api/account-recovery/reset` | 同源 `{ token, newPassword }`，一次性重置、撤全部旧会话、不自动登录 |
| `GET /api/members/me` | 返回当前 `{ actor: { id, name, email, role } }` |
| `GET /api/members` | 管理员获取成员列表，不返回哈希或令牌 |
| `POST /api/members` | 管理员提交 name/email/role/password 创建成员 |
| `PATCH /api/members/[id]` | 管理员提交 name/role/disabled 中的字段；最后管理员保护 |
| `POST /api/members/[id]/password` | 管理员提交 password，不能用于本人改密 |

未登录或已失效返回 401，无权限/来源错误返回 403，最后管理员冲突返回 409，请求体过大返回 413。HTTP 状态由服务端判断，客户端必须处理失败，不能先展示成功再忽略返回结果。

```powershell
npx tsx scripts/auth-smoke.ts
npm run typecheck
```

认证 smoke 使用 `../work/auth-smoke-*` 随机临时目录、随机密码和随机密钥，不读取或修改真实 `.env.local` / data。覆盖初始化幂等、日志无密码/密钥、跨进程会话、来源/公开注册拒绝、角色限制、并发最后管理员保护、撤销/停用/改密、请求体上限。输出仅测试结果与临时目录，不输出密码、Cookie 或 secret；测试目录仍含敏感测试数据库/密钥，不应放入分发包。该测试是服务端契约回归，不等于浏览器端、真实代理、公网部署或完整安全审计。

维护参考：[Next.js 集成](https://better-auth.com/docs/integrations/next)、[邮箱密码](https://better-auth.com/docs/authentication/email-password)、[会话](https://better-auth.com/docs/concepts/session-management)、[管理员插件](https://better-auth.com/docs/plugins/admin)、[数据库迁移](https://better-auth.com/docs/concepts/database)、[限流与代理 IP](https://better-auth.com/docs/concepts/rate-limit)。实际行为还需以项目锁定版本源码与回归结果为准。
