import type { ContentEntry, Product, Taxonomy } from './types';
export interface CatalogSource { taxonomies?: Taxonomy[]; products: Product[]; contentEntries?: ContentEntry[]; contentModels?: { id: string; target: 'product' | 'content' }[]; }

/** 分类只存稳定ID；保留旧category文字，迁移必须明确确认。 */
export function taxonomyErrors(source: CatalogSource): string[] {
  const errors = new Set<string>(), catalog = source.taxonomies || [], ids = new Set<string>(), terms = new Map<string, Taxonomy>();
  const validId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
  if (!Array.isArray(catalog) || catalog.length > 50) return ['分类体系最多50项'];
  for (const taxonomy of catalog) {
    if (!taxonomy || !validId(taxonomy.id) || ids.has(taxonomy.id) || typeof taxonomy.name !== 'string' || !taxonomy.name.trim() || taxonomy.name.length > 120 || !['product', 'entry'].includes(taxonomy.source) || !Array.isArray(taxonomy.terms) || taxonomy.terms.length > 500) { errors.add('分类体系结构无效或重复'); continue; }
    if (taxonomy.modelId && !source.contentModels?.some(model => model.id === taxonomy.modelId && model.target === (taxonomy.source === 'product' ? 'product' : 'content'))) errors.add(`分类“${taxonomy.name}”限定模型不存在或用途不匹配`);
    ids.add(taxonomy.id); const slugs = new Set<string>(), localTerms = new Map<string, Taxonomy['terms'][number]>();
    for (const term of taxonomy.terms) {
      if (!term || !validId(term.id) || terms.has(term.id) || typeof term.label !== 'string' || !term.label.trim() || term.label.length > 120 || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(term.slug) || slugs.has(term.slug)) { errors.add(`分类“${taxonomy.name}”的项目标识、名称或短路径无效/重复`); continue; }
      terms.set(term.id, taxonomy); slugs.add(term.slug); localTerms.set(term.id, term);
    }
    // 坏项目已记录格式错误；父链只读取本分类的合法项目，避免空值触发500或跨分类借用父项。
    for (const term of localTerms.values()) {
      const seen = new Set<string>([term.id]); let next = term.parentId;
      while (next) { if (seen.has(next) || !localTerms.has(next)) { errors.add(`分类“${taxonomy.name}”父项缺失或循环`); break; } seen.add(next); if (seen.size > 5) { errors.add('分类最多5层'); break; } next = localTerms.get(next)?.parentId; }
    }
  }
  const check = (record: Product | ContentEntry, kind: 'product' | 'entry') => {
    if (record.sortOrder !== undefined && (!Number.isInteger(record.sortOrder) || record.sortOrder < 0 || record.sortOrder > 1_000_000)) errors.add('手动顺序必须为0–1000000整数');
    if (record.termIds !== undefined) {
      if (!Array.isArray(record.termIds) || record.termIds.length > 100 || new Set(record.termIds).size !== record.termIds.length) { errors.add('分类选择列表无效或重复'); return; }
      for (const id of record.termIds) { const taxonomy = terms.get(id); if (!taxonomy || taxonomy.source !== kind || taxonomy.modelId && taxonomy.modelId !== record.modelId) errors.add(`记录“${'name' in record ? record.name : record.title}”引用了不适用或不存在的分类 ${id}`); }
    }
  };
  source.products.forEach(record => check(record, 'product')); source.contentEntries?.forEach(record => check(record, 'entry'));
  return [...errors];
}
