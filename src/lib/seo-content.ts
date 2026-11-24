import type { RichNode } from './presentation-content';
import type { SeoContentChange, SeoContentGroup, SeoContentLink } from './seo-content-types';

export const SEO_CONTENT_GROUP_LABELS: Record<SeoContentGroup, string> = { body: '正文补充', faq: '买家问答', links: '相关内容链接', seoTitle: '搜索标题', seoDescription: '搜索介绍' };
const keys = (value: Record<string, unknown>, allowed: string[]) => { if (Object.keys(value).some(key => !allowed.includes(key))) throw Error('SEO正文结果含未允许字段'); };
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('SEO正文结果格式无效'); return value as Record<string, unknown>; }
function plain(value: unknown, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || required && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<\s*\/?[a-z][\w:-]*(?:\s[^>]*|\s*\/?)>|<!|<\?|(?:javascript|vbscript)\s*:|https?:\/\//i.test(value)) throw Error('SEO正文仅接受范围内纯文字，不接受HTML、脚本或模型网址');
  return value.trim();
}
const paragraph = (text: string): RichNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const heading = (text: string, level = 2): RichNode => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
/** 模型只提供有限文字块；原生正文结构、FAQ和真实内链由服务器编译，绝不采用模型HTML或任意URL。 */
export function compileSeoContent(value: unknown, links: SeoContentLink[]) {
  const input = object(value); keys(input, ['summary', 'body', 'faq', 'links', 'metadata', 'evidence', 'warnings', 'missingFacts']);
  const summary = plain(input.summary, 1500), changes: SeoContentChange[] = [];
  if (!Array.isArray(input.body) || input.body.length > 12 || !Array.isArray(input.faq) || input.faq.length > 6 || !Array.isArray(input.links) || input.links.length > 6) throw Error('正文补充、问答或内链数量无效');
  const blocks = input.body.map(raw => { const block = object(raw); keys(block, ['kind', 'text']); const text = plain(block.text, 2000); if (block.kind !== 'heading' && block.kind !== 'paragraph') throw Error('正文只允许标题和段落'); return block.kind === 'heading' ? heading(text) : paragraph(text); });
  if (blocks.length) changes.push({ key: 'body', label: SEO_CONTENT_GROUP_LABELS.body, explanation: '在当前正文后追加这些原生图文段落，原文、图片和链接保持。', doc: { type: 'doc', content: blocks } });
  const faq = input.faq.flatMap(raw => { const item = object(raw); keys(item, ['question', 'answer']); return [heading(plain(item.question, 300), 3), paragraph(plain(item.answer, 2000))]; });
  if (faq.length) changes.push({ key: 'faq', label: SEO_CONTENT_GROUP_LABELS.faq, explanation: '追加可自由编辑的问答段落，不凭空添加认证、参数或承诺。', doc: { type: 'doc', content: faq } });
  const seen = new Set<string>(), items = input.links.map(raw => { const item = object(raw); keys(item, ['key', 'label']); if (typeof item.key !== 'string' || seen.has(item.key)) throw Error('内链目标重复或无效'); const target = links.find(link => link.key === item.key); if (!target) throw Error('模型选择了未明确提供的内链目标'); seen.add(target.key); return { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: plain(item.label, 300), marks: [{ type: 'link', attrs: { href: target.url } }] }] }] } as RichNode; });
  if (items.length) changes.push({ key: 'links', label: SEO_CONTENT_GROUP_LABELS.links, explanation: '链接只能来自你明确选择的真实同语言记录；草稿目标发布前仍需依赖检查。', doc: { type: 'doc', content: [{ type: 'bulletList', content: items }] } });
  // 搜索字段为独立可选分组：省略对象表示不改；显式null、数组或未知字段仍属于无效输出。
  const metadata = input.metadata === undefined ? {} : object(input.metadata); keys(metadata, ['seoTitle', 'seoDescription']);
  for (const key of ['seoTitle', 'seoDescription'] as const) if (metadata[key] !== null && metadata[key] !== undefined) changes.push({ key, label: SEO_CONTENT_GROUP_LABELS[key], explanation: '只采用单独勾选的搜索字段，正文修改不会顺带覆盖它。', text: plain(metadata[key], key === 'seoTitle' ? 200 : 1000) });
  if (!changes.length) throw Error('AI没有返回可审核的实际建议');
  const messages = (raw: unknown, max: number) => { if (!Array.isArray(raw) || raw.length > max) throw Error('SEO正文核对说明无效'); return raw.map(text => plain(text, 600)); };
  if (!Array.isArray(input.evidence) || input.evidence.length > 5) throw Error('SEO正文必须提供有效的数据引用列表');
  const evidence = input.evidence.map(raw => { const item = object(raw); keys(item, ['reportId', 'rowNumbers']); if (typeof item.reportId !== 'string' || !Array.isArray(item.rowNumbers) || !item.rowNumbers.length || item.rowNumbers.length > 20 || item.rowNumbers.some(number => !Number.isSafeInteger(number) || Number(number) < 1) || new Set(item.rowNumbers).size !== item.rowNumbers.length) throw Error('SEO正文数据行引用无效'); return { reportId: item.reportId, rowNumbers: item.rowNumbers as number[] }; });
  if (new Set(evidence.map(item => item.reportId)).size !== evidence.length) throw Error('同一报告请合并引用');
  return { summary, changes, evidence, warnings: messages(input.warnings, 12), missingFacts: messages(input.missingFacts, 15) };
}
