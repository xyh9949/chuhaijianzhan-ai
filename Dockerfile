# 基础镜像摘要在交付前固定；更新基础镜像后须重跑安装/恢复验收。
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime-base
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 FORM_STUDIO_DATA_DIR=/data FORM_STUDIO_BACKUP_DIR=/backups
# flock为内核锁；进程崩溃会自动释放，禁止同一数据卷启动两个写服务。
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/* && mkdir /data /backups /config && chown node:node /data /backups /config
COPY --from=build --chown=node:node /app/package*.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/LICENSE /app/THIRD_PARTY* /app/README.md /app/DEPLOYMENT.md ./
COPY --from=build --chown=node:node /app/docs ./docs
USER node
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3200/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["flock","--nonblock","--conflict-exit-code","75","/data/.instance.lock","node","--env-file=/config/instance.env","scripts/runtime.cjs"]

# 需要AI真实截图时显式选择此目标；浏览器版本由锁定的playwright-core管理，运行期不下载。
FROM runtime-base AS runtime-browser
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/form-studio-browsers
RUN node node_modules/playwright-core/cli.js install --with-deps chromium && rm -rf /var/lib/apt/lists/*
USER node

# 默认镜像保留原精简运行方式；带浏览器版本使用 --target runtime-browser。
FROM runtime-base AS runtime
