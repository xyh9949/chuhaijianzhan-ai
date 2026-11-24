import { Script } from 'node:vm';
import { ApiError } from './http';
import type { CodeSnippet, SiteCustomCode } from '../lib/types';
import type { SiteSnapshot } from './types';

export const EMPTY_CODE: CodeSnippet = { css: '', js: '', cssEnabled: false, jsEnabled: false };
const MAX_SOURCE_BYTES = 100 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, `${label}必须是对象`);
  return value as Record<string, unknown>;
}

/** 仅编译语法，不在 Node 中运行客户代码；错误指向用户源码的原始行列。 */
export function validateSnippet(value: unknown, label = '自定义代码', checkDisabled = false): CodeSnippet {
  const code = record(value, label);
  if (Object.keys(code).some((key) => !['css', 'js', 'cssEnabled', 'jsEnabled'].includes(key))) throw new ApiError(422, `${label}包含不支持的字段`);
  for (const key of ['css', 'js'] as const) if (typeof code[key] !== 'string' || Buffer.byteLength(code[key] as string, 'utf8') > MAX_SOURCE_BYTES) throw new ApiError(422, `${label}的 ${key.toUpperCase()} 必须是不超过 100 KB 的源码`);
  for (const key of ['cssEnabled', 'jsEnabled']) if (typeof code[key] !== 'boolean') throw new ApiError(422, `${label}必须明确设置 CSS 与 JS 的启用状态`);
  if (code.jsEnabled || checkDisabled) {
    try { new Script(code.js as string, { filename: 'custom-site.js' }); }
    catch (error) {
      const failure = error as Error;
      const lines = failure.stack?.split('\n') || [];
      const line = lines[0]?.match(/custom-site\.js:(\d+)/)?.[1];
      const column = lines[2]?.includes('^') ? lines[2].indexOf('^') + 1 : undefined;
      throw new ApiError(422, `${label} JavaScript 语法错误${line ? `（第 ${line} 行${column ? `，第 ${column} 列` : ''}）` : ''}：${failure.message}`);
    }
  }
  return code as unknown as CodeSnippet;
}

export function validateCustomCode(value: unknown, pageIds: Set<string>): SiteCustomCode {
  const code = record(value, '网站自定义代码');
  if (Object.keys(code).some((key) => !['global', 'pages'].includes(key))) throw new ApiError(422, '网站自定义代码包含不支持的字段');
  validateSnippet(code.global, '全站代码');
  const pages = record(code.pages, '页面代码');
  for (const [id, snippet] of Object.entries(pages)) {
    if (!pageIds.has(id)) throw new ApiError(422, `代码找不到对应页面：${id}`);
    validateSnippet(snippet, `页面 ${id} 代码`);
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_TOTAL_BYTES) throw new ApiError(422, '全站与页面自定义代码总量不能超过 1 MB');
  return code as unknown as SiteCustomCode;
}

/** 发布及恢复整套代码时，仅保留目标快照实际存在的页面，避免泄露其他草稿页。 */
export function codeForPages(code: SiteCustomCode | undefined, pageIds: Set<string>): SiteCustomCode {
  return structuredClone({ global: code?.global || EMPTY_CODE, pages: Object.fromEntries(Object.entries(code?.pages || {}).filter(([id]) => pageIds.has(id))) });
}

/** 资源来自不可变发布快照；自定义脚本使用独立函数和同步错误边界。 */
export function siteCodeResponse(snapshot: SiteSnapshot, target: string, kind: string): Response {
  if (kind !== 'css' && kind !== 'js') throw new ApiError(404, '代码资源不存在');
  if (target !== 'global' && !snapshot.pages.some((page) => page.id === target)) throw new ApiError(404, '代码页面不存在');
  const snippet = target === 'global' ? snapshot.customCode?.global : snapshot.customCode?.pages[target];
  const enabled = kind === 'css' ? snippet?.cssEnabled : snippet?.jsEnabled;
  const source = enabled ? snippet?.[kind] || '' : '';
  // 保留源码的 use strict 指令；hashbang 只允许出现在脚本起点，包装时转换为等长注释。
  const body = kind === 'js' && source ? `try {\n(function () {\n${source.replace(/^#!/, '//')}\n}).call(window);\n} catch (error) { console.error("Site custom script failed", error); }\n` : source;
  return new Response(body, { headers: { 'Content-Type': kind === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable' } });
}
