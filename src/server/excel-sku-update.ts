import { EXCEL_UPDATE_PARAMETER_TYPES, type ExcelSkuChange, type ExcelSkuRow } from '../lib/ai-source-types';
import type { ImportIssue } from '../lib/content-import';
import { validateModelValues } from '../lib/content-models';
import { PRODUCT_CONTENT_LIMITS } from '../lib/product-content-limits';
import { MAX_PRODUCT_IMAGES, productImages } from '../lib/product-images';
import type { ContentField, ContentModel, FieldValue, Product } from '../lib/types';
import { fieldValue } from './content-import';
import { ApiError } from './http';
import type { DraftContent } from './types';
import { text, validateDraft } from './validation';

const builtinFields = {
  name: ['产品名称', PRODUCT_CONTENT_LIMITS.name],
  category: ['产品分类', PRODUCT_CONTENT_LIMITS.category],
  description: ['产品介绍', PRODUCT_CONTENT_LIMITS.description],
  material: ['材质', PRODUCT_CONTENT_LIMITS.material],
  seoTitle: ['搜索标题', 200],
  seoDescription: ['搜索说明', 1000],
} as const;
const parameterPrefix = 'field:';
export const allowsExcelParameter = (field: ContentField) => EXCEL_UPDATE_PARAMETER_TYPES.some(type => type === field.type);
const skuKey = (sku: string) => sku.trim().toLowerCase();

function recordFor(product: Product, key: string): Record<string, FieldValue | undefined> {
  return key.startsWith(parameterPrefix) ? product.customFields || {} : product as unknown as Record<string, FieldValue | undefined>;
}
const fieldKey = (key: string) => key.startsWith(parameterPrefix) ? key.slice(parameterPrefix.length) : key;
const sameValue = (first: FieldValue | undefined, next: FieldValue | undefined) => JSON.stringify(first) === JSON.stringify(next);
function currentValue(product: Product, field: string) {
  const values = recordFor(product, field), key = fieldKey(field);
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

function applyRow(product: Product, row: ExcelSkuRow, undo = false): Product {
  const copy = { ...product, ...(row.modelId && { customFields: { ...product.customFields } }) };
  for (const change of row.changes) {
    const values = recordFor(copy, change.field), key = fieldKey(change.field);
    if (undo && !change.beforePresent) delete values[key];
    else values[key] = undo ? change.before : change.after;
  }
  return copy;
}

/** 撤销只恢复本批写过的字段。同产品后来的无关编辑会保留，改过同字段则整批停止。 */
export function patchExcelSkuProducts(products: Product[], rows: ExcelSkuRow[], undo = false): Product[] {
  const changes = new Map(rows.map(row => [row.productId, row]));
  const updated = products.map(product => {
    const row = changes.get(product.id);
    if (!row) return product;
    if (undo && (row.modelId && row.modelId !== product.modelId || row.changes.some(change => !sameValue(currentValue(product, change.field), change.after)))) {
      throw new ApiError(409, `型号 ${row.sku} 的参数分组或本次更新字段已有后续修改，请先核对；已保留当前产品`);
    }
    changes.delete(product.id);
    return applyRow(product, row, undo);
  });
  if (changes.size) throw new ApiError(409, '部分产品已移除，无法整批撤销，请核对当前目录');
  return updated;
}

/** 型号匹配既有记录，映射只修改白名单字段。空单元格保留原值，文件中的图片仅接受本实例已采用的图片。 */
export function planExcelSkuUpdate(draft: DraftContent, rows: Record<string, string | number>[], sourceRows: number[], mapping: Record<string, string>, model?: ContentModel) {
  const skuColumn = Object.keys(mapping).find(key => mapping[key] === 'builtin:sku')!;
  const fields = Object.entries(mapping).filter(([, target]) => target && target !== 'builtin:sku');
  const matches = new Map<string, Product[]>();
  for (const product of draft.products) {
    const key = skuKey(product.sku);
    matches.set(key, [...(matches.get(key) || []), product]);
  }
  const errors: ImportIssue[] = [], changes: ExcelSkuRow[] = [], seen = new Set<string>();
  let unchanged = 0;
  for (const [index, cells] of rows.entries()) {
    const rowNumber = sourceRows[index], sku = String(cells[skuColumn] ?? '').trim(), key = skuKey(sku);
    const products = matches.get(key) || [];
    if (!key || seen.has(key) || products.length !== 1) {
      errors.push({ row: rowNumber, field: 'SKU', message: !key ? '型号不能为空' : seen.has(key) ? '本批重复型号，请仅勾选一行' : products.length ? '型号匹配多条产品，请先整理目录' : '找不到现有型号，可以跳过该行' });
      continue;
    }
    seen.add(key);
    const [product] = products;
    const row: ExcelSkuRow = { row: rowNumber, productId: product.id, sku: product.sku, title: product.name, changes: [] };
    function add(field: string, label: string, after: FieldValue) {
      const current = currentValue(product, field);
      if (sameValue(current, after)) return false;
      row.changes.push({ field, label, before: current ?? null, beforePresent: current !== undefined, after });
      return true;
    }
    for (const [column, target] of fields) {
      const value = String(cells[column] ?? '').trim();
      if (value === '') continue;
      try {
        if (target.startsWith(parameterPrefix)) {
          if (product.modelId !== model?.id) throw new Error('产品不属于所选参数分组');
          const parameter = model!.fields.find(field => field.id === fieldKey(target))!;
          const after = fieldValue(value, parameter, true);
          if (after !== undefined && add(target, parameter.label, after)) row.modelId = model!.id;
        } else if (target === 'builtin:image') {
          // 把所选图移到封面，保留其他图片及其相对顺序；满册时提示手工处理。
          const images = [value, ...productImages(product).filter(url => url !== value)];
          if (images.length > MAX_PRODUCT_IMAGES) throw new Error(`产品已有${MAX_PRODUCT_IMAGES}张图片，请先整理相册`);
          if (product.image !== value) { add('image', '封面', value); add('images', '图片顺序', images); }
        } else if (target === 'builtin:sortOrder') {
          const order = Number(value);
          if (!/^\d+$/.test(value) || !Number.isInteger(order) || order > 1000000) throw new Error('排序需为0–1000000整数');
          add('sortOrder', '排序', order);
        } else {
          const field = target.slice(8) as keyof typeof builtinFields;
          const [label, limit] = builtinFields[field];
          add(field, label, text(value, label, limit, true));
        }
      } catch (error) { errors.push({ row: rowNumber, field: column, message: (error as Error).message }); }
    }
    if (row.modelId) {
      const candidate = applyRow(product, row);
      errors.push(...validateModelValues(model!, candidate.customFields, false).map(message => ({ row: rowNumber, field: '产品参数', message })));
    }
    if (row.changes.length) changes.push(row);
    else unchanged++;
  }
  if (!errors.length && changes.length) {
    try { validateDraft({ ...draft, products: patchExcelSkuProducts(draft.products, changes) }); }
    catch (error) { errors.push({ row: 0, field: '整批', message: (error as Error).message }); }
  }
  return { changes, errors, unchanged };
}
