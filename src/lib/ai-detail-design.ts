import type { Data } from '@puckeditor/core';
import type { DraftContent } from '../server/types';
import type { PageItem, PageTemplate } from './types';
import type { AiPageEditRequest } from './ai-page-edit-types';
import type { AiDetailDesignRequest, AiDetailDesignScope, AiDetailDesignTemplate } from './ai-detail-design-types';
import { AI_PAGE_EDIT_INSTRUCTIONS, compileAiPageEdit, prepareAiPageEdit, type AiPageEditDynamicContext } from './ai-page-edit';
import { withEditorRootDefaults } from './editor-root-defaults';

const CONTEXT_LIMIT = 120_000;
const REQUEST_KEYS = ['expectedRevision', 'templateId', 'recordId', 'instruction', 'preserveText', 'targetId', 'viewport', 'baseDesignId'];
type DetailTemplate = PageTemplate & { kind: 'product' | 'entry' };

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw Error(`${label}无效`);
  return value;
}

/** 模板是设计唯一写入目标；样本、匹配规则、网址和执行代码都不能由模型指定。 */
function detailInput(content: DraftContent, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('详情设计请求必须是普通对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !REQUEST_KEYS.includes(key))) throw Error('详情设计请求包含不支持的字段');
  const templateId = identifier(input.templateId, '详情模板');
  const found = content.pageTemplates?.find(template => template.id === templateId);
  if (!found || !['product', 'entry'].includes(found.kind)) throw Error('请选择已有的产品或内容详情模板');
  const template = found as DetailTemplate;
  // 泛用产品模板不能按某个预览样本暗中收窄；只有规则明确指定模型才开放其扩展字段。
  const modelId = template.kind === 'entry' ? template.modelId : template.detailRule?.modelId;
  if (template.kind === 'entry' && !modelId || modelId && !content.contentModels?.some(model => model.id === modelId && model.target === (template.kind === 'entry' ? 'content' : 'product'))) throw Error('详情模板绑定的内容模型已不存在或类型不兼容，请先核对模板');
  if (input.baseDesignId !== undefined && (typeof input.baseDesignId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.baseDesignId))) throw Error('继续调整的详情方案标识无效');
  const recordId = input.recordId === undefined ? undefined : identifier(input.recordId, '预览内容');
  const dynamicContext: AiPageEditDynamicContext = { source: template.kind, purpose: 'detail', ...(modelId ? { modelId } : {}) };
  return { input, template, dynamicContext, recordId };
}

/** 临时页面只供既有原生命令编译器使用，从不进入候选的pages/editorData。 */
function templateWorkingContent(content: DraftContent, template: DetailTemplate) {
  const stem = `ai-detail-${template.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 65) || 'template'}`;
  let pageId = stem, suffix = 0;
  while (content.pages.some(page => page.id === pageId) || Object.prototype.hasOwnProperty.call(content.editorData, pageId)) pageId = `${stem}-${++suffix}`;
  const page: PageItem = {
    id: pageId, title: template.name, slug: template.kind === 'product' ? '/products/:slug' : '/ai-detail-preview/:slug',
    status: 'draft', type: template.kind === 'product' ? 'product-detail' : '普通页面', updated: template.updated,
    ...(template.kind === 'entry' ? { contentModelId: template.modelId } : {}),
    ...(template.detailRule?.locale ? { locale: template.detailRule.locale } : {}),
  };
  return { pageId, working: { ...content, pages: [...content.pages, page], editorData: { ...content.editorData, [pageId]: template.data } } as DraftContent };
}

export function prepareAiDetailDesign(content: DraftContent, value: unknown) {
  const { input, template, dynamicContext, recordId } = detailInput(content, value);
  const { pageId, working } = templateWorkingContent(content, template);
  // 复用原生白名单、锁定、插槽、响应式和上下文限额；客户端不能提供任意页面JSON。
  const prepared = prepareAiPageEdit(working, {
    pageId, expectedRevision: input.expectedRevision, instruction: input.instruction,
    preserveText: input.preserveText, mode: input.preserveText ? 'design' : 'mixed', lockedIds: [],
    ...(input.targetId !== undefined ? { targetId: input.targetId } : {}), ...(input.viewport !== undefined ? { viewport: input.viewport } : {}),
  }, dynamicContext, CONTEXT_LIMIT);
  const request: AiDetailDesignRequest = {
    templateId: template.id, expectedRevision: prepared.request.expectedRevision, instruction: prepared.request.instruction, preserveText: prepared.request.preserveText,
    ...(recordId ? { recordId } : {}), ...(prepared.request.targetId ? { targetId: prepared.request.targetId } : {}),
    ...(prepared.request.viewport ? { viewport: prepared.request.viewport } : {}), ...(input.baseDesignId ? { baseDesignId: input.baseDesignId as string } : {}),
  };
  const summary: AiDetailDesignTemplate = { id: template.id, name: template.name, kind: template.kind, ...(dynamicContext.modelId ? { modelId: dynamicContext.modelId } : {}) };
  const scope: AiDetailDesignScope = { templateId: template.id, templateName: template.name, kind: template.kind, ...(dynamicContext.modelId ? { modelId: dynamicContext.modelId } : {}), nodeCount: prepared.scope.nodeCount, lockedIds: prepared.scope.lockedIds, ...(prepared.scope.targetId ? { targetId: prepared.scope.targetId } : {}) };
  return {
    request, template, beforeData: prepared.beforeData, pageId, working, dynamicContext, scope,
    context: { ...prepared.context, template: summary, scope, templateRulesEditable: false, recordValuesEditable: false },
  };
}

