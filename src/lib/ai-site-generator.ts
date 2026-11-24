import type { ComponentData, Data } from '@puckeditor/core';
import type { DraftContent } from '../server/types';
import type { ContentQuery, PageItem, PageTemplate, SharedBlock } from './types';
import type { DesignValues } from './responsive-style';
import type { AiSiteBrief, AiSiteCompileResult, AiSiteDirection, AiSitePagePlan, AiSitePlan, AiSiteSection, AiSiteSeoIssue } from './ai-builder-types';
import { isLocalImagePath } from './bundled-media';
import { validLocale } from './localization';
import { createFormDefinition } from './form-content';
import { createContentDesignData } from './content-design-presets';
import { createAiBuildSharedLayout } from './ai-build-shared-layout';
import { mapComponentSlots } from './editor-slots';
import { AI_SITE_LAYOUTS, AI_SECTION_LAYOUTS } from './ai-builder-types';

type ObjectValue = Record<string, unknown>;
const pagePaths = ['/', '/products', '/products/:slug', '/contact'];
const sectionKinds = ['hero', 'text', 'features', 'products', 'contact'] as const;
const fonts = ['sans', 'serif', 'mono'] as const;

function object(value: unknown, keys: readonly string[], label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label}必须为普通对象`);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label}含未知字段，请重新生成规范方案`);
  return value as ObjectValue;
}
function text(value: unknown, label: string, max: number, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new Error(`${label}需为${min}–${max}字符的文本`);
  // 模型产物始终作为纯文本输出，避免将网页指令、代码或外部资源混入建站方案。
  // “Missing data: …”是正常业务说明；data只有带媒体类型/参数及逗号载荷时才视为URL。
  const unsafeUrl = /(?:javascript|vbscript)\s*:|\bdata\s*:\s*(?:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[^,\s]*)?,|(?:;[^,\s]*)?,)/i;
  // 技术资料常有“尺寸 < 0.1 mm”；比较符是文字，实际标签/注释和脚本协议仍拒绝。
  const html = /<\s*\/?[a-z][\w:-]*(?:\s[^>]*|\s*\/?)>|<!|<\?|<\s*\/?(?:script|iframe|img|style|object|embed)\b/i;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || html.test(value) || unsafeUrl.test(value)) throw new Error(`${label}不能包含HTML、脚本或控制字符`);
  return value.trim();
}
function choice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error(`${label}不是支持的选项`);
  return value as T;
}
function id(value: unknown, label: string, max = 40): string {
  const result = text(value, label, max);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result) || ['constructor', 'prototype', '__proto__'].includes(result)) throw new Error(`${label}格式无效`);
  return result;
}
function array(value: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${label}需为${min}–${max}项`);
  return value;
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label}不能重复`);
}
function color(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${label}必须是六位十六进制颜色`);
  return value.toLowerCase();
}
function path(value: unknown): string {
  const result = text(value, '页面路径', 120);
  if (result !== '/' && result !== '/products/:slug' && (!/^\/[a-z0-9][a-z0-9/_-]*$/.test(result) || result.endsWith('/') || result.includes('//'))) throw new Error('页面路径格式无效');
  if (/^\/(api|admin|preview|_next|images|fonts)(\/|$)/.test(result)) throw new Error('页面路径不能占用系统目录');
  return result;
}

/** 前后台共用资料边界；语言只控制生成文案，不会静默改写现站语言配置。 */
export function normalizeAiSiteBrief(value: unknown): AiSiteBrief {
  const item = object(value, ['companyName', 'description', 'industry', 'audience', 'market', 'language', 'styleNotes'], '建站资料');
  const language = text(item.language, '网站语言', 35, 2);
  if (!validLocale(language)) throw new Error('网站语言需为标准语言代码，例如en或zh-CN');
  return { companyName: text(item.companyName, '公司名称', 120, 2), description: text(item.description, '公司与产品介绍', 6000, 10), industry: text(item.industry, '行业', 300), audience: text(item.audience, '目标客户', 300), market: text(item.market, '目标市场', 300), language, styleNotes: text(item.styleNotes ?? '', '风格偏好', 2000, 0) };
}

/** 严格收敛AI输出到有限内容语法；未知属性不能穿过编译器成为组件参数。 */
export function normalizeAiSitePlan(value: unknown, brief: AiSiteBrief): AiSitePlan {
  normalizeAiSiteBrief(brief);
  const input = object(value, ['summary', 'intent', 'pages', 'directions'], '建站方案');
  let intent: AiSitePlan['intent'];
  if (input.intent !== undefined) {
    const source = object(input.intent, ['siteType', 'primaryGoal', 'audienceTasks', 'constraints', 'missingFacts'], '建站目标');
    const lines = (value: unknown, label: string, min: number, max: number, length: number) => array(value, label, min, max).map(item => text(item, label, length));
    intent = { siteType: choice(source.siteType, ['product-catalog', 'professional-services', 'brand-showcase'] as const, '网站类型'), primaryGoal: text(source.primaryGoal, '首要目标', 500), audienceTasks: lines(source.audienceTasks, '访客任务', 1, 6, 240), constraints: lines(source.constraints, '明确约束', 0, 8, 400), missingFacts: lines(source.missingFacts, '待补资料', 0, 10, 400) };
  }
  const pages: AiSitePagePlan[] = array(input.pages, '规划页面', intent ? 3 : 4, 8).map((value, index) => {
    const p = object(value, ['key', 'title', 'path', 'purpose', 'seoTitle', 'seoDescription', 'sections'], `页面${index + 1}`);
    const sections: AiSiteSection[] = array(p.sections, '页面区块', 1, 8).map((value, sectionIndex) => {
      const s = object(value, ['kind', 'heading', 'body', 'items', 'mediaId', 'layout', 'cta'], `区块${sectionIndex + 1}`);
      const section: AiSiteSection = { kind: choice(s.kind, sectionKinds, '区块类型'), heading: text(s.heading, '区块标题', 180), body: text(s.body, '区块正文', 4000, 0) };
      if (s.layout !== undefined) section.layout = choice(s.layout, AI_SECTION_LAYOUTS, '区块布局');
      if (s.items !== undefined) section.items = array(s.items, '区块条目', 1, 6).map(value => {
        const item = object(value, ['title', 'body'], '区块条目');
        return { title: text(item.title, '条目标题', 120), body: text(item.body, '条目正文', 1500, 0) };
      });
      if (s.mediaId !== undefined && s.mediaId !== '') section.mediaId = id(s.mediaId, '图片素材ID', 100);
      if (s.cta === null) section.cta = null;
      else if (s.cta !== undefined) { const action = object(s.cta, ['label', 'pageKey'], '行动按钮'); section.cta = { label: text(action.label, '行动按钮文字', 80), pageKey: id(action.pageKey, '行动按钮目标页面') }; }
      if (section.kind === 'features' && !section.items?.length) throw new Error('特点区块需至少一个基于真实资料的条目');
      return section;
    });
    if (sections[0].kind !== 'hero' || sections.filter(section => section.kind === 'hero').length !== 1) throw new Error('每页需且仅需一个位于首位的主标题区块');
    return { key: id(p.key, '页面标识'), title: text(p.title, '页面名称', 120), path: path(p.path), purpose: text(p.purpose, '页面用途', 1000), seoTitle: text(p.seoTitle, 'SEO标题', 200), seoDescription: text(p.seoDescription, 'SEO描述', 1000), sections };
  });
  unique(pages.map(page => page.key), '页面标识'); unique(pages.map(page => page.path), '页面路径');
  // 旧方案仍遵守原四页契约；新目标才允许真正的服务站/品牌站，不能悄悄改写历史方案。
  const catalog = !intent || intent.siteType === 'product-catalog' || pages.some(page => page.path === '/products' || page.path === '/products/:slug' || page.sections.some(section => section.kind === 'products'));
  const requiredPaths = !intent ? pagePaths : catalog ? ['/', '/products/:slug', '/contact'] : ['/', '/contact'];
  if (requiredPaths.some(required => !pages.some(page => page.path === required))) throw new Error(catalog ? '方案需包含首页、产品目录、产品详情和联系页面' : '方案需包含首页和联系页面');
  if (intent?.siteType === 'professional-services' && (!pages.some(page => page.path === '/services') || catalog || pages.some(page => /^\/products(?:\/|$)/.test(page.path)))) throw new Error('专业服务方案需包含服务页面，不能用产品目录或动态产品详情代替服务');
  // 普通目录可按行业命名为/components、/collections；只有原生动态详情保留系统根路径。
  if (catalog && !pages.some(page => (intent ? !['/', '/contact'].includes(page.path) && !page.path.includes(':') : page.path === '/products') && page.sections.some(section => section.kind === 'products'))) throw new Error('产品目录需包含真实产品列表区块');
  if (!pages.find(page => page.path === '/contact')!.sections.some(section => section.kind === 'contact')) throw new Error('联系页面需包含联系区块');
  for (const page of pages) for (const section of page.sections) if (section.cta) { const target = pages.find(item => item.key === section.cta!.pageKey); if (!target || target.path.includes(':')) throw new Error('行动按钮必须引用本次规划中的普通页面，不能引用详情占位或未知地址'); }
  const directions: AiSiteDirection[] = array(input.directions, '设计方向', 3, 3).map(value => {
    const d = object(value, ['id', 'name', 'rationale', 'primary', 'background', 'text', 'headingFont', 'layout'], '设计方向');
    return { id: id(d.id, '设计方向ID'), name: text(d.name, '设计方向名称', 80), rationale: text(d.rationale, '设计方向理由', 1500), primary: color(d.primary, '主题色'), background: color(d.background, '背景色'), text: color(d.text, '文字色'), headingFont: choice(d.headingFont, fonts, '标题字体'), layout: choice(d.layout, AI_SITE_LAYOUTS, '布局方向') };
  });
  unique(directions.map(direction => direction.id), '设计方向ID'); unique(directions.map(direction => direction.layout), '布局方向');
  return { summary: text(input.summary, '方案说明', 2000), ...(intent ? { intent } : {}), pages, directions };
}

function prefixPath(value: string | undefined): string {
  if (!value || value === '/') return '';
  const result = value.startsWith('/') ? value : `/${value}`;
  if (result.length > 64 || !/^\/[a-z0-9][a-z0-9_-]*$/.test(result) || /^\/(api|admin|preview|_next|images|fonts|products)$/.test(result)) throw new Error('新页面目录需为一个有效英文路径段，且不能占用系统目录');
  return result;
}
function luminance(hex: string): number {
  const values = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
function contrast(a: string, b: string): number { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function emptyInitialHome(current: DraftContent, existing: PageItem): boolean {
  const data = current.editorData[existing.id] as Data | undefined;
  const props = data?.root?.props as Record<string, unknown> | undefined;
  // 产品与素材可在建站前准备；仅允许复用仍与安装种子一致的空白首页本身。
  const hasCode = Boolean(current.customCode?.global.css || current.customCode?.global.js || Object.values(current.customCode?.pages || {}).some(code => code.css || code.js));
  const seedKeys = ['id', 'title', 'slug', 'status', 'type', 'updated'];
  return current.pages.length === 1 && existing.id === 'home' && existing.title === 'Home' && existing.slug === '/' && existing.status === 'draft' && Object.keys(existing).every(key => seedKeys.includes(key)) && !hasCode && Boolean(data && Array.isArray(data.content) && data.content.length === 0 && !data.zones && props && !props.brand && props.showChrome === 'no' && Object.keys(props).every(key => ['brand', 'showChrome'].includes(key)));
}

/** 界面可据此默认使用根首页；服务端编译仍重新核对，预先录入产品与素材不影响空首页判断。 */
export function canReplaceAiEmptyHome(current: DraftContent): boolean {
  const home = current.pages.find(page => page.slug === '/');
  return Boolean(home && emptyInitialHome(current, home));
}

function aiCatalogueCard(id: string, title: string, language: string, date: string, style: Pick<AiSiteDirection, 'background'|'primary'|'text'|'headingFont'>): SharedBlock {
  const name = `${title.slice(0, 72)} · 产品卡片`;
  const data = createContentDesignData({ name, source: 'product', kind: 'card' });
  const frame = data.content[0];
  frame.props.background = style.background;
  frame.props.design.desktop.borderColor = style.primary;
  for (const item of frame.props.content as ComponentData[]) {
    if (item.type === 'Heading') {
      item.props.level = 'h3'; item.props.style = style.headingFont === 'serif' ? 'serif' : 'sans';
    }
    if (item.type === 'Heading' || item.type === 'Text') item.props.color = style.text;
    if (item.type === 'ActionButton') item.props.text = /^zh(?:-|$)/i.test(language) ? '查看产品' : /^de(?:-|$)/i.test(language) ? 'Produkt ansehen' : 'View product';
  }
  return { id, name, data, updated: date };
}

const aiCatalogueQuery = (): ContentQuery => ({ paginate: true, pageSize: 12, controls: true, productCategories: true });

/** 经显式选择才升级同一批次内的旧主目录；原组件ID、文字、布局和产品资料不变。 */
export function upgradeLegacyAiCatalogue(current: DraftContent, compiled: AiSiteCompileResult, seedPageId: string, run: string, date: string) {
  const seed = current.editorData[seedPageId] as Data;
  const origin = /^ai-([a-f0-9]{12})-\d+$/.exec(String(seed?.content[0]?.props.id))?.[1];
  const editorData = compiled.patch.editorData;
  if (!origin || !editorData) return false;
  const group = current.pages.filter(page => compiled.pageIds.includes(page.id) && String((current.editorData[page.id] as Data)?.content[0]?.props.id).startsWith(`ai-${origin}-`));
  const ordinary = group.filter(page => !page.slug.includes(':'));
  const home = ordinary.find(page => page.slug === '/' || ordinary.every(other => other.id === page.id || other.slug.startsWith(`${page.slug}/`)));
  const directories = ordinary.filter(page => page.id !== home?.id && !page.slug.endsWith('/contact'));
  const ordered = [...directories.filter(page=>page.slug.endsWith('/products')), ...directories.filter(page=>!page.slug.endsWith('/products'))];
  const isLegacyCatalogue = (node: ComponentData) => {
    const props = node.props;
    return node.type==='ContentList' && String(props.id).startsWith(`ai-${origin}-`) && props.source==='product' && !props.modelId && !props.labels && props.count===12
      && props.titleField==='builtin:name' && props.descriptionField==='builtin:description' && props.imageField==='builtin:image' && props.linkField==='builtin:url';
  };
  for (const page of ordered) {
    const data = editorData[page.id] as Data;
    let card: SharedBlock | undefined;
    const walk = (nodes: ComponentData[]): ComponentData[] => nodes.map(node=>{
      if (card || node.props.locked) return node;
      if (!isLegacyCatalogue(node)) return mapComponentSlots(node, slot=>walk(slot.content));
      card = aiCatalogueCard(`ai-catalogue-${run}`,page.title,current.settings.language,date,{ ...current.theme, headingFont:'sans' });
      const { titleField, descriptionField, imageField, linkField, labels, ...props } = node.props;
      return { type:'ContentLoop', props:{ ...props,itemBlockId:card.id,gap:28,query:aiCatalogueQuery() } };
    });
    const content = walk(data.content);
    if (!card) continue;
    editorData[page.id] = { ...data, content };
    compiled.patch.sharedBlocks = [...(compiled.patch.sharedBlocks || current.sharedBlocks || []),card];
    compiled.warnings.push(`“${page.title}”已加入分类、产品名称及型号搜索、分页；原产品和页面资料继续沿用。`);
    return true;
  }
  return false;
}

/** 只编译原生组件和未激活模板；已有站点的新页面独立共用头尾，空站可以正式设置全站头尾。 */
export function compileAiSitePlan(plan: AiSitePlan, directionId: string, current: DraftContent, prefix?: string, options: { allowGlobalChrome?: boolean } = {}): AiSiteCompileResult {
  // 保存前再次校验模型/客户端提交的方案，不能依赖先前某次预览已检查。
  const normalized = normalizeAiSitePlan(plan, { companyName: 'AI website', description: 'Compile the reviewed site plan.', industry: 'Website', audience: 'Visitors', market: 'Global', language: 'en', styleNotes: '' });
  const direction = normalized.directions.find(item => item.id === directionId);
  if (!direction) throw new Error('请选择方案中的有效设计方向');
  const pathPrefix = prefixPath(prefix), date = new Date().toISOString(), run = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const pageIds: string[] = [], warnings: string[] = ['生成结果仅保存为草稿，请核对业务事实、图片用途和SEO内容后再发布。'];
  // 需求约束和资料缺口供站长核对，不作为对外事实、资质或占位案例写进页面。
  if (normalized.intent) warnings.push(...normalized.intent.constraints.map(value => `本次明确约束：${value}`), ...normalized.intent.missingFacts.map(value => `待补真实资料：${value}`));
  const seoIssues: AiSiteSeoIssue[] = [], additions: PageItem[] = [], templates: PageTemplate[] = [], editorData: DraftContent['editorData'] = { ...current.editorData };
  const pathFor = (value: string) => value === '/products/:slug' ? value : `${pathPrefix}${value === '/' ? '' : value}` || '/';
  const urlByKey = new Map(normalized.pages.map(page => [page.key, pathFor(page.path)]));
  const idByKey = new Map<string, string>();
  const existingDetail = current.pages.find(page => page.slug === '/products/:slug');
  for (const page of normalized.pages) {
    const target = urlByKey.get(page.key)!;
    if (page.path === '/products/:slug' && existingDetail) continue;
    const existing = current.pages.find(item => item.slug === target);
    if (existing && !(target === '/' && !pathPrefix && canReplaceAiEmptyHome(current))) throw new Error(`页面路径${target}已存在，请选择未使用的新页面目录；已有页面不会被覆盖`);
    const pageId = existing?.id || `ai-${run}-${page.key}`;
    if (existing) warnings.push('已复用首次安装的空白Home首页，其他现有页面和配置不变。');
    idByKey.set(page.key, pageId); pageIds.push(pageId);
    additions.push({ id: pageId, title: page.title, slug: target, type: page.path === '/products/:slug' ? '产品详情' : '普通页面', status: 'draft', updated: date, seoTitle: page.seoTitle, seoDescription: page.seoDescription });
  }
  if (current.pages.length + additions.filter(page => !current.pages.some(old => old.id === page.id)).length > 200) throw new Error('新增后页面超过200个，请先整理页面');
  let contactForm = current.forms?.find(item => item.enabled), createdForm = false;
  if (!contactForm) {
    if ((current.forms?.length || 0) >= 100) throw new Error('现有表单已达100个，请先启用一个可用询盘表单或整理表单');
    contactForm = createFormDefinition(`ai-inquiry-${run}`); createdForm = true;
    if (current.settings.language.startsWith('zh')) {
      contactForm.submitLabel = '提交询盘'; contactForm.successMessage = '感谢提交，我们已收到您的询盘。';
      const labels: Record<string, string> = { name: '姓名', email: '邮箱', company: '公司', message: '需求说明' };
      contactForm.fields = contactForm.fields.map(field => ({ ...field, label: labels[field.mapTo || ''] || field.label }));
    } else if (!current.settings.language.startsWith('en')) warnings.push('新增询盘表单使用英文默认标签，请按网站语言核对并翻译。');
    warnings.push('已添加可入库的默认询盘表单；邮件通知沿用原配置，未配置SMTP时不发送邮件。');
  }
  let sequence = 0;
  const node = (type: string, props: Record<string, unknown>): ComponentData => {
    const id = `ai-${run}-${++sequence}`;
    // Puck解析slot时先写content；生成时沿用该顺序，避免未编辑退出因JSON顺序差异触发伪保存。
    return { type, props: type === 'Container' ? { content: props.content, id, ...props } : { id, ...props } };
  };
  const heading = (value: string, level = 'h2', size = 38) => node('Heading', { text: value, level, size, mobileSize: Math.min(size, 34), color: direction.text, align: direction.layout === 'showcase' ? 'center' : 'left', style: direction.headingFont === 'serif' ? 'serif' : 'sans', spacing: 0, design: { desktop: { fontFamily: direction.headingFont, fontWeight: direction.layout === 'catalog' ? 600 : 500, lineHeight: 1.12, letterSpacing: -0.6 }, mobile: { fontSize: Math.min(size, 34), letterSpacing: -0.3 } } });
  const copy = (value: string) => node('Text', { text: value, size: 17, color: direction.text, align: direction.layout === 'showcase' ? 'center' : 'left', maxWidth: 820, design: { desktop: { lineHeight: 1.75, opacity: 0.85 }, mobile: { fontSize: 16 } } });
  // 原生Container的legacy手机左右默认24；内层必须显式归零，由外层section统一留白。
  const box = (content: ComponentData[], options: { columns?: number; surface?: boolean; spacing?: number; design?: DesignValues; mobile?: DesignValues; label?: string } = {}) => node('Container', { content, layout: (options.columns || 1) > 1 ? 'grid' : 'column', columns: options.columns || 1, mobileColumns: 1, gap: options.spacing ?? 24, padding: 0, inset: 0, background: options.surface ? direction.background : 'transparent', image: '', minHeight: 0, align: 'start', ...(options.label ? { nodeLabel: options.label } : {}), design: { desktop: { alignItems: 'start', ...options.design }, tablet: { columns: Math.min(options.columns || 1, 2), columnSpan: 1 }, mobile: { columns: 1, columnSpan: 1, gap: 20, paddingLeft: 0, paddingRight: 0, ...options.mobile } } });
  const section = (content: ComponentData[], index: number, label: string, columns = 1) => box(content, { columns, surface: true, spacing: direction.layout === 'catalog' ? 28 : direction.layout === 'bento' ? 24 : direction.layout === 'minimal' ? 64 : 44, label, design: { paddingTop: direction.layout === 'showcase' ? 90 : direction.layout === 'minimal' ? 88 : 64, paddingBottom: direction.layout === 'showcase' ? 90 : direction.layout === 'minimal' ? 88 : 64, paddingLeft: 48, paddingRight: 48, borderWidth: ['catalog', 'minimal'].includes(direction.layout) && index > 0 ? 1 : 0, borderColor: direction.primary, maxWidth: 1440, marginLeft: 'auto', marginRight: 'auto' } });
  const button = (value: string, href: string, targetId?: string) => node('ActionButton', { text: value, href, ...(targetId ? { linkTarget: { kind: 'page', id: targetId } } : {}), kind: 'theme', align: direction.layout === 'showcase' ? 'center' : 'left', design: { desktop: { backgroundColor: direction.primary, color: contrast(direction.primary, '#ffffff') >= contrast(direction.primary, '#000000') ? '#ffffff' : '#000000', borderColor: direction.primary, borderWidth: 1, borderRadius: direction.layout === 'catalog' ? 4 : 0, height: 46, paddingLeft: 24, paddingRight: 24 } } });
  const siteType = normalized.intent?.siteType, contactPlan = normalized.pages.find(page => page.path === '/contact')!;
  const chrome = createAiBuildSharedLayout({ current, pages: additions, direction, run, date, contactPageId: idByKey.get(contactPlan.key)!, firstRootBuild: options.allowGlobalChrome !== false && !pathPrefix && (!current.pages.length || canReplaceAiEmptyHome(current)) });
  warnings.push(chrome.global ? '新页面共用全站页眉、页脚和导航。首次发布请选择对应同步区块和公共布局。' : '本次新页面共用一组独立头尾和导航，可以统一编辑；现有全站布局继续适用。');
  const cataloguePlan = normalized.pages.find(page => page.path === '/products' && page.sections.some(section => section.kind === 'products')) || (normalized.intent ? normalized.pages.find(page => !['/', '/contact'].includes(page.path) && !page.path.includes(':') && page.sections.some(section => section.kind === 'products')) : undefined);
  let catalogueCard: SharedBlock | undefined;
  const productCollection = (page: AiSitePagePlan, section: AiSiteSection, columns: number) => {
    const design = { desktop: { color: direction.text, gap: 28 }, mobile: { columns: 1, paddingLeft: 0, paddingRight: 0 } };
    const props = { source: 'product', modelId: '', title: '', count: 12, columns, mobileColumns: 1, emptyText: section.body || section.heading, padding: 0, design };
    // 首页精选仍是紧凑列表；主目录使用可拖拽的共享卡片和已有查询分页，Excel产品也能按原分类查找。
    if (page.key !== cataloguePlan?.key) return node('ContentList', { ...props, titleField: 'builtin:name', descriptionField: 'builtin:description', imageField: 'builtin:image', linkField: 'builtin:url' });
    catalogueCard ||= aiCatalogueCard(`ai-catalogue-${run}`,cataloguePlan.title,current.settings.language,date,direction);
    return node('ContentLoop', { ...props, itemBlockId: catalogueCard.id, gap: 28, query: aiCatalogueQuery() });
  };
  const primaryPlan = cataloguePlan || normalized.pages.find(page => page.path === '/services') || normalized.pages.find(page => !['/', '/contact'].includes(page.path) && !page.path.includes(':')) || contactPlan;
  const contactButton = (label: string) => button(label, pathFor('/contact'), idByKey.get(contactPlan.key));
  const actionFor = (s: AiSiteSection, fallback: AiSitePagePlan) => { const target = s.cta ? normalized.pages.find(page => page.key === s.cta!.pageKey)! : fallback; return button(s.cta?.label || target.title, pathFor(target.path), idByKey.get(target.key)); };
  // 用户明确隐藏时保留关闭状态，重新选择方向也不回填自动按钮。
  const heroActions = (s: AiSiteSection, page: AiSitePagePlan) => s.cta === null ? [] : s.cta ? [actionFor(s, primaryPlan)] : page.path === '/products/:slug' || page.path === '/contact' ? [] : [actionFor(s, normalized.intent && page.path === primaryPlan.path ? contactPlan : primaryPlan)];
  const followupActions = (s: AiSiteSection, page: AiSitePagePlan, last: boolean) => s.cta === null ? [] : s.cta ? [actionFor(s, contactPlan)] : s.kind === 'products' || s.kind === 'contact' || page.path === '/contact' || normalized.intent && !last ? [] : [contactButton(contactPlan.title)];
  const imageFor = (s: AiSiteSection) => {
    if (!s.mediaId) return undefined;
    const media = current.media.find(item => item.id === s.mediaId);
    if (!media || media.kind !== 'image' || !isLocalImagePath(media.url)) throw new Error(`区块“${s.heading}”引用的图片素材不存在或不是可用图片，请重新选择素材`);
    return node('Image', { src: media.url, alt: media.alt || s.heading, height: direction.layout === 'showcase' ? 520 : 420, fit: 'cover', radius: direction.layout === 'catalog' ? 6 : 0, design: { desktop: { width: '100%', height: direction.layout === 'showcase' ? 520 : 420 }, tablet: { height: 360 }, mobile: { height: 280 } } });
  };
  // 跨列只作用于桌面；平板/手机同时重置跨行跨列，避免继承后产生隐式溢出列。
  const span = (item: ComponentData, columns: number, rows = 1) => {
    const design = item.props.design as Record<string, DesignValues> | undefined;
    item.props.design = { ...design, desktop: { ...design?.desktop, columnSpan: columns, rowSpan: rows }, tablet: { ...design?.tablet, columnSpan: 1, rowSpan: 1 }, mobile: { ...design?.mobile, columnSpan: 1, rowSpan: 1 } };
    return item;
  };
  const mobileSection = (item: ComponentData, tabletColumns = 1) => {
    const design = item.props.design as Record<string, DesignValues>;
    design.tablet = { columns: tabletColumns, paddingLeft: 32, paddingRight: 32, paddingTop: 48, paddingBottom: 48 };
    design.mobile = { columns: 1, paddingLeft: 20, paddingRight: 20, paddingTop: 40, paddingBottom: 40, gap: 24 };
    return item;
  };
  const secondaryProductIntro = (item: ComponentData) => {
    const design = item.props.design as Record<string, DesignValues>;
    // 详情先识别真实产品；通用原文保留作说明，不再占用主视觉的字号和整屏留白。
    for (const device of ['desktop','tablet','mobile']) design[device] = { ...design[device], paddingTop: 24, paddingBottom: 24 };
    return item;
  };
  const ordinal = (index: number) => node('Text', { text: String(index + 1).padStart(2, '0'), size: 15, color: direction.primary, align: 'left', maxWidth: 120, design: { desktop: { fontFamily: 'mono', fontWeight: 600 }, mobile: { fontSize: 14 } } });
  const mobileDesign = (item: ComponentData, value: DesignValues) => {
    const design = item.props.design as Record<string, DesignValues> | undefined;
    item.props.design = { ...design, mobile: { ...design?.mobile, ...value } }; return item;
  };
  const mobileItems = (list: ComponentData, items: NonNullable<AiSiteSection['items']>) => {
    // 只改变有意图且auto条目的手机组织；索引仅对应原条目顺序，不捏造业务流程或统计。
    const cards = list.props.content as ComponentData[];
    const short = (value: typeof items[number]) => value.title.length <= 20 && (value.title.match(/[A-Za-z]+/g)||[]).every(word=>word.length<=10) && !/[^\x00-\x7f]/.test(value.title) && value.body.length<=72 && (value.body.match(/[A-Za-z]+/g)||[]).every(word=>word.length<=15);
    mobileDesign(list, { columns: direction.layout === 'split' ? 2 : 1, gap: direction.layout === 'catalog' ? 0 : 20 });
    cards.forEach((card,index)=>{
      const old = card.props.content as ComponentData[], group = old.find(item=>item.type==='Container');
      // 仅旧steps的“编号+说明组”可复用索引，纯数字业务正文不能被误认或重复放入编号轨。
      const oldIndex = group ? old.find(item=>item.type==='Text' && /^\d{2}$/.test(String(item.props.text))) : undefined;
      if(oldIndex)oldIndex.props.nodeLabel='条目编号';
      const original = group ? group.props.content as ComponentData[] : old;
      const title = original.find(item=>item.type==='Heading')!, body = original.find(item=>item.type==='Text' && item!==oldIndex);
      if(direction.layout==='editorial'){mobileDesign(card,{columns:1,columnSpan:1,minHeight:0});return;}
      if(direction.layout==='split' && short(items[index])){
        mobileDesign(card,{columns:1,columnSpan:1,minHeight:0});mobileDesign(title,{fontSize:20});return;
      }
      const marker=oldIndex||ordinal(index);
      // 原桌面没有编号时仅手机显示装饰索引；原事实文字/图片从不复制或按断点隐藏。
      if(!oldIndex){marker.props.nodeLabel='条目编号';const design=marker.props.design as Record<string,DesignValues>;design.desktop.display='none';design.tablet={display:'none'};}
      mobileDesign(marker,{display:'block',columnSpan:1,rowSpan:1});
      mobileDesign(card,{columns:8,columnSpan:direction.layout==='split'?2:1,gap:12,minHeight:0});
      if(direction.layout==='catalog'){
        const copyGroup=group||box(original,{spacing:14});card.props.content=[marker,copyGroup];
        mobileDesign(copyGroup,{columnSpan:7,rowSpan:1});return;
      }
      // 将一个条目的原标题/原正文放入同一原生网格，手机正文可全跨；不拆长文去凑多栏。
      card.props.content=[marker,title,...(body?[body]:[])];
      if(oldIndex){
        const markerDesign=marker.props.design as Record<string,DesignValues>;markerDesign.desktop.rowSpan=body?2:1;markerDesign.tablet={...markerDesign.tablet,rowSpan:1,columnSpan:1};
        for(const item of [title,...(body?[body]:[])]){const design=item.props.design as Record<string,DesignValues>;design.desktop={...design.desktop,columnSpan:3};design.tablet={...design.tablet,columnSpan:item===body?2:1,rowSpan:1};}
      }
      const rightIndex=direction.layout==='showcase'||direction.layout==='split'&&index%2===1;
      mobileDesign(title,{columnSpan:direction.layout==='bento'?8:7,order:rightIndex||direction.layout==='bento'?0:1});
      mobileDesign(marker,{order:rightIndex||direction.layout==='bento'?1:0});
      if(body)mobileDesign(body,{columnSpan:direction.layout==='bento'?7:8,order:2});
    });
    return list;
  };
  const featureItems = (s: AiSiteSection, intent: string, autoMobile = false) => {
    if (!s.items?.length) return undefined;
    const finish=(value:ComponentData)=>autoMobile?mobileItems(value,s.items!):value;
    // 编号仅表示资料条目的顺序，不将条目捏造成产能、年限或业务流程事实。
    if (intent === 'steps') return finish(box(s.items.map((item, index) => box([ordinal(index), span(box([heading(item.title, 'h3', 25), ...(item.body ? [copy(item.body)] : [])], { spacing: 12 }), 3)], { columns: 4, spacing: 18, design: { paddingTop: 24, paddingBottom: 24, borderWidth: 1, borderColor: direction.primary }, mobile: { paddingLeft: 16, paddingRight: 16 } })), { spacing: 0 }));
    const bento = direction.layout === 'bento' && intent !== 'stacked', count = s.items.length;
    const cards = s.items.map((item, index) => {
      // 品牌叙事以安静的连续文字呈现；显式选择cards/steps时仍尊重用户的局部编排。
      const narrative = siteType === 'brand-showcase' && intent === 'stacked';
      const card = box([heading(item.title, 'h3', 25), ...(item.body ? [copy(item.body)] : [])], { spacing: 14, design: { borderWidth: narrative ? 0 : 1, borderColor: direction.primary, borderRadius: bento ? 16 : 0, paddingTop: 28, paddingBottom: 28, paddingLeft: narrative ? 0 : 24, paddingRight: narrative ? 0 : 24, minHeight: bento ? 220 : 0 }, mobile: { paddingLeft: narrative ? 0 : 16, paddingRight: narrative ? 0 : 16 } });
      // 1–6条均填满四列：首卡较宽，尾行不足三条时整行/半行收束。
      const columns = count === 1 || count === 4 && index === 3 ? 4 : count === 2 || count === 5 && index >= 3 || index % 3 === 0 ? 2 : 1;
      if (bento) span(card, columns);
      return card;
    });
    return finish(box(cards, { columns: bento ? 4 : intent === 'stacked' ? 1 : 2, spacing: bento ? 20 : 28 }));
  };
  const autoMobileHero = (item: ComponentData, s: AiSiteSection) => {
    if(!siteType || s.layout && s.layout!=='auto')return item;
    const visit=(parent:ComponentData)=>{
      if(parent.type!=='Container')return;
      const children=parent.props.content as ComponentData[];
      if(direction.layout==='minimal' && siteType!=='brand-showcase' && children.some(child=>child.type==='Image')){
        // 服务minimal的CTA原在说明组内；提到同级后手机才能行动→图→完整说明，桌面仍说明→行动→图。
        const support=children.find(child=>child.type==='Container' && (child.props.content as ComponentData[]).some(node=>node.type==='ActionButton'));
        if(support){const content=support.props.content as ComponentData[],actions=content.filter(child=>child.type==='ActionButton');support.props.content=content.filter(child=>child.type!=='ActionButton');children.splice(children.indexOf(support)+1,0,...actions);}
      }
      const hasAction=children.some(child=>child.type==='ActionButton'),hasTitle=children.some(child=>child.type==='Heading'&&child.props.level==='h1');
      if(hasAction && ['catalog','minimal','showcase'].includes(direction.layout)){
        for(const child of children)mobileDesign(child,{order:child.type==='Heading'&&child.props.level==='h1'?0:child.type==='ActionButton'?hasTitle?1:0:child.type==='Image'&&direction.layout==='minimal'?hasTitle?2:1:hasTitle?3:2});
      }
      children.forEach(visit);
    };
    visit(item);
    if(direction.layout==='bento' && siteType!=='product-catalog'){
      const image=(item.props.content as ComponentData[]).find(child=>child.type==='Image');if(image)mobileDesign(image,{order:-1});
    }
    return item;
  };
  const autoMobileProductText = (item: ComponentData, s: AiSiteSection, productDetail: boolean) => {
    if(siteType!=='product-catalog'||direction.layout!=='minimal'||productDetail||s.kind!=='text'||!s.mediaId||s.layout&&s.layout!=='auto')return item;
    // 制造首页无图不代表整页无图：仅让既有文字段配图在手机先于说明，标题/CTA/桌面和原图原文均保留。
    const visit=(parent:ComponentData)=>{
      if(parent.type!=='Container')return;
      for(const child of parent.props.content as ComponentData[]){
        if(child.type==='Image')mobileDesign(child,{order:-1,height:200});else visit(child);
      }
    };
    visit(item);return item;
  };
  const industryHero = (s: AiSiteSection, page: AiSitePagePlan, index: number, image: ComponentData | undefined) => {
    if (!siteType || siteType === 'product-catalog' || page.path === '/products/:slug' || s.layout && s.layout !== 'auto') return undefined;
    // 行业目标改变真实槽位和视觉主次，不把服务强塞成商品卡，也不靠换色伪造设计差异。
    // 配图窄栏不能照搬全宽76px标题；字号与可用栏宽共同约束，避免Furniture被拆词。
    const brand = siteType === 'brand-showcase', narrowBrand = brand && image && ['catalog','split'].includes(direction.layout), title = heading(s.heading, 'h1', brand ? narrowBrand ? 52 : direction.layout === 'minimal' ? 88 : 76 : direction.layout === 'minimal' ? 80 : 60);
    const body = s.body ? [copy(s.body)] : [], actions = heroActions(s, page), items = featureItems(s, brand ? 'stacked' : 'steps',true);
    const support = box([...body, ...(items ? [items] : []), ...actions], { spacing: 26, design: { maxWidth: brand ? 620 : 740 } });
    if (image) {
      const design = image.props.design as Record<string, DesignValues>;
      image.props.height = brand ? 600 : 320;
      design.desktop.height = brand ? 600 : 320; design.tablet.height = brand ? 420 : 300; design.mobile.height = brand ? 320 : 240;
    }
    let parts: ComponentData[], columns = 1;
    if (brand) {
      if (direction.layout === 'editorial') parts = [...(image ? [image] : []), box([span(title, 2), support], { columns: 3, spacing: 44 })];
      else if (direction.layout === 'catalog') { parts = [box([title, support], { spacing: 32 }), ...(image ? [image] : [])]; columns = image ? 2 : 1; }
      else if (direction.layout === 'split') { parts = [...(image ? [span(image, 2)] : []), box([title, support], { spacing: 32 })]; columns = image ? 3 : 1; }
      else if (direction.layout === 'bento') { parts = [span(title, 4), ...(image ? [span(image, 3), support] : [span(support, 4)])]; columns = 4; }
      else if (direction.layout === 'minimal') parts = [title, ...(image ? [image] : []), box([support], { design: { maxWidth: 620, marginLeft: 'auto' } })];
      else parts = [...(image ? [image] : []), box([title, support], { spacing: 32, design: { maxWidth: 1000, marginLeft: 'auto', marginRight: 'auto', justifyContent: 'center' } })];
    } else {
      if (direction.layout === 'editorial') { parts = [span(title, 2), box([support, ...(image ? [image] : [])], { spacing: 32 })]; columns = 3; }
      else if (direction.layout === 'catalog') { parts = [title, box([support, ...(image ? [image] : [])], { spacing: 28 })]; columns = 2; }
      else if (direction.layout === 'split') { parts = image ? [image, span(box([title, support], { spacing: 32 }), 2)] : [title, span(support, 2)]; columns = 3; }
      else if (direction.layout === 'bento') { parts = [span(title, 3), support, ...(image ? [span(image, 4)] : [])]; columns = 4; }
      else if (direction.layout === 'minimal') parts = [title, box([support, ...(image ? [image] : [])], { spacing: 32, design: { maxWidth: 760, marginLeft: 'auto' } })];
      else parts = [...(image ? [image] : []), box([title, support], { spacing: 32 })];
    }
    // 无图时仅排真实文字；所有桌面跨列在平板/手机显式复位，原生拖拽后仍能逐项编辑。
    return autoMobileHero(mobileSection(section(parts, index, s.heading, columns)),s);
  };
  const ordinaryInnerSection = (s: AiSiteSection, page: AiSitePagePlan, index: number, last: boolean, image: ComponentData | undefined) => {
    if(!siteType||page.path==='/'||page.path.includes(':')||s.layout&&s.layout!=='auto')return undefined;
    // 角色只选已有普通页的阅读排版，不添加内容模型、案例、客户成果或未经提供的业务事实。
    const role=page.path==='/contact'||page.sections.some(section=>section.kind==='contact')?'contact':page.sections.some(section=>section.kind==='products')?'catalogue':
      ['/approach','/how-we-work','/our-approach'].includes(page.path)||['approach','howwework'].includes(page.key)?'approach':siteType==='professional-services'&&page.path==='/services'?'services':'narrative';
    const hero=s.kind==='hero',title=heading(s.heading,hero?'h1':'h2',hero?48:32),body=s.body?[copy(s.body)]:[],actions=hero?heroActions(s,page):followupActions(s,page,last);
    body.forEach(item=>{item.props.maxWidth=760;});
    const itemIntent=role==='approach'||role==='services'&&['catalog','minimal'].includes(direction.layout)?'steps':role==='narrative'?'stacked':'cards';
    const items=s.kind==='products'?undefined:featureItems(s,itemIntent,true);
    if(items&&direction.layout==='bento'&&itemIntent==='cards')for(const card of items.props.content as ComponentData[]){
      // 内页服务说明需要可读宽度，长标题/长正文不落入四分之一窄卡。
      const long=(s.items||[]).some(item=>item.title.length>30||item.body.length>140);const design=card.props.design as Record<string,DesignValues>;design.desktop.columnSpan=long?4:2;
    }
    if(image){const design=image.props.design as Record<string,DesignValues>;const height=hero&&role!=='narrative'?240:420;image.props.height=height;design.desktop.height=height;design.tablet.height=Math.min(height,320);design.mobile.height=hero&&role!=='narrative'?180:260;}
    const finish=(value:ComponentData)=>{
      mobileSection(value);const design=value.props.design as Record<string,DesignValues>;
      if(hero){design.desktop={...design.desktop,paddingTop:40,paddingBottom:40};design.mobile={...design.mobile,paddingTop:28,paddingBottom:28};}
      return value;
    };
    if(hero){
      // 导读标题独占完整宽度；保留所有正文，不把目录变成占满首屏的装饰大海报。
      const summary=[...body,...(items?[items]:[])],intro=summary.length?box(summary,{spacing:24,label:'内页导读',design:{maxWidth:760}}):undefined;
      const visual=role==='narrative'&&image,parts:ComponentData[]=[span(title,3)];
      if(visual&&image){
        const broad=['showcase','minimal'].includes(direction.layout),readingFirst=['catalog','bento'].includes(direction.layout);
        if(readingFirst){if(intro)parts.push(span(intro,2));parts.push(span(image,intro?1:3));}
        else{parts.push(span(image,broad?3:direction.layout==='split'?1:2));if(intro)parts.push(span(intro,broad?3:direction.layout==='split'?2:1));}
      }
      else{if(intro)parts.push(span(intro,image?2:3));if(image)parts.push(span(image,1));}
      parts.push(...actions.map(action=>span(action,3)));
      const value=finish(section(parts,index,s.heading,3));
      const earlyAction=['catalog','minimal','bento'].includes(direction.layout),visualFirst=role==='narrative'&&['editorial','showcase','split'].includes(direction.layout);
      mobileDesign(title,{order:0});if(intro)mobileDesign(intro,{order:earlyAction?3:visualFirst?2:1});
      actions.forEach(action=>mobileDesign(action,{order:earlyAction?1:3}));if(image)mobileDesign(image,{order:earlyAction&&direction.layout==='minimal'?2:visualFirst?1:4});
      return value;
    }
    if(s.kind==='products'){
      // 目录仍读取同一原生动态列表；不复制商品卡，不裁掉描述，也不凭空承诺额外SKU字段。
      const intro=box([title,...body,...(image?[image]:[]),...actions],{spacing:22,label:'目录说明'});
      const list=productCollection(page,s,2);
      const columns=['catalog','bento','split'].includes(direction.layout)?4:direction.layout==='minimal'?3:1;
      // DOM始终先导读后实际链接；宽窄变化不反转键盘/读屏次序。
      const split=direction.layout==='split',parts=columns===1?[intro,list]:split?[span(intro,2),span(list,2)]:[intro,span(list,columns-1)];
      mobileDesign(intro,{order:0});mobileDesign(list,{order:1});
      if(direction.layout==='minimal'){mobileDesign(title,{order:0});actions.forEach(action=>mobileDesign(action,{order:1}));body.forEach(item=>mobileDesign(item,{order:2}));}
      return finish(section(parts,index,s.heading,columns));
    }
    if(s.kind==='contact'){
      const intro=box([title,...body,...(image?[image]:[]),...(items?[items]:[]),...actions],{spacing:24,label:'联系说明'});
      const form=span(node('Form',{formId:contactForm.id,buttonAlign:'left',design:{desktop:{maxWidth:760,gap:24},mobile:{columns:1,gap:20,paddingLeft:0,paddingRight:0}},submitDesign:{desktop:{backgroundColor:direction.primary,borderColor:direction.primary,color:contrast(direction.primary,'#ffffff')>=contrast(direction.primary,'#000000')?'#ffffff':'#000000'}}}),2);
      mobileDesign(intro,{order:0});mobileDesign(form,{order:1});
      if(direction.layout==='minimal')return finish(section([intro,span(form,1)],index,s.heading));
      const balanced=['split','showcase'].includes(direction.layout);
      return finish(section(balanced?[span(intro,2),form]:[intro,form],index,s.heading,balanced?4:3));
    }
    if(s.kind==='features'&&items){
      const intro=box([title,...body,...(image?[image]:[]),...actions],{spacing:24,label:role==='approach'?'原资料条目导读':'服务与资料导读'}),wide=direction.layout==='showcase'||direction.layout==='minimal';
      const columns=['catalog','split'].includes(direction.layout)?4:3,parts=wide?[span(intro,columns),span(items,columns)]:direction.layout==='split'?[span(intro,2),span(items,2)]:[intro,span(items,columns-1)];
      mobileDesign(intro,{order:0});mobileDesign(items,{order:1});return finish(section(parts,index,s.heading,columns));
    }
    const articleParts=[...body,...(image?[image]:[]),...(items?[items]:[]),...actions];
    if(!articleParts.length)return finish(section([title],index,s.heading));
    if(role==='narrative'&&direction.layout==='catalog'&&image){
      // 有真实配图的叙事段采用同级图文对照；文字仍为整段，不能只换一层包装冒充新结构。
      const reading=box([...body,...(items?[items]:[]),...actions],{spacing:28,label:'内页正文',design:{maxWidth:760}});
      return finish(section([span(title,4),span(reading,2),span(image,2)],index,s.heading,4));
    }
    const article=box(articleParts,{spacing:28,label:'内页正文',design:{maxWidth:760}}),reading=role==='narrative'&&direction.layout==='minimal',value=finish(section(reading?[title,article]:[title,span(article,2)],index,s.heading,reading?1:3));
    if(image&&['split','showcase'].includes(direction.layout))mobileDesign(image,{order:-1});
    return autoMobileProductText(value,s,false);
  };
  for (const page of normalized.pages) {
    const productDetail = page.path === '/products/:slug';
    // 只为新auto详情选择选型/概览模式；旧无intent和显式局部选择继续原身份与图片合同。
    const autoDetail=Boolean(siteType&&(!page.sections[0].layout||page.sections[0].layout==='auto'));
    const detailOrder=autoDetail&&siteType==='product-catalog'&&['catalog','minimal'].includes(direction.layout)?'specifications-first':autoDetail&&(['editorial','split'].includes(direction.layout)&&siteType==='product-catalog'||direction.layout==='editorial'&&siteType==='brand-showcase')?'overview-first':'identity-first';
    const taskDetail=detailOrder!=='identity-first',detailLayout=taskDetail?'split':['minimal','showcase'].includes(direction.layout)?'stacked':'split';
    let sections = [...page.sections];
    // 方向改变信息编排与容器结构；旧三方向未指定局部意图时保留原有编排。
    if (direction.layout === 'catalog' && !productDetail) sections = [sections[0], ...sections.slice(1).filter(item => item.kind === 'products'), ...sections.slice(1).filter(item => item.kind !== 'products')];
    if (direction.layout === 'showcase' && !productDetail) sections = [sections[0], ...sections.slice(1).filter(item => item.kind !== 'contact'), ...sections.slice(1).filter(item => item.kind === 'contact')];
    const { rootProps, header, footer } = chrome.pageChrome();
    const content: ComponentData[] = header ? [header] : [];
    // 动态身份只渲染一次；询盘显式引用本次联系页，避免固定根详情或未激活模板串到旧站联系页。
    if (productDetail) content.push(mobileSection(section([node('ProductDetail', { productId: '', layout: detailLayout, imageHeight: taskDetail?420:480, padding: 0, cta: contactPlan.title, linkTarget: { kind: 'page', id: idByKey.get(contactPlan.key)! }, mobileOrder: detailOrder, ctaColor: direction.primary, showCustomFields: 'yes', design: { desktop: { color: direction.text, fontFamily: direction.headingFont, columns: detailLayout==='stacked'?1:2, paddingLeft: 0, paddingRight: 0,...(taskDetail?{gap:48}:{}) }, mobile: { columns: 1, imageHeight: taskDetail?260:300, paddingLeft: 0, paddingRight: 0,...(taskDetail?{gap:24}:{}) } } })], 0, '真实产品动态详情')));
    for (let index = 0; index < sections.length; index++) {
      const original = sections[index], s = normalized.intent && (!original.layout || original.layout === 'auto') && original.kind === 'features' ? { ...original, layout: siteType === 'professional-services' ? 'steps' as const : siteType === 'brand-showcase' ? 'stacked' as const : 'cards' as const } : original, image = imageFor(s), elements: ComponentData[] = [];
      // 产品卡片只从业务记录动态展示；模型复制的条目会重复且无法跟随后台编辑和语言记录更新。
      if (s.kind === 'products' && s.items?.length) warnings.push(`页面“${page.title}”的产品区块使用后台真实产品列表，未采用额外静态条目，避免重复显示与资料不同步；补充说明可放在文字或特点区块。`);
      const inner=ordinaryInnerSection(original,page,index,index===sections.length-1,image);
      if(inner){content.push(inner);continue;}
      const contextualHero = s.kind === 'hero' ? industryHero(s, page, index, image) : undefined;
      if (contextualHero) { content.push(contextualHero); continue; }
      const modern = ['split', 'bento', 'minimal'].includes(direction.layout), explicit = s.layout && s.layout !== 'auto';
      if (modern || explicit) {
        const intent = explicit ? s.layout! : direction.layout === 'split' ? index % 2 ? 'split-left' : 'split-right' : direction.layout === 'bento' ? 'cards' : 'steps';
        const hero = s.kind === 'hero', title = heading(s.heading, hero && !productDetail ? 'h1' : 'h2', hero ? productDetail ? 28 : direction.layout === 'minimal' ? 88 : direction.layout === 'split' ? 68 : 64 : 38);
        const body = s.body ? [copy(s.body)] : [], actions = hero ? heroActions(s, page) : followupActions(s, page, index === sections.length - 1);
        const details: ComponentData[] = [];
        const items = s.kind === 'products' ? undefined : featureItems(s, intent === 'steps' ? 'steps' : intent === 'stacked' ? 'stacked' : 'cards',Boolean(siteType && (!original.layout || original.layout==='auto'))); if (items) details.push(items);
        if (s.kind === 'products') details.push(productCollection(page,s,direction.layout === 'bento' ? 3 : direction.layout === 'minimal' ? 1 : 2));
        if (s.kind === 'contact') details.push(node('Form', { formId: contactForm.id, buttonAlign: 'left', design: { desktop: { maxWidth: 900, gap: 24 }, mobile: { columns: 1, gap: 20 } }, submitDesign: { desktop: { backgroundColor: direction.primary, borderColor: direction.primary, color: contrast(direction.primary, '#ffffff') >= contrast(direction.primary, '#000000') ? '#ffffff' : '#000000' } } }));
        let value: ComponentData;
        if (intent === 'split-left' || intent === 'split-right') {
          const intro = box([title, ...body, ...details, ...actions], { spacing: hero ? 28 : 24 });
          // 图片缺失时不生成空图框或虚构素材，只留下可编辑文字和真实动态组件。
          value = image ? section(intent === 'split-left' ? [span(image, 1), span(intro, 2)] : [span(intro, 2), span(image, 1)], index, s.heading, 3) : section([intro], index, s.heading);
        } else if (intent === 'cards') {
          const intro = box([title, ...body, ...actions], { spacing: 24, design: direction.layout === 'bento' ? { paddingTop: 32, paddingBottom: 32, paddingLeft: 32, paddingRight: 32, borderWidth: 1, borderColor: direction.primary, borderRadius: 20 } : {}, ...(direction.layout === 'bento' ? { mobile: { paddingLeft: 16, paddingRight: 16 } } : {}) });
          if (image) { image.props.radius = direction.layout === 'bento' ? 20 : 0; (image.props.design as Record<string, DesignValues>).desktop.borderRadius = direction.layout === 'bento' ? 20 : 0; }
          const detailBox = details.length ? box(details, { spacing: 28 }) : undefined;
          value = section(image ? [span(intro, 2), span(image, 2), ...(detailBox ? [span(detailBox, 4)] : [])] : hero ? [title, box([...body, ...actions], { spacing: 24 }), ...(detailBox ? [span(detailBox, 2)] : [])] : [intro, ...details], index, s.heading, image ? 4 : hero ? 2 : 1);
        } else if (intent === 'steps' && direction.layout === 'minimal') {
          const narrative = [...body, ...(image ? [image] : []), ...details, ...actions];
          value = hero ? section([title, ...(narrative.length ? [box(narrative, { spacing: 28, design: { maxWidth: 760, marginLeft: 'auto' } })] : [])], index, s.heading) : section([title, span(box(narrative, { spacing: 28 }), 2)], index, s.heading, 3);
        } else {
          value = section([box([title, ...body], { spacing: 24 }), ...(image ? [image] : []), ...details, ...actions], index, s.heading);
        }
        content.push(hero && productDetail ? secondaryProductIntro(mobileSection(value)) : hero ? autoMobileHero(mobileSection(value),original) : autoMobileProductText(mobileSection(value),original,productDetail));
        continue;
      }
      if (s.kind === 'hero') {
        const title = heading(s.heading, productDetail ? 'h2' : 'h1', productDetail ? 28 : direction.layout === 'showcase' ? 76 : direction.layout === 'catalog' ? 52 : 64);
        const intro = box([title, ...(s.body ? [copy(s.body)] : []), ...heroActions(s, page)], { spacing: 26 });
        elements.push(...(image && direction.layout === 'editorial' ? [intro, image] : image && direction.layout === 'showcase' ? [image, intro] : [intro, ...(image ? [image] : [])]));
        const value = section(elements, index, s.heading, image && direction.layout === 'editorial' ? 2 : 1);
        // 真实手机留白属于编译产物，不能依赖桌面padding或现站主题恰好合适。
        (value.props.design as Record<string, DesignValues>).tablet = { columns: 1, paddingLeft: 32, paddingRight: 32, paddingTop: 48, paddingBottom: 48 };
        (value.props.design as Record<string, DesignValues>).mobile = { columns: 1, paddingLeft: 20, paddingRight: 20, paddingTop: 40, paddingBottom: 40, gap: 24 };
        content.push(productDetail ? secondaryProductIntro(value) : autoMobileHero(value,original));
        continue;
      }
      elements.push(heading(s.heading));
      if (s.body) elements.push(copy(s.body));
      if (image) elements.push(image);
      if (s.kind !== 'products' && s.items?.length) elements.push(box(s.items.map(item => box([heading(item.title, 'h3', 25), ...(item.body ? [copy(item.body)] : [])], { spacing: 14, design: { borderWidth: direction.layout === 'catalog' ? 1 : 0, borderColor: direction.primary, paddingTop: 24, paddingBottom: 24, paddingLeft: direction.layout === 'catalog' ? 24 : 0, paddingRight: direction.layout === 'catalog' ? 24 : 0 }, ...(direction.layout === 'catalog' ? { mobile: { paddingLeft: 16, paddingRight: 16 } } : {}) })), { columns: direction.layout === 'editorial' ? 2 : direction.layout === 'catalog' ? 3 : 1, spacing: 28 }));
      if (s.kind === 'products') elements.push(productCollection(page,s,direction.layout === 'catalog' ? 3 : 2));
      if (s.kind === 'contact') {
        elements.push(node('Form', { formId: contactForm.id, buttonAlign: 'left', design: { desktop: { maxWidth: 900, gap: 24 }, mobile: { columns: 1, gap: 20 } }, submitDesign: { desktop: { backgroundColor: direction.primary, borderColor: direction.primary, color: contrast(direction.primary, '#ffffff') >= contrast(direction.primary, '#000000') ? '#ffffff' : '#000000' } } }));
      }
      elements.push(...followupActions(s, page, index === sections.length - 1));
      const value = section(elements, index, s.heading);
      (value.props.design as Record<string, DesignValues>).tablet = { columns: 1, paddingLeft: 32, paddingRight: 32, paddingTop: 48, paddingBottom: 48 };
      (value.props.design as Record<string, DesignValues>).mobile = { columns: 1, paddingLeft: 20, paddingRight: 20, paddingTop: 40, paddingBottom: 40, gap: 24 };
      content.push(value);
    }
    if (footer) content.push(footer);
    const root = { props: { title: page.title, brand: current.settings.name, ...rootProps, design: { desktop: { backgroundColor: direction.background, color: direction.text, fontFamily: 'sans' } } } };
    const data: Data = { root, content, zones: {} };
    if (productDetail && existingDetail) {
      if ((current.pageTemplates?.length || 0) + templates.length >= 200) throw new Error('页面模板已达200个，请先整理模板');
      templates.push({ id: `ai-template-${run}-${page.key}`, name: `AI · ${page.title}`.slice(0, 120), description: page.purpose, kind: 'product', sourcePath: '/products/:slug', data, updated: date });
      warnings.push('产品详情设计已存为未激活的页面模板，现有产品详情保持原样；需要在页面模板中明确应用后才会改变详情布局。');
    } else { editorData[idByKey.get(page.key)!] = data; if (productDetail && pathPrefix) warnings.push('产品详情沿用系统根路径/products/:slug，不随新页面目录移动；产品资料与已有网址保持原样。'); }
    const issueBase = { pageKey: page.key, pageId: idByKey.get(page.key), path: pathFor(page.path), severity: 'warning' as const };
    if (page.seoTitle.length > 70) seoIssues.push({ ...issueBase, code: 'long-title', message: '标题较长，请人工核对搜索结果中的表达；长度不是排名保证。' });
    if (page.seoDescription.length > 180) seoIssues.push({ ...issueBase, code: 'long-description', message: '描述较长，请核对是否可精简为本页独有的介绍。' });
    if (normalized.pages.filter(item => item.seoTitle.toLocaleLowerCase() === page.seoTitle.toLocaleLowerCase()).length > 1) seoIssues.push({ ...issueBase, code: 'duplicate-title', message: '多页使用了相同SEO标题，请分别表达各页用途。' });
    if (normalized.pages.filter(item => item.seoDescription.toLocaleLowerCase() === page.seoDescription.toLocaleLowerCase()).length > 1) seoIssues.push({ ...issueBase, code: 'duplicate-description', message: '多页使用了相同SEO描述，请核对并区分页面内容。' });
  }
  if (!current.products.length && cataloguePlan) { warnings.push('当前没有真实产品；产品目录为空，动态详情需要添加产品后才可访问。'); seoIssues.push({ pageKey: cataloguePlan.key, pageId: idByKey.get(cataloguePlan.key), path: pathFor(cataloguePlan.path), code: 'missing-products', severity: 'warning', message: '没有真实产品，生成过程不会编造产品或规格。' }); }
  if (!current.settings.publicUrl) seoIssues.push({ pageKey: '', path: pathPrefix || '/', code: 'missing-public-url', severity: 'warning', message: '尚未配置公开规范地址，发布前请检查站点设置中的正式网址。' });
  if (contrast(direction.text, direction.background) < 4.5) seoIssues.push({ pageKey: '', path: pathPrefix || '/', code: 'low-contrast', severity: 'warning', message: '当前设计的文字与背景对比度偏低，请在编辑器中调整。' });
  const additionsById = new Map(additions.map(page => [page.id, page]));
  const pages = [...current.pages.map(page => additionsById.get(page.id) || page), ...additions.filter(page => !current.pages.some(old => old.id === page.id))];
  const sharedBlocks = [...(current.sharedBlocks || []), ...chrome.blocks, ...(catalogueCard ? [catalogueCard] : [])];
  return { patch: { pages, editorData, siteLayout: chrome.siteLayout, sharedBlocks, ...(templates.length ? { pageTemplates: [...(current.pageTemplates || []), ...templates] } : {}), ...(createdForm ? { forms: [...(current.forms || []), contactForm] } : {}) }, pageIds, warnings: [...new Set(warnings)], seoIssues };
}
