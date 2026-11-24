import type { ContentEntry, ContentModel, ContentQuery, Product, Taxonomy } from './types';
import {localeOf,siteLocales,type LocaleSettings} from './localization';
import {QUERY_LABEL_NAMES} from './query-labels';
export type QueryParams = Record<string, string | string[] | undefined>;
export interface QuerySource { products: Product[]; contentEntries?: ContentEntry[]; contentModels?: ContentModel[]; taxonomies?: Taxonomy[]; settings?:LocaleSettings; locale?:string; }
export const loopParam = (id: string, part: 'page' | 'search' | 'term') => `${part}_${id}`;
const scalar = (value: string | string[] | undefined) => typeof value === 'string' ? value : '';
const productCategoryPrefix = 'category:';

export function queryErrors(query: unknown, source: QuerySource, kind: 'product' | 'entry', modelId?: string): string[] {
  if (query === undefined) return [];
  if (!query || typeof query !== 'object' || Array.isArray(query)) return ['列表查询必须为对象'];
  const q = query as ContentQuery, errors: string[] = [], model = source.contentModels?.find(item => item.id === modelId);
  const type = (field: string) => field === 'builtin:sortOrder' ? 'number' : ['builtin:title', 'builtin:name', 'builtin:category', 'builtin:id'].includes(field) ? 'text' : model?.fields.find(item => `field:${item.id}` === field)?.type;
  if (Object.keys(q).some(key => !['filters', 'termIds', 'sort', 'direction', 'paginate', 'pageSize', 'controls', 'productCategories', 'labels'].includes(key))) errors.push('列表查询包含不支持的属性');
  if(q.labels!==undefined){if(!q.labels||typeof q.labels!=='object'||Array.isArray(q.labels)||Object.keys(q.labels).length>10)errors.push('列表语言文案必须是最多10个语言对象');else for(const [locale,labels] of Object.entries(q.labels)){if(!siteLocales(source.settings).some(l=>l.code===locale)||!labels||typeof labels!=='object'||Array.isArray(labels)||Object.entries(labels).some(([k,v])=>!Object.hasOwn(QUERY_LABEL_NAMES,k)||typeof v!=='string'||!v.trim()||v.length>200))errors.push('列表文案语言未配置或字段格式无效');}}
  if (q.pageSize !== undefined && (!Number.isInteger(q.pageSize) || q.pageSize < 1 || q.pageSize > 50)) errors.push('每页数量为1–50整数');
  if (q.direction !== undefined && !['asc', 'desc'].includes(q.direction)) errors.push('列表排序方向无效');
  for (const key of ['paginate', 'controls'] as const) if (q[key] !== undefined && typeof q[key] !== 'boolean') errors.push('列表开关必须为是/否');
  if (q.productCategories !== undefined && typeof q.productCategories !== 'boolean') errors.push('使用产品分类的开关必须为是/否');
  if (q.sort && (!type(q.sort) || ['gallery', 'image', 'multiselect','relation'].includes(type(q.sort)!))) errors.push('排序字段无效或不支持');
  const allowedTerms = new Set((source.taxonomies || []).filter(tax => tax.source === kind && (!tax.modelId || tax.modelId === modelId)).flatMap(tax => tax.terms.map(term => term.id)));
  if (q.termIds !== undefined && (!Array.isArray(q.termIds) || q.termIds.length > 50 || q.termIds.some(id => !allowedTerms.has(id)))) errors.push('查询分类缺失或不适用');
  if (q.filters !== undefined) {
    if (!Array.isArray(q.filters) || q.filters.length > 12) errors.push('查询条件最多12项');
    else for (const filter of q.filters) {
      if (!filter || typeof filter !== 'object' || !type(filter.field) || !['eq', 'contains', 'gte', 'lte', 'in'].includes(filter.op)) { errors.push('查询条件字段或运算无效'); continue; }
      const fieldType = type(filter.field);
      if(fieldType==='relation'){errors.push('关系字段请用当前记录的关联来源，不作为普通标量条件');continue;}
      if (fieldType === 'multiselect' && filter.op !== 'in') { errors.push('多选字段只支持任一选项匹配'); continue; }
      if (filter.op === 'gte' || filter.op === 'lte') { if (fieldType !== 'number' || typeof filter.value !== 'number' || !Number.isFinite(filter.value)) errors.push('范围条件需要数值字段和数值'); }
      else if (filter.op === 'contains') { if (!['text', 'textarea'].includes(fieldType!) || typeof filter.value !== 'string' || filter.value.length > 200) errors.push('文本条件无效'); }
      else if (filter.op === 'in') { if (!Array.isArray(filter.value) || filter.value.length > 50 || filter.value.some(value => typeof value !== 'string' || value.length > 200)) errors.push('多值条件无效'); }
      else if (fieldType === 'boolean' ? typeof filter.value !== 'boolean' : fieldType === 'number' ? typeof filter.value !== 'number' || !Number.isFinite(filter.value) : typeof filter.value !== 'string' || filter.value.length > 200) errors.push('相等条件的值与字段类型不匹配');
    }
  }
  return errors;
}

