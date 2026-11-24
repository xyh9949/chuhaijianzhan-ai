import type { ComponentData, Data } from '@puckeditor/core';
import type { DraftContent } from '../server/types';
import type { AiSiteCompileResult, AiSiteDirection } from './ai-builder-types';
import type { PageItem, SharedBlock, SiteLayout, SiteLayoutSlot, SiteMenu } from './types';
import type { DesignValues } from './responsive-style';
import { withEditorRootDefaults } from './editor-root-defaults';

const HEADER_LABEL = 'AI生成品牌与页面导航';
const FOOTER_LABEL = 'AI生成页面页脚';
const defaultSlot = (): SiteLayoutSlot => ({ mode: 'default', blockId: '' });
const defaultLayout = (): SiteLayout => ({ header: defaultSlot(), footer: defaultSlot() });
const chromeSlots = ['header', 'footer'] as const;
const rootChrome = (data: Data | undefined) => data?.root?.props as { showChrome?: 'yes' | 'no'; headerMode?: 'inherit' | 'hidden'; footerMode?: 'inherit' | 'hidden' } | undefined;
const layoutSlotIsDefault = (slot: SiteLayoutSlot) => slot.mode === 'default' && !slot.blockId && !slot.menuId && !Object.values(slot.localeBlockIds || {}).some(Boolean) && !Object.values(slot.localeMenuIds || {}).some(Boolean);

/** 已配置或主动隐藏的全站区域保留；生成站的备用目录可以独立共用自己的菜单。 */
export function canAdoptAiGlobalChrome(layout?: SiteLayout, localeCount = 1): boolean {
  return localeCount <= 1 && (!layout || chromeSlots.every(slot => layoutSlotIsDefault(layout[slot])));
}

// 旧独立头尾原本在任何语言显示同一套按钮，迁移独立范围时保留实际可达入口。
const existingLocales = (settings: DraftContent['settings'], menuId: string) => Object.fromEntries(
  (settings.locales || []).filter(locale => locale.code !== settings.language).map(locale => [locale.code, menuId]),
);

function chromeReference(run: string, slot: 'header' | 'footer', blockId: string): ComponentData {
  return { type: 'SharedBlock', props: { id: `ai-${run}-shared-${slot}`, blockId, nodeLabel: slot === 'header' ? HEADER_LABEL : FOOTER_LABEL } };
}

function chromeAssets(current: Pick<DraftContent, 'siteLayout' | 'sharedBlocks'>, run: string, date: string, menu: SiteMenu, header: ComponentData, footer: ComponentData, global: boolean) {
  const source = current.siteLayout || defaultLayout();
  if ((source.menus || []).length >= 40) throw Error('已有40个导航菜单，请先整理菜单');
  if ((current.sharedBlocks || []).length > 198) throw Error('同步区块空间不足，请先整理区块');
  const block = (slot: 'header' | 'footer', data: ComponentData, name: string): SharedBlock => {
    const box = { root: { props: { title: name, showChrome: 'no' } }, content: [data], zones: {} };
    return { id: `ai-${run}-${slot}`, name, updated: date, data: withEditorRootDefaults(box) };
  };
  const head = block('header', header, 'AI · 共享页眉'), foot = block('footer', footer, 'AI · 共享页脚');
  const siteLayout: SiteLayout = {
    ...source,
    ...(global ? { header: { mode: 'block', blockId: head.id, menuId: menu.id }, footer: { mode: 'block', blockId: foot.id } } : {}),
    menus: [...(source.menus || []), menu],
  };
  return {
    siteLayout,
    blocks: [head, foot],
    pageChrome: () => global ? { rootProps: { showChrome: 'yes' as const }, header: undefined, footer: undefined } : {
      rootProps: { showChrome: 'no' as const },
      header: chromeReference(run, 'header', head.id),
      footer: chromeReference(run, 'footer', foot.id),
    },
    global,
  };
}

