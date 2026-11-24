import type { NextConfig } from 'next';
// 登录、持久化和实时发布需要 Node 服务；SQLite 作为原生服务端依赖运行。
const nextConfig: NextConfig = { devIndicators: false,
  // 隔离验收或嵌套部署含多个锁文件时，只解析当前应用，避免把父项目纳入构建范围。
  turbopack: { root: process.cwd() },
  serverExternalPackages: ['better-sqlite3', 'pdf-lib', 'pdfjs-dist', 'exceljs', 'ssf', 'playwright-core', 'tesseract.js', '@napi-rs/canvas'],
  // PDF验证worker使用原生require；分发时保留解析库及它的运行依赖，不修改依赖源码。
  outputFileTracingIncludes: { '/api/external-ai/skill': ['./docs/skills/form-studio-site-design/**/*'], '/api/site-packages/*': ['./node_modules/pdf-lib/**/*', './node_modules/@pdf-lib/**/*', './node_modules/pako/**/*', './node_modules/tslib/**/*'], '/api/media': ['./node_modules/pdf-lib/**/*', './node_modules/@pdf-lib/**/*', './node_modules/pako/**/*', './node_modules/tslib/**/*'],
    // 资料worker动态加载本地解析器/字体；不依赖远程字体，也不修改解析库源码。
    '/api/ai/sources*': ['./node_modules/pdf-lib/**/*', './node_modules/@pdf-lib/**/*', './node_modules/pako/**/*', './node_modules/tslib/**/*', './node_modules/pdfjs-dist/**/*', './node_modules/exceljs/**/*', './node_modules/ssf/**/*', './node_modules/@napi-rs/**/*', './node_modules/tesseract.js/**/*', './node_modules/tesseract.js-core/**/*', './node_modules/@tesseract.js-data/**/*', './node_modules/is-url/**/*', './node_modules/zstd-codec/**/*'] },
  // 数据与密钥由部署时挂载，禁止文件追踪把实例内容复制进应用分发包。
  outputFileTracingExcludes: { '*': ['./data/**/*', './backups/**/*', './.env*', './work/**/*', './output/**/*', './out/**/*', './.playwright-cli/**/*'] },
  async headers() { return [
  // 首版不缓存 HTML；正常图片/CSS 请求不匹配此条件，保留各自的静态资源策略。
  { source: '/:path*', has: [{ type: 'header', key: 'accept', value: '.*text/html.*' }], headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
  { source: '/preview/:path*', headers: [{ key: 'Cache-Control', value: 'private, no-store' }, { key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
  // 密码恢复链接首次HTML请求即禁止Referer外传，不能只等客户端清理token后才生效。
  { source: '/admin/:path*', headers: [{ key: 'Cache-Control', value: 'private, no-store' }, { key: 'X-Robots-Tag', value: 'noindex, nofollow' }, { key: 'Referrer-Policy', value: 'no-referrer' }] }]; } };
export default nextConfig;
