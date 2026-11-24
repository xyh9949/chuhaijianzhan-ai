import type { BindingContext, ContentEntry, ContentModel, PageItem, Product } from './types';
import {localizedPath,localeOf,stripLocalePath,type LocaleSettings} from './localization';

export interface ContentRouteSource {
  settings?:LocaleSettings;
  pages: PageItem[];
  products?: Product[];
  contentModels?: ContentModel[];
  contentEntries?: ContentEntry[];
  editorData?: Record<string, unknown>;
}

const reservedRoots = new Set(['admin', 'api', 'preview', '_next', 'images', 'fonts', 'products']);
const entrySegment = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;

/** 产品未设置短路径时保留原稳定ID地址；显示名称不参与生成网址。 */
export function getProductPath(source: ContentRouteSource, product: Pick<Product, 'id' | 'slug' | 'locale'>): string | undefined {
  const segment = product.slug || product.id;
  return source.pages.some(page => page.slug === '/products/:slug') && entrySegment.test(segment) ? localizedPath(source.settings,product,`/products/${encodeURIComponent(segment)}`) : undefined;
}

/** 内容模板只允许末尾一个动态段；保留系统路由，普通多段路径与原页面规则一致。 */
export function contentTemplatePrefix(page: Pick<PageItem, 'slug'>): string | undefined {
  if (typeof page.slug !== 'string' || !/^\/[a-z0-9][a-z0-9/_-]*\/:slug$/.test(page.slug) || page.slug.includes('//')) return undefined;
  const prefix = page.slug.slice(0, -6);
  if (reservedRoots.has(prefix.split('/')[1])) return undefined;
  return prefix;
}

export function getContentTemplate(source: ContentRouteSource, modelId: string): PageItem | undefined {
  if (source.contentModels && !source.contentModels.some(model => model.id === modelId && model.target === 'content')) return undefined;
  const matches = source.pages.filter(page => page.contentModelId === modelId && contentTemplatePrefix(page));
  return matches.length === 1 ? matches[0] : undefined;
}

/** 标题改名不会改变链接；显式短路径优先，未填写时沿用稳定记录 ID。 */
export function getContentEntryPath(source: ContentRouteSource, entry: Pick<ContentEntry, 'id' | 'modelId' | 'slug' | 'locale'>): string | undefined {
  const template = getContentTemplate(source, entry.modelId);
  const segment = entry.slug || entry.id;
  if (!template || !entrySegment.test(segment)) return undefined;
  return localizedPath(source.settings,entry,`${contentTemplatePrefix(template)}/${encodeURIComponent(segment)}`);
}

/** 模板预览优先合法样本，缺少记录返回空值供界面提示，不跳到其他业务的详情页。 */
export function getTemplatePreviewPath(source: ContentRouteSource, page: PageItem): string | undefined {
  if (!page.slug.includes(':')) return page.slug;
  const data = source.editorData?.[page.id] as { root?: { props?: { bindingContext?: BindingContext } } } | undefined;
  const sample = data?.root?.props?.bindingContext;
  if (page.contentModelId) {
    const records = (source.contentEntries || []).filter(entry => entry.modelId === page.contentModelId);
    const entry = sample?.source === 'entry' ? records.find(entry => entry.id === sample.recordId) || records[0] : records[0];
    return entry ? getContentEntryPath(source, entry) : undefined;
  }
  if (page.slug === '/products/:slug') {
    const product = sample?.source === 'product' ? source.products?.find(product => product.id === sample.recordId) || source.products?.[0] : source.products?.[0];
    return product ? getProductPath(source, product) : undefined;
  }
  return undefined;
}