/** 当前计划的普通页通过稳定ID加入菜单；详情及稍后新增页面跟随实际全站区域。 */
export function createAiBuildSharedLayout({ current, pages, direction, run, date, contactPageId, firstRootBuild }: {
  current: DraftContent; pages: PageItem[]; direction: AiSiteDirection; run: string; date: string; contactPageId: string; firstRootBuild: boolean;
}) {
  const contact = pages.find(page => page.id === contactPageId && !page.slug.includes(':'));
  if (!contact) throw Error('共享页脚缺少有效联系页面');
  const menu: SiteMenu = {
    id: `ai-${run}-menu`, name: 'AI · 网站导航',
    items: pages.filter(page => !page.slug.includes(':')).map((page, index) => ({ id: `ai-${run}-item-${index + 1}`, label: page.title, target: { kind: 'page', id: page.id } })),
  };
  const node = (id: string, type: string, props: Record<string, unknown>): ComponentData => ({ type, props: { id: `ai-${run}-chrome-${id}`, ...props } });
  const frame = (slot: 'header' | 'footer', content: ComponentData[], design: DesignValues) => {
    const isHeader = slot === 'header';
    return node(slot, 'Container', {
      content, nodeLabel: isHeader ? HEADER_LABEL : FOOTER_LABEL, columns: isHeader ? 4 : 1, layout: isHeader ? 'grid' : 'column',
      mobileColumns: 1, gap: isHeader ? 20 : 18, padding: 0, inset: 0, image: '', minHeight: 0, align: 'start', background: direction.background,
      design: {
        desktop: { alignItems: isHeader ? 'center' : 'start', borderWidth: 1, borderColor: direction.primary, paddingLeft: 32, paddingRight: 32, ...design },
        tablet: { columns: 1 }, mobile: { columns: 1, paddingLeft: 20, paddingRight: 20, gap: 10 },
      },
    });
  };
  const brand = node('brand', 'Text', {
    text: current.settings.name, align: 'left', size: 20, color: direction.text, maxWidth: 900,
    design: { desktop: { fontWeight: 700, fontFamily: direction.headingFont }, mobile: { fontSize: 18 } },
  });
  const menuNode = node('menu', 'Navigation', {
    menuId: menu.id, mobileMode: 'collapse', label: current.settings.language.startsWith('zh') ? '网站导航' : 'Website navigation',
    localeMenuIds: existingLocales(current.settings, menu.id),
    design: { desktop: { columnSpan: 3, color: direction.text, fontSize: 13 }, tablet: { columnSpan: 1 } },
  });
  const footerText = node('copyright', 'Text', {
    text: `© ${new Date(date).getUTCFullYear()} ${current.settings.name}`, align: 'left', size: 17, color: direction.text, maxWidth: 820,
    design: { desktop: { lineHeight: 1.75, opacity: 0.85 }, mobile: { fontSize: 16 } },
  });
  const toLinear = (value: number) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  const brightness = [.2126, .7152, .0722].reduce((sum, weight, index) => sum + weight * toLinear(parseInt(direction.primary.slice(1 + 2 * index, 3 + 2 * index), 16) / 255), 0);
  const cta = node('contact', 'ActionButton', {
    text: contact.title, href: '', linkTarget: { kind: 'page', id: contact.id }, kind: 'theme', align: 'left',
    design: { desktop: { backgroundColor: direction.primary, color: brightness > .179 ? '#000000' : '#ffffff', borderColor: direction.primary, borderWidth: 1, borderRadius: direction.layout === 'catalog' ? 4 : 0, height: 46, paddingLeft: 24, paddingRight: 24 } },
  });
  return chromeAssets(current, run, date, menu, frame('header', [brand, menuNode], { paddingTop: 20, paddingBottom: 20 }),
    frame('footer', [footerText, cta], { paddingTop: 36, paddingBottom: 36 }), firstRootBuild && canAdoptAiGlobalChrome(current.siteLayout, current.settings.locales?.length));
}

export type AiBuildChromeMigrationMode = 'shared' | 'global' | 'inherit';
export type AiBuildChromeMigrationRequest = { pageId: string; mode: AiBuildChromeMigrationMode };
type LegacyChrome = { origin: string; header: ComponentData; footer: ComponentData; navigation: ComponentData; links: ComponentData[] };
const generatedRun = (id: unknown, type: 'page' | 'template' | 'node') => typeof id === 'string' ? (
  type === 'node' ? /^ai-([a-f0-9]{12})-\d+$/.exec(id)?.[1]
    : (type === 'template' ? /^ai-template-([a-f0-9]{12})-[a-z0-9_-]+$/ : /^ai-([a-f0-9]{12})-[a-z0-9_-]+$/).exec(id)?.[1]
) : undefined;

