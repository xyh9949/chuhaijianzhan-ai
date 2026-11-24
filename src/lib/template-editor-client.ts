'use client';

import type { PageTemplate, StudioState } from './types';

const targetKey = 'form-studio:editing-template';

/** 模板是独立编辑目标；会话只存账号与ID，不改 activePageId 或制造普通页面。 */
export function rememberTemplateEditor(actorId: string, templateId?: string) {
  try {
    if (templateId) sessionStorage.setItem(targetKey, JSON.stringify({ actorId, templateId }));
    else sessionStorage.removeItem(targetKey);
  } catch { /* 禁用会话存储时当前画布仍可编辑。 */ }
}

export function readTemplateEditor(state: StudioState, actorId: string): string | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(targetKey) || 'null');
    return value?.actorId === actorId && state.pageTemplates?.some(item => item.id === value.templateId) ? value.templateId : undefined;
  } catch { return undefined; }
}

/** 只为渲染创建虚拟页面上下文，模型/动态绑定与真实详情一致；此对象绝不提交到数据库。 */
export function templateEditorState(state: StudioState, template: PageTemplate): StudioState {
  const base = state.pages.find(page => template.kind === 'product' ? page.slug === '/products/:slug' : template.kind === 'entry' && page.contentModelId === template.modelId);
  const page = { ...base, id: `template-canvas-${template.id}`, title: template.name, slug: base?.slug || (template.kind === 'product' ? '/products/:slug' : '/template-preview'), type: template.kind === 'product' ? '产品详情' : '页面', status: 'draft' as const, updated: template.updated, ...(template.kind === 'entry' ? { contentModelId: template.modelId } : {}) };
  return { ...state, activePageId: page.id, pages: [...state.pages, page], editorData: { ...state.editorData, [page.id]: template.data } };
}

export function focusTemplateLibrary() {
  try { sessionStorage.setItem('form-studio:template-library-open', '1'); } catch { /* 默认资源页仍可进入。 */ }
}