/** 保存和发布检查最终路径；历史激活保留旧校验范围，不以新规则阻断回到原快照。 */
export function contentRouteErrors(source: ContentRouteSource, options: { historicalRelease?: boolean } = {}): string[] {
  const errors = new Set<string>();
  const models = new Map((source.contentModels || []).map(model => [model.id, model]));
  const templateModels = new Set<string>(), prefixes = new Set<string>();
  // 草稿完整验证尚未校验 locales 的形状；畸形语言配置由 localizationErrors 报错。
  const checkLocalizedPrefixes = !options.historicalRelease && Array.isArray(source.settings?.locales) && source.settings.locales.every(item => !!item && typeof item.code === 'string');
  for (const page of source.pages) {
    if (!page.contentModelId) {
      if (page.slug.includes(':') && page.slug !== '/products/:slug') errors.add(`页面“${page.title}”：内容详情模板必须关联独立内容模型`);
      continue;
    }
    if (models.get(page.contentModelId)?.target !== 'content') errors.add(`页面“${page.title}”：关联的独立内容模型不存在或用途不匹配`);
    if (templateModels.has(page.contentModelId)) errors.add(`内容模型“${models.get(page.contentModelId)?.name || page.contentModelId}”只能关联一个详情模板`);
    templateModels.add(page.contentModelId);
    const prefix = contentTemplatePrefix(page);
    if (!prefix) errors.add(`页面“${page.title}”：详情路径需使用合法前缀加 /:slug，且不能占用系统或产品路径`);
    else {
      // 默认内容模板会为译文自动加语言段；已配置语言下面的系统目录同样保留。
      const local = checkLocalizedPrefixes ? stripLocalePath(source.settings, prefix) : prefix;
      if (local !== prefix && reservedRoots.has(local.split('/')[1])) errors.add(`页面“${page.title}”：详情路径 ${prefix}/:slug 占用了该语言的系统或产品路径，请改用独立前缀，例如 /cases/:slug（译文会自动添加语言前缀）`);
      if (prefixes.has(prefix)) errors.add(`内容详情路径前缀 ${prefix} 已被其他模板使用`);
      else prefixes.add(prefix);
    }
  }
  const segments = new Map<string, Set<string>>();
  const paths = new Map<string, string>();
  const staticPaths = new Set(source.pages.filter(page => !page.slug.includes(':')).map(page => page.slug));
  const productSegments = new Set<string>();
  const productPaths = new Map<string, string>();
  for (const product of source.products || []) {
    if (product.slug !== undefined && (typeof product.slug !== 'string' || (product.slug !== '' && !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(product.slug)))) errors.add(`产品“${product.name}”：短路径格式无效`);
    const segment = product.slug || product.id;
    const localizedSegment=`${localeOf(source.settings,product)}:${segment}`;
    if (productSegments.has(localizedSegment)) errors.add(`产品“${product.name}”：有效短路径 ${segment} 重复`);
    productSegments.add(localizedSegment);
    const path = getProductPath(source, product);
    if (path) {
      if (staticPaths.has(path)) errors.add(`产品“${product.name}”：详情地址 ${path} 与普通页面冲突`);
      productPaths.set(path, product.name);
    }
  }
  for (const entry of source.contentEntries || []) {
    const segment = entry.slug || entry.id;
    const scope=`${entry.modelId}:${localeOf(source.settings,entry)}`,used = segments.get(scope) || new Set<string>();
    if (used.has(segment)) errors.add(`内容“${entry.title}”：模型内短路径 ${segment} 重复（也不能占用其他记录的默认 ID 路径）`);
    used.add(segment); segments.set(scope, used);
    const path = getContentEntryPath(source, entry);
    if (!path) continue;
    if (staticPaths.has(path)) errors.add(`内容“${entry.title}”：详情地址 ${path} 与普通页面冲突`);
    if (!options.historicalRelease && productPaths.has(path)) errors.add(`内容“${entry.title}”：详情地址 ${path} 与产品“${productPaths.get(path)}”冲突，请修改内容详情模板前缀`);
    if (paths.has(path)) errors.add(`内容“${entry.title}”：详情地址 ${path} 与内容“${paths.get(path)}”冲突`);
    paths.set(path, entry.title);
  }
  return [...errors];
}
