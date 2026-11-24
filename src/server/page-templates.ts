import type { ActorIdentity } from './types';
import type { PageItem, PageTemplate } from '../lib/types';
import { cloneTemplateData } from '../lib/page-templates';
import { ApiError } from './http';
import { assertKnownPageComponents, identifier, object, revision, text } from './validation';
import { getDraftRecord, patchStudio } from './studio';
import { EMPTY_CODE } from './site-code';
import { remapSnippet } from './portable-code';

function currentAt(value: Record<string, unknown>) { const expected = revision(value.expectedRevision), current = getDraftRecord(); if (current.revision !== expected) throw new ApiError(409, '工作区已变化，请重新检查模板操作'); return { expected, current }; }
/** 捕获整页的独立副本；节点ID只要求在单页唯一，保留它们使现有全站ID选择器继续有效。 */
export function savePageAsTemplate(value: unknown, actor?:ActorIdentity) {
  const input = object(value, '保存页面模板');
  if (Object.keys(input).some(k => !['expectedRevision', 'pageId', 'templateId', 'name', 'description', 'replaceExisting'].includes(k))) throw new ApiError(422, '保存模板包含未知字段');
  if (input.replaceExisting !== undefined && typeof input.replaceExisting !== 'boolean') throw new ApiError(422, '请明确选择是否更新已有模板资源');
  const { expected, current } = currentAt(input), pageId = identifier(input.pageId), id = identifier(input.templateId), page = current.content.pages.find(p => p.id === pageId);
  if (!page) throw new ApiError(404, '来源页面不存在');
  const existing = current.content.pageTemplates?.find(t => t.id === id);
  if (existing && !input.replaceExisting) throw new ApiError(409, '模板标识已经存在，请刷新资源库，避免重复创建');
  if (!existing && input.replaceExisting) throw new ApiError(404, '要更新的模板资源已不存在');
  const name = text(input.name, '模板名称', 120, true).trim(), description = text(input.description ?? '', '模板说明', 2000);
  const data = current.content.editorData[page.id]; assertKnownPageComponents(data);
  const copy = cloneTemplateData(data, { fromPageId: page.id, toPageId: id, preserveNodeIds: true });
  const code = current.content.customCode?.pages[page.id];
  const kind = page.contentModelId ? 'entry' : page.slug === '/products/:slug' ? 'product' : 'page';
  if(existing?.detailRule&&(kind!==existing.kind||page.contentModelId!==existing.modelId))throw new ApiError(422,'带条件规则的模板只能从同用途/同模型详情页更新，请先解除规则');
  const template: PageTemplate = { id, name, description, kind, ...(page.contentModelId ? { modelId: page.contentModelId } : {}), sourcePath: page.slug, data: copy.data, ...(code ? { code: structuredClone(code) } : {}),...(existing?.detailRule?{detailRule:structuredClone(existing.detailRule)}:{}), updated: '' };
  return { ...patchStudio({ expectedRevision: expected, patch: { pageTemplates: [...(current.content.pageTemplates || []).filter(t => t.id !== id), template] } }, actor), templateId: id };
}

/** 详情资产只能应用到唯一默认详情页；已有目标必须显式传ID，避免默认覆盖其他人的草稿。 */
export function applyPageTemplate(value: unknown, canCode = false, actor?:ActorIdentity) {
  const input = object(value, '应用页面模板');
  if (Object.keys(input).some(k => !['expectedRevision', 'templateId', 'newPageId', 'targetPageId', 'title', 'slug', 'includeCode', 'enableJs'].includes(k))) throw new ApiError(422, '应用模板包含未知字段');
  for (const key of ['includeCode', 'enableJs']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ApiError(422, '请明确选择是否复制代码和启用JS');
  if ((input.includeCode || input.enableJs) && !canCode) throw new ApiError(403, '只有管理员可以复制或启用模板代码');
  if (input.enableJs && !input.includeCode) throw new ApiError(422, '启用JS前需明确选择复制模板代码');
  const { expected, current } = currentAt(input), id = identifier(input.templateId), template = current.content.pageTemplates?.find(t => t.id === id);
  if (!template) throw new ApiError(404, '页面模板不存在'); assertKnownPageComponents(template.data);
  const existing = template.kind === 'page' ? undefined : current.content.pages.find(p => template.kind === 'product' ? p.slug === '/products/:slug' : p.contentModelId === template.modelId);
  if (existing && input.targetPageId !== existing.id) throw new ApiError(409, '请明确选择当前默认详情页作为替换目标；尚未覆盖任何页面');
  if (input.targetPageId !== undefined && (!existing || input.targetPageId !== existing.id)) throw new ApiError(422, '目标不是当前模板对应的默认详情页');
  let page: PageItem;
  if (existing) page = { ...existing, status: 'draft' };
  else {
    const newId = identifier(input.newPageId, '新页面标识'); if (current.content.pages.some(p => p.id === newId)) throw new ApiError(409, '新页面标识已存在，请刷新页面列表');
    const title = text(input.title, '页面名称', 120, true).trim(), slug = template.kind === 'product' ? '/products/:slug' : text(input.slug, '页面路径', 400, true);
    if (template.kind === 'product' && input.slug !== undefined && input.slug !== '/products/:slug') throw new ApiError(422, '产品详情使用唯一默认路径/products/:slug');
    page = { id: newId, title, slug, type: template.kind === 'page' ? '普通页面' : template.kind === 'product' ? '动态模板' : '内容详情模板', status: 'draft', updated: '', ...(template.kind === 'entry' ? { contentModelId: template.modelId } : {}) };
  }
  const copy = cloneTemplateData(template.data, { fromPageId: template.id, toPageId: page.id, fromPath: template.sourcePath, toPath: page.slug, preserveNodeIds: true });
  copy.data.root = { ...copy.data.root, props: { ...copy.data.root?.props, title: page.title } };
  const patch: Record<string, unknown> = { pages: existing ? current.content.pages : [...current.content.pages, page], editorData: { ...current.content.editorData, [page.id]: copy.data } };
  const warnings: string[] = [];
  if (input.includeCode === true && template.code) {
    const result = remapSnippet(template.code, { nodes: copy.nodeIds, paths: new Map(template.sourcePath ? [[template.sourcePath, page.slug]] : []) }, input.enableJs === true);
    patch.customCode = { global: current.content.customCode?.global || EMPTY_CODE, pages: { ...current.content.customCode?.pages, [page.id]: result.code } }; warnings.push(...result.warnings);
  } else if (template.code?.css || template.code?.js) warnings.push('模板的页面代码未复制；现有全站设计和目标页面代码保持原设置。');
  return { ...patchStudio({ expectedRevision: expected, patch }, actor), pageId: page.id, warnings };
}
