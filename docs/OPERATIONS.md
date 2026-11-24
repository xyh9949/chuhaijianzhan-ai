# 安装、运维与完整实例恢复

正式交付路径为Linux amd64容器、一个Node写服务、本地持久磁盘、宿主HTTPS反向代理。Windows保持本地开发/预览，不承诺Windows生产运维。不要把SQLite放网络共享盘或启动多副本。每客户一份数据、配置、备份目录和独立来源地址。

自动截图需要浏览器及系统库；需要交付此功能时，可在下方构建命令中加 `--target runtime-browser`。默认镜像使用手工预览。浏览器、缓存路径与内部来源见[视觉检查部署](AI_VISUAL_REVIEW.md#部署浏览器)。当前数据库及发布协议以[部署说明](../DEPLOYMENT.md)开头所列版本为准。

Dockerfile基础Node22镜像固定摘要，依赖使用锁文件npm ci；容器保留tsx和源码用于认证迁移，不在线安装组件。更新摘要或锁文件后需重建并重验。依据：[Docker镜像固定建议](https://docs.docker.com/build/building/best-practices/)。

## 从零安装

以下在源码目录执行。镜像仅构建于本机，不推送镜像仓库。路径、域名、镜像标签和端口按客户修改。

```bash
docker build -t form-studio:customer-v1 .
export INSTANCE_ROOT=/srv/form-studio/customer-a
sudo install -d -m 700 -o 1000 -g 1000 "$INSTANCE_ROOT" "$INSTANCE_ROOT/data" "$INSTANCE_ROOT/config" "$INSTANCE_ROOT/backups"
# 首次交互初始化；不提供通用密码，不在命令行里写密码。
docker run --rm -it \
  --mount type=bind,source="$INSTANCE_ROOT/data",target=/data \
  --mount type=bind,source="$INSTANCE_ROOT/config",target=/config \
  --env BETTER_AUTH_URL=https://example.com \
  form-studio:customer-v1 flock --nonblock /data/.instance.lock \
  node --import tsx scripts/setup.ts --setup-env-file /config/instance.env
```

setup 生成固定随机密钥、迁移业务与认证表，并询问管理员邮箱和密码。新实例从 Home 空白草稿开始。需要合成演示草稿时，可用 --demo-draft 或从后台选择三个可编辑整站案例。初始化保留已有草稿和账号。非交互部署使用短期 AUTH_SETUP_PASSWORD 环境变量，运行后移除。

在客户实例目录中保存专用 `customer.compose.env`。真实密钥只存于 `config/instance.env`。同机每家的 Compose 项目名、目录、端口和域名都应独立。项目名使用小写字母、数字、连字符或下划线，以字母或数字开头，安装后一直沿用。

```text
COMPOSE_PROJECT_NAME=form-studio-customer-a
INSTANCE_ROOT=/srv/form-studio/customer-a
FORM_STUDIO_IMAGE=form-studio:customer-v1
LOCAL_PORT=3200
```

```bash
# 在源码目录执行。新开 Shell 后，为目标客户重新设置变量和函数。
CUSTOMER_COMPOSE_ENV=/srv/form-studio/customer-a/customer.compose.env
customer_compose() {
  env -u COMPOSE_PROJECT_NAME -u INSTANCE_ROOT -u FORM_STUDIO_IMAGE -u LOCAL_PORT \
    docker compose -f deploy/compose.yaml --env-file "$CUSTOMER_COMPOSE_ENV" "$@"
}
customer_compose config --format json
customer_compose up -d --no-build
curl --fail http://127.0.0.1:3200/api/health
```

首次启动前核对解析结果的 `name`、三个挂载源和本机端口是否属于目标客户。之后备份、升级、回滚与停机都复用同一个项目名和环境文件。上面的函数把四个参数限定为所选文件中的值，避免当前 Shell 导出的其他客户参数覆盖该文件。

健康接口仅给ready/unavailable，不给内部配置或客户信息。配置、初始化、数据库或权限失败返回503。应用只映射本机端口，默认非root、根文件系统只读、持久目录可写。flock内核锁保护同数据卷唯一写服务，第二进程退出75；崩溃自动释锁。所有数据卷仍需本机磁盘和备份，不是数据库集群。

同一浏览器的Cookie按主机隔离，端口不构成Cookie隔离；同机多客户使用不同主机名/域名。127.0.0.1不同端口只用于隔离测试，切换管理账号时应使用独立浏览器上下文。服务器仍用不同密钥拒绝其他实例的会话，不能共享实例密钥来回避Cookie冲突。

## HTTPS与来源

将deploy/nginx.conf.example和form-studio-proxy.conf中的example.com、证书路径、3200端口替换为实际值。先nginx -t，再按客户变更流程启用；本项目不自动操作DNS、证书供应商或公网入口。证书来自客户认可渠道。

代理固定Host/X-Forwarded-Host/X-Forwarded-Proto，覆盖X-Forwarded-For而非追加客户端值。应用认证来源与HTTPS网站来源必须完全一致。HTTPS配置启用Secure Cookie；Origin错误或缺失的写请求拒绝。只有应用无法绕过代理访问时才在instance.env设置FORM_STUDIO_TRUST_PROXY=true，启用附加IP收件限流。登录还有认证库限流，代理按IP进一步限流。

代理请求体80MiB覆盖72MiB整站JSON；实际接口继续执行各自更小上限，不能用代理上限绕过8MiB图片/10MiB PDF/40MiB视频/4MiB草稿限制。私有媒体和预览鉴权，历史已公开媒体持续可读以支持回滚。代理关闭访问日志，避免查询串、Cookie、Referer或正文进入日志；应用未处理异常只记固定类别。按客户运维规范管理系统级错误日志。

代理配置依据：[NGINX proxy模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[NGINX请求体配置示例](https://nginx.org/en/docs/example.html)。真实域名/TLS证书及邮件收件箱仍须在客户环境单独验收。

## 自动备份与监控

容器生产入口启动即备份，之后每24小时执行一次，默认保留7份；instance.env可配置FORM_STUDIO_BACKUP_INTERVAL_HOURS=1–8760和FORM_STUDIO_BACKUP_KEEP=1–365。备份目录FORM_STUDIO_BACKUP_DIR默认/backups，必须与/data分离且可写。普通npm start不启用这个调度，后台会如实显示未启用。

自动备份在backups/STATUS.json记录成功/失败、时间、字节、文件数及保留份数；后台“站点设置→备份与导出”仅管理员可读真实状态。失败不是成功，没有记录不是零备份。进程停止时不执行调度，停机期间没有备份；需要连续监控时由客户现有监控读取健康/备份状态。异地备份由客户自行配置受控目标，本项目不会自动上传第三方。

```bash
# 手工在线备份到全新目录，数据库在线backup包含已提交WAL
customer_compose exec app \
  node --env-file=/config/instance.env scripts/ops.cjs backup --target /backups/manual-20261107
# 验证逐文件哈希、实际文件集合、SQLite完整性/兼容版本及所有历史索引媒体
customer_compose exec app \
  node scripts/ops.cjs verify --backup /backups/manual-20261107
```

v2清单记录应用/锁文件哈希、协议及迁移版本、每文件SHA256/字节。先SQLite在线快照，再复制只增不改的媒体；副本改为独立回滚日志模式，不依赖原WAL/SHM。完整清单最后落盘才算成功；异常留FAILED.json，禁止当正常备份恢复。启动预检和备份前检查可用空间，仍需监控并发写入导致的磁盘耗尽。自动保留只清理本工具命名、校验通过的过期目录，手工/失败/损坏副本不自动删，需运维核查容量。

备份包含账号哈希、会话、询盘、通知、审计、草稿和所有历史公开资料；文件600，目录700，按敏感资料管理。**包含数据库内加密保存的AI、搜索及SMTP凭据、认证恢复记录，以及设计约定等私有参考文字；不含环境密钥、环境中的旧SMTP明文口令或源码**。需另行私密保存原instance.env及匹配镜像/源码锁文件，固定secret必须匹配，否则不能读取原加密凭据或承诺恢复原会话。

## 恢复到全新目录

恢复入口不覆盖已有目录，不接受符号链接路径，也不按清单路径解压。先停止写服务并保留原数据；备份校验后复制至同级临时目录，再原子改名到全新目标。无需删除旧实例，失败也不能覆盖它。

```bash
customer_compose stop app
# 目标/data-restored必须不存在；父目录需要本机持久磁盘且1000用户可写
docker run --rm \
  --mount type=bind,source="$INSTANCE_ROOT/backups",target=/backups,readonly \
  --mount type=bind,source="$INSTANCE_ROOT",target=/instance \
  form-studio:customer-v1 node scripts/ops.cjs restore \
  --backup /backups/manual-20261107 --target /instance/data-restored
```

原data、config、镜像继续保留。将compose中的/data挂载源明确改为data-restored，沿用原私密配置与来源；在受限入口启动检查登录、草稿、发布历史/指针、历史媒体、详情、询盘、通知与审计，之后再接正式入口。也可先在隔离新实例验证，但来源改变时应配置新的验证来源并重新登录，不改原站配置。

旧v1实例备份没有逐文件哈希，默认拒绝。来源可信且另有完整副本时，可明确加--allow-legacy做兼容恢复，报告会标记legacy，不能当作已有密码学完整性证据。

## 升级与回滚

1. 记录原镜像ID/源码commit、lock、私密配置及原数据路径；做完整备份并verify。
2. 将备份恢复到隔离新目录，原data不动。用新镜像在同卷持有flock运行setup --migrate-only；不创建或改账号。
3. 新程序按cms_schema_migration顺序和校验和执行幂等迁移，记录版本/名称/时间。已有表只登记/补充，不seed重建；未知更高迁移或已登记SQL被修改就拒绝。
4. 在隔离副本运行登录、权限、旧页面JSON、历史媒体、预览、发布/回退、询盘/通知、健康与备份验收。通过后修改同一客户文件的数据目录或镜像标签，保留项目名，运行 `customer_compose config --format json` 核对，再以 `customer_compose up -d --no-build` 更新该服务。
5. 需撤回时用 `customer_compose stop app` 停止该客户服务，改回原镜像与升级前数据目录/配置，再用同一项目启动。新程序上线后的新询盘和编辑需单独核对与转移。

公开版本切换只改网站指针。完整实例恢复会回到备份时的账号、会话和询盘状态。跨数据格式回退必须匹配旧实例备份和程序；同格式切回也要先保护当前业务并隔离验证。AI及搜索凭据和私有报告在完整实例备份中，固定 secret 要匹配并私密保留。

### 从旧版隐式项目名迁移

旧版可能使用了源码目录下的隐式项目名 `deploy`。先用 `docker compose ls` 查看实际名称，核对该旧项目的镜像、挂载、端口和客户归属。使用原 Compose 文件、原环境文件和查到的项目名备份并停止旧服务，例如 `docker compose -p deploy -f /path/to/old/compose.yaml --env-file /path/to/old/customer.compose.env stop app`。停妥后以新客户项目名启动，复用已核对的数据、配置和备份目录，随后验证登录与健康。保留旧容器供核对和回滚；切回旧项目之前先停新项目。

恢复旧备份也会恢复当时的会话和未到期恢复记录。受限入口启动后先核对账号与会话；如有账号安全事件，应更改密码并撤销其他会话，再开放入口。恢复链接同时绑定当时的角色、邮箱和密码，凭据变化后不再有效。找回密码与停服本机恢复见[账号恢复](ACCOUNT_RECOVERY.md)。上线检查没有可核实的恢复演练回执时会显示待验证，手工运行verify成功不自动冒充已经完成恢复。

## 本地预检与验收命令

```text
npm run typecheck
npm test
npm run test:auth
npm run build
npm run test:http
node scripts/ops.cjs preflight --env-file 私密配置路径
npm run test:deployment
```

部署回归使用本机已有镜像。运行前通过 `DEPLOY_TEST_IMAGE` 指定当前交付镜像。测试使用随机 `studio-delivery-*` 项目名、本机端口及合成夹具。可用 `npm run test:deployment -- --compose-only` 单独验证两个项目解析、重建、在线备份和停机的隔离。退出清理本次测试资源；设置 `DEPLOY_TEST_KEEP=1` 仅供保留测试卷诊断。

自定义 JavaScript 仅向受信管理员开放。升级依赖时复查 PDF worker、原生 SQLite ABI、Puck 和预览沙箱，并核对[第三方许可说明](../THIRD_PARTY_NOTICES.md)。

AI 操作记录、写作依据、资料摘录和回执属于完整实例备份的私有数据。