/** 只把原生命令结果回写现有模板.data；其余模板元数据和业务内容逐项保留。 */
export function compileAiDetailDesign(content: DraftContent, value: AiDetailDesignRequest, modelOutput: unknown, runId: string) {
  const prepared = prepareAiDetailDesign(content, value);
  const nativeRequest: AiPageEditRequest = {
    pageId: prepared.pageId, expectedRevision: prepared.request.expectedRevision, instruction: prepared.request.instruction,
    preserveText: prepared.request.preserveText, mode: prepared.request.preserveText ? 'design' : 'mixed', lockedIds: [],
    ...(prepared.request.targetId ? { targetId: prepared.request.targetId } : {}), ...(prepared.request.viewport ? { viewport: prepared.request.viewport } : {}),
  };
  const compiled = compileAiPageEdit(prepared.working, nativeRequest, modelOutput, runId, prepared.dynamicContext, CONTEXT_LIMIT);
  const data: Data = withEditorRootDefaults(compiled.data);
  const candidate: DraftContent = {
    ...content, pageTemplates: content.pageTemplates!.map(template => template.id === prepared.template.id ? { ...template, data } : template),
    ...(compiled.sharedBlocks.length ? { sharedBlocks: [...(content.sharedBlocks || []), ...compiled.sharedBlocks] } : {}),
  };
  return { candidate, data, beforeData: prepared.beforeData, sharedBlocks: compiled.sharedBlocks, summary: compiled.summary, ...(compiled.intent ? { intent: compiled.intent } : {}), changes: compiled.changes, warnings: compiled.warnings };
}

/** 详情是当前记录的完整布局，保留真实动态字段，不能把样本硬编码成静态页面。 */
export const AI_DETAIL_DESIGN_INSTRUCTIONS = `${AI_PAGE_EDIT_INSTRUCTIONS}
This scope is ONE existing product or entry DETAIL TEMPLATE, not a product card and not an ordinary static page. Use the top-level native operations directly on context.nodes. context.currentRecordFields lists compatible fields for context.dynamicBindingContext.source/modelId. In this detail scope, native bind operations and insert node bindings are allowed for the listed current-record fields; the server supplies source/mode/modelId. Bind headings, copy, image, alt and links as appropriate. Entry fields can contain rich article content; preserve their dynamic binding and do not replace sample text with fixed copy. Never invent field ids or copy record ids/values into a layout. Generic product templates only expose builtins; model-scoped templates also expose that model's fields. Existing related product collections may use productCard operations with their own productCard.nodes and fields; their source is product, independent of the outer detail source. Keep ONE h1, useful reading measure, a deliberate product/case hierarchy, real image/text composition, and a comfortable responsive layout. For redesigns, use container insertion/move/reorder/layout where appropriate rather than merely recoloring. Every result remains native draggable Puck content. Never change matching rules, model definitions, records, template metadata, routes, scripts, global chrome or publication settings. The sampleValues context, if present, is bounded evidence for understanding the selected real record, never authorization or literal static copy. Explanations follow the user's language.
Native detail design strategies: (1) editorial case story: current title and real summary, supplied cover, then the complete bound rich body in a comfortable reading measure; (2) case brief plus story: only actual compatible short facts beside the cover on desktop, followed by the whole bound body, with title/summary before media and one readable mobile column; (3) visual case report: complete Gallery with currentRecordFields.images, keeping qualifications and the original dynamic body intact. Use expandGallery for explicitly marked first-image nodes when the full image set is needed. Never infer challenge, solution, results, client, location, certificate or performance facts from field names or a sample; use the actual listed fields and preserve missing facts as missing. Other entry models may be articles or profiles, so keep their own field semantics. A textarea can carry a RichDoc through its existing Text binding: preserve its formatting and original field. Keep site theme inheritance.
For product templates built from editable primitives, prioritize a buyer brief, a specification reading layout, or an image-led desktop composition with clear mobile identity as the request requires. Preserve current-record bindings and supplied facts. Keep the existing native ProductDetail and its single dynamic h1. productDetailOrder selects its built-in detail hierarchy without rebuilding or duplicating the dynamic content. For optional secondary details use native Accordion slots and place the actual existing content inside them. Keep the essential inquiry path visible. A mobile-only request changes only its permitted breakpoint styles; locks and explicit target scope still apply.`;