// 仅识别旧生成器前后两个边缘容器；中间的标题、正文及动态数据不进入迁移转换。
function legacyChrome(data: Data | undefined): LegacyChrome | undefined {
  const root = rootChrome(data);
  if (root?.showChrome !== 'no' || root.headerMode || root.footerMode || Object.keys(data?.zones || {}).length || !Array.isArray(data?.content) || data.content.length < 3) return;
  const header = data.content[0], footer = data.content.at(-1)!;
  const origin = generatedRun(header.props?.id, 'node');
  if (!origin || header.type !== 'Container' || header.props.nodeLabel !== HEADER_LABEL || footer.type !== 'Container' || footer.props.nodeLabel !== FOOTER_LABEL || generatedRun(footer.props?.id, 'node') !== origin) return;
  const [brand, navigation] = Array.isArray(header.props.content) ? header.props.content : [];
  const links = navigation?.props?.content;
  if (header.props.content?.length !== 2 || brand?.type !== 'Text' || navigation?.type !== 'Container' || !Array.isArray(links) || !links.length) return;
  const supported = ['id', 'text', 'href', 'linkTarget', 'kind', 'align', 'design'];
  if (links.some(node => node.type !== 'ActionButton' || generatedRun(node.props?.id, 'node') !== origin || node.props.kind !== 'outline'
      || node.props.align !== 'left' || typeof node.props.text !== 'string' || node.props.linkTarget?.kind !== 'page'
      || Object.keys(node.props).some(key => !supported.includes(key)))) return;
  return { origin, header, footer, navigation, links };
}

function canUseLegacyChromeSeed(page: PageItem, nodes: LegacyChrome) {
  return (page.id === 'home' && page.slug === '/') || generatedRun(page.id, 'page') === nodes.origin;
}

export function legacyAiChromePageIds(current: Pick<DraftContent, 'pages' | 'editorData'>): string[] {
  return current.pages.flatMap(page => {
    const source = legacyChrome(current.editorData[page.id] as Data | undefined);
    return source && canUseLegacyChromeSeed(page, source) ? [page.id] : [];
  });
}

const containsLocks = (value: unknown): boolean => !!value && typeof value === 'object'
  && ('locked' in value && !!value.locked || Object.values(value).some(containsLocks));
function comparableChrome(value: unknown): string {
  // 跨页副本的组件ID不同，链接目标ID与手工样式必须逐项相同。
  const ordered = (item: unknown, componentProps = false): unknown => {
    if (Array.isArray(item)) return item.map(child => ordered(child));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, child]) =>
      componentProps && key === 'id' ? [] : [[key, ordered(child, key === 'props' && 'type' in item)]]));
  };
  return JSON.stringify(ordered(value));
}
const sameChrome = (a: LegacyChrome, b: LegacyChrome) => comparableChrome([a.header, a.footer]) === comparableChrome([b.header, b.footer]);
const codeEnabled = (code: { cssEnabled?: boolean; jsEnabled?: boolean } | undefined) => !!(code?.cssEnabled || code?.jsEnabled);

