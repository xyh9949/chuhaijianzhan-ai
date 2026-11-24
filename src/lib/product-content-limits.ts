/** 产品基础字段采用同一持久化上限，导入后仍可在产品表单中继续维护。 */
export const PRODUCT_CONTENT_LIMITS = {
  name: 200,
  sku: 100,
  category: 100,
  description: 30000,
  material: 2000,
} as const;