/** 发布按最终模型/分类检查查询，不能使用未选择的草稿字段补齐依赖。 */
export function contentQueryErrors(source: QuerySource & { editorData: Record<string, unknown>; sharedBlocks?: { data: unknown }[] }): string[] {
  const errors: string[] = [];
  function visit(value: unknown) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as { type?: string; props?: { query?: unknown; source?: string; modelId?: string } };
    if (node.type === 'ContentLoop' && node.props) errors.push(...queryErrors(node.props.query, source, node.props.source === 'product' ? 'product' : 'entry', node.props.modelId));
    Object.values(value).forEach(visit);
  }
  visit(source.editorData); source.sharedBlocks?.forEach(block => visit(block.data));
  return [...new Set(errors)];
}

/** SSR、预览与计数共用纯查询；0/false与缺值区分，排序始终有稳定ID兜底。 */
export function queryContent(source: QuerySource, kind: 'product' | 'entry', modelId: string | undefined, query: ContentQuery | undefined, id: string, params: QueryParams = {}, legacyCount = 6, orderedIds?:string[]) {
  const value = (record: Product | ContentEntry, field: string): unknown => field.startsWith('field:') ? record.customFields?.[field.slice(6)] : field === 'builtin:sortOrder' ? record.sortOrder ?? 0 : field === 'builtin:id' ? record.id : field === 'builtin:category' ? ('category' in record ? record.category : '') : 'name' in record ? record.name : record.title;
  let records: (Product | ContentEntry)[] = (kind === 'entry' ? modelId ? source.contentEntries || [] : [] : source.products).filter(record => record.status === 'published' && (!modelId || record.modelId === modelId));
  if(source.locale||source.settings?.locales)records=records.filter(r=>localeOf(source.settings,r)===(source.locale||source.settings?.language));
  // 关联来源先限域并保留选择顺序，只有显式排序才覆盖它。
  if(orderedIds!==undefined){const byId=new Map(records.map(r=>[r.id,r]));records=orderedIds.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]);}
  if (query?.termIds?.length) records = records.filter(record => query.termIds!.some(id => record.termIds?.includes(id)));
  for (const filter of query?.filters || []) records = records.filter(record => {
    const actual = value(record, filter.field);
    if (actual === undefined || actual === null || actual === '') return false;
    if (filter.op === 'eq') return actual === filter.value;
    if (filter.op === 'contains') return String(actual).toLocaleLowerCase().includes(String(filter.value).toLocaleLowerCase());
    if (filter.op === 'gte') return typeof actual === 'number' && actual >= Number(filter.value);
    if (filter.op === 'lte') return typeof actual === 'number' && actual <= Number(filter.value);
    return Array.isArray(filter.value) && filter.value.some(item => Array.isArray(actual) ? actual.includes(item) : actual === item);
  });
  // Excel导入的产品分类由产品字段保存。按当前语言和列表范围取值，不改原记录，也不借用数据库分类的ID。
  const useProductCategories = kind === 'product' && query?.controls && query.productCategories;
  const productCategories = useProductCategories
    ? [...new Set(records.flatMap(record => 'category' in record && record.category.trim() ? [record.category.trim()] : []))]
      .sort((a, b) => a.localeCompare(b, source.locale || 'en')).map(label => ({ id: productCategoryPrefix + label, label }))
    : [];
  const search = query?.controls ? scalar(params[loopParam(id, 'search')]).slice(0, 200).trim() : '';
  const term = query?.controls ? scalar(params[loopParam(id, 'term')]) : '';
  if (search) {
    const needle = search.toLocaleLowerCase();
    // 型号属于产品本身，和是否启用导入分类无关；语言和发布状态仍在前面限定。
    records = records.filter(record => String(value(record, 'builtin:title')).toLocaleLowerCase().includes(needle)
      || (kind === 'product' && 'sku' in record && record.sku.toLocaleLowerCase().includes(needle)));
  }
  if (term) records = useProductCategories && term.startsWith(productCategoryPrefix)
    ? records.filter(record => 'category' in record && productCategoryPrefix + record.category.trim() === term)
    : records.filter(record => record.termIds?.includes(term));
  if (query && (orderedIds===undefined||query.sort)) records = [...records].sort((a, b) => {
    const av = value(a, query.sort || 'builtin:sortOrder'), bv = value(b, query.sort || 'builtin:sortOrder');
    const empty = (v: unknown) => v === undefined || v === null || v === '';
    if (empty(av) !== empty(bv)) return empty(av) ? 1 : -1;
    const difference = typeof av === 'number' && typeof bv === 'number' ? av - bv : typeof av === 'boolean' && typeof bv === 'boolean' ? Number(av) - Number(bv) : String(av ?? '').localeCompare(String(bv ?? ''), 'en');
    return (query.direction === 'desc' ? -difference : difference) || a.id.localeCompare(b.id, 'en');
  });
  const size = Math.max(1, Math.min(50, query?.pageSize || legacyCount));
  const total = records.length, pages = Math.max(1, Math.ceil(total / size));
  const rawPage = scalar(params[loopParam(id, 'page')]);
  const page = query?.paginate && /^[1-9]\d{0,8}$/.test(rawPage) ? Number(rawPage) : query?.paginate && /^\d{9,}$/.test(rawPage) ? Number.MAX_SAFE_INTEGER : 1;
  return { records: records.slice((page - 1) * size, page * size), total, pages, page, size, search, term, productCategories, outOfRange: page > pages };
}
