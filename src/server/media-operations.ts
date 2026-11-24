import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabase, getDataDirectory } from './database';
import { ApiError } from './http';
import { getDraftRecord, patchStudio } from './studio';
import { collectReferences, identifier, object, revision, text } from './validation';
import type { SiteSnapshot } from './types';

/** 引用明细只返回对象标签，不输出版本正文；全站样式/代码单独列出，历史版本永不物理删除。 */
export function mediaUsage(id: string) {
  const draft = getDraftRecord().content, item = draft.media.find(m => m.id === id);
  if (!item) throw new ApiError(404, '草稿素材不存在');
  const empty = { ...draft, pages: [], products: [], contentEntries: [], pageTemplates: [], sharedBlocks: [], editorData: {}, theme: undefined, customCode: undefined };
  const contains = (source: Parameters<typeof collectReferences>[0]) => collectReferences(source).urls.has(item.url);
  const usage: { kind: string; id: string; name: string }[] = [];
  for (const p of draft.pages) if (contains({ ...empty, pages: [p], editorData: draft.editorData })) usage.push({ kind: '页面', id: p.id, name: p.title });
  for (const t of draft.pageTemplates || []) if (contains({ ...empty, pageTemplates: [t] })) usage.push({ kind: '页面模板', id: t.id, name: t.name });
  for (const b of draft.sharedBlocks || []) if (contains({ ...empty, sharedBlocks: [b] })) usage.push({ kind: '同步区块/卡片', id: b.id, name: b.name });
  for (const p of draft.products) if (contains({ ...empty, products: [p] })) usage.push({ kind: '产品', id: p.id, name: p.name });
  for (const e of draft.contentEntries || []) if (contains({ ...empty, contentEntries: [e] })) usage.push({ kind: '独立内容', id: e.id, name: e.title });
  if (contains({ ...empty, theme: draft.theme, customCode: draft.customCode })) usage.push({ kind: '全站样式/代码', id: 'global-design', name: '全站设计' });
  const historical = (getDatabase().prepare("SELECT r.id,r.title,r.created_at FROM cms_release r WHERE EXISTS(SELECT 1 FROM json_each(r.manifest_json,'$.media') m WHERE json_extract(m.value,'$.url')=?) ORDER BY r.created_at DESC").all(item.url) as { id: string; title: string; created_at: string }[]).map(r => ({ id: r.id, name: r.title, createdAt: r.created_at }));
  return { draft: usage, historical, removableFromDraft: usage.length === 0, physicalDeletion: false };
}
export function batchMedia(value: unknown) {
  const input = object(value, '批量素材操作');
  if (Object.keys(input).some(k => !['expectedRevision', 'ids', 'action', 'folder'].includes(k))) throw new ApiError(422, '素材操作包含未知字段');
  const expected = revision(input.expectedRevision);
  if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 500) throw new ApiError(422, '每次请选择1–500份素材');
  const ids = input.ids.map(v => identifier(v)); if (new Set(ids).size !== ids.length) throw new ApiError(422, '素材选择不能重复');
  if (!['move', 'remove'].includes(String(input.action))) throw new ApiError(422, '请选择移动或移出素材库');
  const folder = input.action === 'move' ? text(input.folder, '目标文件夹', 100, true).trim() : '';
  const current = getDraftRecord(); if (current.revision !== expected) throw new ApiError(409, '素材库已变化，请刷新后重试');
  for (const id of ids) if (!current.content.media.some(m => m.id === id)) throw new ApiError(422, '所选素材已不存在，请重新选择');
  // 复用现有草稿事务与引用验证；任何一项仍被使用都拒绝整批，绝不部分移除。
  return patchStudio({ expectedRevision: expected, patch: { media: current.content.media.flatMap(m => !ids.includes(m.id) ? [m] : input.action === 'remove' ? [] : [{ ...m, folder }]) } });
}
export function mediaInventory(includeCandidates = false) {
  const directory = join(getDataDirectory(), 'media'), draft = getDraftRecord().content;
  const indexed = getDatabase().prepare('SELECT id,filename,bytes,sha256 FROM cms_media_file').all() as { id: string; filename: string; bytes: number; sha256: string }[];
  const retained = new Set(draft.media.map(m => m.id));
  for (const row of getDatabase().prepare('SELECT manifest_json FROM cms_release').iterate() as Iterable<{ manifest_json: string }>) for (const m of (JSON.parse(row.manifest_json) as SiteSnapshot).media) retained.add(m.id);
  const protectedHashes = new Set(indexed.filter(m => retained.has(m.id)).map(m => m.sha256));
  // 上传图片会转成WebP，整站包则保留合法JPEG/PNG原文件；容量诊断必须覆盖两条来源。
  const files = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter(d => d.isFile() && /^[a-f0-9]{64}(\.w(320|768|1440))?\.(webp|jpg|png|pdf|mp4|webm)$/.test(d.name)).map(d => ({ filename: d.name, bytes: statSync(join(directory, d.name)).size })) : [];
  const candidates = files.filter(f => !protectedHashes.has(f.filename.slice(0, 64))), disk = statfsSync(getDataDirectory());
  // 原图本身以.webp结尾；只有生成器的完整尺寸后缀才算派生图，不能按“.w”子串判断。
  const isDerivative = (filename: string) => /\.w(320|768|1440)\.webp$/.test(filename);
  return { draftCount: draft.media.length, physicalFiles: files.length, physicalBytes: files.reduce((n, f) => n + f.bytes, 0), originalBytes: files.filter(f => !isDerivative(f.filename)).reduce((n, f) => n + f.bytes, 0), derivativeBytes: files.filter(f => isDerivative(f.filename)).reduce((n, f) => n + f.bytes, 0), diskAvailableBytes: disk.bavail * disk.bsize, missingAlt: draft.media.filter(m => m.kind === 'image' && !m.alt.trim()).length,
    ...(includeCandidates ? { candidateCount: candidates.length, candidateBytes: candidates.reduce((n, f) => n + f.bytes, 0), candidates: candidates.slice(0, 2000), readOnly: true, note: '仅列出未被草稿素材库和任一历史版本保留的文件。此清单不提供删除操作；派生文件可重建。' } : {}) };
}
