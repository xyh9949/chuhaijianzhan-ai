import type { PageItem, StudioState } from './types';

export const SITE_JOURNEY_STEPS = [
  { key: 'materials', title: '准备资料', description: '导入公司资料和产品表，或直接填写真实业务信息。' },
  { key: 'generate', title: '生成网站', description: '使用自己的AI准备方案，选择设计并确认保存草稿。' },
  { key: 'edit', title: '自由编辑', description: '调整文字、图片、布局和手机端效果，AI局部修改可按需使用。' },
  { key: 'seo', title: '搜索检查', description: '先检查本站内容，再按需连接自己的搜索数据接口。' },
  { key: 'publish', title: '检查并发布', description: '预览效果、选择发布范围，通过原检查后再明确发布。' },
] as const;

export type SiteJourneyStep = typeof SITE_JOURNEY_STEPS[number]['key'];
export interface SiteJourneySession { version: 1; active: boolean; step: SiteJourneyStep; pageId?: string; runId?: string; }
export interface SiteJourneyIntent { id: string; action: 'brief' | 'import' | 'resume' | 'examples' | 'ai-edit'; runId?: string; }
export interface SiteJourneyBridge {
  session: SiteJourneySession;
  intent?: SiteJourneyIntent;
  consumeIntent: (id: string) => void;
  onBuildRun: (id: string) => void;
  onApplied: (pageIds: string[]) => void;
}

const storagePrefix = 'form-studio:site-journey:v1:';
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const actorIdentifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const runIdentifier = /^ai[pv]-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const defaultSession = (): SiteJourneySession => ({ version: 1, active: false, step: 'materials' });
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** 会话只记位置和稳定ID；未知字段整份拒绝，避免把表单、模型结果或密钥随之持久化。 */
function sessionValue(value: unknown): SiteJourneySession | null {
  try {
    if (!plainObject(value) || Object.keys(value).some(key => !['version', 'active', 'step', 'pageId', 'runId'].includes(key)) || value.version !== 1 || typeof value.active !== 'boolean' || !SITE_JOURNEY_STEPS.some(step => step.key === value.step)) return null;
    if (value.pageId !== undefined && (typeof value.pageId !== 'string' || !identifier.test(value.pageId))) return null;
    if (value.runId !== undefined && (typeof value.runId !== 'string' || !runIdentifier.test(value.runId))) return null;
    return { version: 1, active: value.active, step: value.step as SiteJourneyStep, ...(value.pageId !== undefined ? { pageId: value.pageId as string } : {}), ...(value.runId !== undefined ? { runId: value.runId as string } : {}) };
  } catch { return null; }
}

/** 同标签页按当前账号隔离；恢复只定位流程，不重放上传、AI、采用或发布动作。 */
export function loadSiteJourney(actorId: string): SiteJourneySession {
  if (typeof actorId !== 'string' || !actorIdentifier.test(actorId)) return defaultSession();
  try {
    const raw = globalThis.sessionStorage?.getItem(`${storagePrefix}${actorId}`);
    if (!raw || raw.length > 2048) return defaultSession();
    const value: unknown = JSON.parse(raw);
    if (!plainObject(value) || Object.keys(value).some(key => !['version', 'actorId', 'session'].includes(key)) || value.version !== 1 || value.actorId !== actorId) return defaultSession();
    return sessionValue(value.session) || defaultSession();
  } catch { return defaultSession(); }
}

/** 存储受限时保留调用方当前React状态；不把未持久化的位置误报为可跨刷新恢复。 */
export function saveSiteJourney(actorId: string, value: SiteJourneySession): void {
  if (typeof actorId !== 'string' || !actorIdentifier.test(actorId)) return;
  try {
    const target = globalThis.sessionStorage;
    if (!target) return;
    const session = sessionValue(value), key = `${storagePrefix}${actorId}`;
    if (!session) { target.removeItem(key); return; }
    target.setItem(key, JSON.stringify({ version: 1, actorId, session }));
  } catch { /* 浏览器不允许存储时，流程仍可在当前页面继续。 */ }
}

/** 只汇总当前真实内容；步骤位置、内容数量和公开版本均不能证明AI/人工审核已经完成。 */
export function deriveSiteJourneyFacts(state: StudioState): {
  editablePages: PageItem[]; products: number; images: number; currentReleaseId: string | null;
  draftPageCount: number; preferredPageId: string | null;
} {
  const editablePages = state.pages.filter(page => !page.slug.includes(':'));
  const preferred = editablePages.find(page => page.id === state.activePageId) || editablePages.find(page => page.slug === '/') || editablePages[0];
  return {
    editablePages,
    products: state.products.length,
    images: state.media.filter(item => item.kind === 'image').length,
    currentReleaseId: state.releases.find(release => release.status === 'current')?.id || null,
    draftPageCount: state.pages.filter(page => page.status === 'draft').length,
    preferredPageId: preferred?.id || null,
  };
}