/** 旧页头尾仅在管理员选择并预览后转换；不确定、手工分叉或使用自定义代码的副本保留原样。 */
export function prepareAiBuildChromeMigration(current: DraftContent, { pageId, mode }: AiBuildChromeMigrationRequest, run: string, date: string): AiSiteCompileResult {
  const seedPage = current.pages.find(page => page.id === pageId), seed = legacyChrome(current.editorData[pageId] as Data | undefined);
  if (!seedPage || !seed || !canUseLegacyChromeSeed(seedPage, seed)) throw Error('这个页面没有可识别的旧AI页眉页脚');
  const group = current.pages.filter(page => generatedRun(page.id, 'page') === seed.origin || (
    page.id === 'home' && page.slug === '/' && legacyChrome(current.editorData[page.id] as Data | undefined)?.origin === seed.origin
  ));
  const templates = (current.pageTemplates || []).filter(template => generatedRun(template.id, 'template') === seed.origin);
  const verify = (value: Data, label: string) => {
    const chrome = legacyChrome(value);
    if (!chrome || chrome.origin !== seed.origin || !sameChrome(seed, chrome)) throw Error(`“${label}”已有独立头尾或导航调整，请保留当前布局并手工统一`);
    if (containsLocks(value)) throw Error(`“${label}”包含锁定区块，请先确认页面锁定范围`);
  };
  if (codeEnabled(current.customCode?.global)) throw Error('网站正在使用全站自定义代码，请从编辑器手工调整头尾，保留原选择器');
  for (const page of group) {
    verify(current.editorData[page.id] as Data, page.title);
    if (codeEnabled(current.customCode?.pages?.[page.id])) throw Error(`“${page.title}”正在使用自定义代码，请从编辑器手工调整头尾`);
  }
  for (const template of templates) {
    verify(template.data, template.name);
    if (codeEnabled(template.code)) throw Error(`“${template.name}”正在使用自定义代码，请从编辑器手工调整头尾`);
  }

  const affected = new Set(group.map(page => page.id)), warnings: string[] = [];
  if (mode === 'global') {
    if (!group.some(page => page.slug === '/') || !canAdoptAiGlobalChrome(current.siteLayout, current.settings.locales?.length)) throw Error('只有未配置全站头尾的单语言根首页可以初始化共享头尾；其他情况可选择仅同步这组页面或跟随现有头尾');
    // 原来已跟随站点区域的页面也将实际变化，须在同一个冻结预览中给出范围。
    for (const page of current.pages) {
      const data = current.editorData[page.id] as Data | undefined;
      const root = rootChrome(data);
      if (root?.showChrome === 'no' || root?.headerMode === 'hidden' && root?.footerMode === 'hidden') continue;
      if (containsLocks(data) || codeEnabled(current.customCode?.pages?.[page.id])) throw Error(`“${page.title}”的锁定区块或自定义代码需要保留，请选择仅同步旧生成页面`);
      affected.add(page.id);
    }
    for (const template of current.pageTemplates || []) if (template.detailRule?.enabled && !templates.includes(template) && rootChrome(template.data)?.showChrome !== 'no') {
      if (containsLocks(template.data) || codeEnabled(template.code)) throw Error(`“${template.name}”的锁定区块或自定义代码需要保留，请选择仅同步旧生成页面`);
      const parent = current.pages.find(page => page.slug === template.sourcePath || (template.kind === 'product' ? page.slug === '/products/:slug' : template.kind === 'entry' && page.contentModelId === template.modelId));
      if (parent) affected.add(parent.id);
    }
    warnings.push('共用原生成的品牌与联系入口；所有跟随全站头尾的页面将同步使用新布局。');
  } else if (mode === 'inherit') {
    if (chromeSlots.some(slot => current.siteLayout?.[slot].mode === 'hidden')) throw Error('全站页眉或页脚已隐藏，请先在全站设计设置中核对');
    warnings.push('这些页面将改用已有全站头尾，旧的独立品牌、菜单与页脚可在左侧预览核对。');
  } else {
    warnings.push('这些页面将共用一套独立的同步区块与导航菜单。其他现有页面继续使用自己的头尾。');
  }

  let assets: ReturnType<typeof chromeAssets> | undefined;
  if (mode !== 'inherit') {
    const initialLink = seed.links[0];
    if (seed.links.some(link => comparableChrome(link.props.design) !== comparableChrome(initialLink.props.design))) throw Error('旧导航的各链接使用独立样式，请保留原布局并手工统一');
    const menu: SiteMenu = {
      id: `ai-${run}-menu`, name: 'AI · 迁移网站导航',
      items: seed.links.map((link, index) => ({ id: `ai-${run}-item-${index + 1}`, label: link.props.text, target: link.props.linkTarget })),
    };
    // 保留原容器的留白和位置；受控菜单替换同样式的按钮，移动端由原生导航折叠。
    const navigation: ComponentData = {
      ...seed.navigation, props: { ...seed.navigation.props, layout: 'column', columns: 1, mobileColumns: 1,
        design: { ...seed.navigation.props.design, mobile: { ...seed.navigation.props.design?.mobile, columns: 1 } },
        content: [{ type: 'Navigation', props: { id: `ai-${run}-chrome-menu`, menuId: menu.id, mobileMode: 'collapse',
          label: current.settings.language.startsWith('zh') ? '网站导航' : 'Website navigation',
          localeMenuIds: existingLocales(current.settings, menu.id),
          design: { desktop: { fontSize: initialLink.props.design?.desktop?.fontSize ?? 13, color: initialLink.props.design?.desktop?.color ?? current.theme.text } },
        } }],
      },
    };
    const header: ComponentData = { ...seed.header, props: { ...seed.header.props, content: [seed.header.props.content[0], navigation] } };
    assets = chromeAssets(current, run, date, menu, header, seed.footer, mode === 'global');
  }
  const convert = (data: Data): Data => {
    const chrome = assets?.pageChrome();
    const props = { ...data.root.props, showChrome: chrome?.rootProps.showChrome || 'yes' };
    return { ...data, root: { ...data.root, props },
      content: [...(chrome?.header ? [chrome.header] : []), ...data.content.slice(1, -1), ...(chrome?.footer ? [chrome.footer] : [])] };
  };
  const editorData = { ...current.editorData };
  for (const page of group) editorData[page.id] = convert(current.editorData[page.id] as Data);
  const pageTemplates = templates.length ? current.pageTemplates?.map(template => templates.includes(template) ? { ...template, data: convert(template.data) } : template) : undefined;
  return {
    patch: { editorData, ...(assets ? { siteLayout: assets.siteLayout, sharedBlocks: [...(current.sharedBlocks || []), ...assets.blocks] } : {}), ...(pageTemplates ? { pageTemplates } : {}) },
    pageIds: [...affected], warnings, seoIssues: [],
  };
}
