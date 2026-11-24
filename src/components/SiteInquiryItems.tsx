'use client';

import { useId, useSyncExternalStore } from 'react';
import { Alert, Button, Card, Form, Input, InputNumber, Select, Space, Typography } from 'antd';
import { MAX_INQUIRY_ITEMS, MAX_INQUIRY_QUANTITY, MAX_INQUIRY_REQUIREMENTS } from '@/lib/inquiry-items';

export type InquiryProductOption = { id: string; name: string; sku?: string };
export type InquiryProductFields = { quantity: number | null; requirements: string };
const emptyFields: InquiryProductFields = { quantity: 1, requirements: '' };
export const inquiryProductFields = (values: Record<string, InquiryProductFields>, id: string) => Object.hasOwn(values, id) ? values[id] : emptyFields;

const changed = 'form-studio:inquiry-selection';
const empty = '[]';
const lastSelection = new Map<string, string>();
const memoryOnly = new Set<string>();
const keyFor = (locale: string) => `form-studio:inquiry-selection:${locale}`;
const subscribe = (listener: () => void) => {
  window.addEventListener(changed, listener);
  return () => window.removeEventListener(changed, listener);
};
const subscribeNothing = () => () => {};

function selectedJson(locale: string) {
  const key = keyFor(locale);
  if (memoryOnly.has(key)) return lastSelection.get(key) || empty;
  try { return sessionStorage.getItem(key) || empty; }
  catch { return lastSelection.get(key) || empty; }
}

function parseSelection(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === 'string' && /^[\w-]{1,100}$/.test(id)))].slice(0, MAX_INQUIRY_ITEMS) : [];
  } catch { return []; }
}

export function useInquirySelection(locale: string, enabled = true): string[] {
  return parseSelection(useSyncExternalStore(enabled ? subscribe : subscribeNothing, () => enabled ? selectedJson(locale) : empty, () => empty));
}

// 临时选品仅保存在当前浏览器标签页的站点语言中，只存产品ID，不存联系方式或询价内容。
export function updateInquirySelection(locale: string, change: (ids: string[]) => string[]) {
  const key = keyFor(locale), next = JSON.stringify(change(parseSelection(selectedJson(locale))).slice(0, MAX_INQUIRY_ITEMS));
  lastSelection.set(key, next);
  try { sessionStorage.setItem(key, next); } catch { memoryOnly.add(key); }
  window.dispatchEvent(new Event(changed));
}

export function inquiryProductLabels(locale: string) {
  if (/^zh(?:-|$)/i.test(locale)) return {
    add: '加入询价单', remove: '移出询价单', added: '已加入询价', review: '查看询价单', limit: '询价单已满',
    list: '询价产品清单', select: '选择产品', quantity: '数量', requirements: '规格或采购要求',
    unavailable: '部分已选产品不在当前目录中，请移除后再提交。', missingProduct: '已下架的产品',
    invalid: '请选择至少一款可询价产品，并填写有效数量。',
  };
  return {
    add: 'Add to inquiry', remove: 'Remove from inquiry', added: 'Added to inquiry', review: 'View inquiry list', limit: 'Inquiry list is full',
    list: 'Products for this inquiry', select: 'Select products', quantity: 'Quantity', requirements: 'Specifications or purchase requirements',
    unavailable: 'Some selected products are unavailable. Remove them before submitting.', missingProduct: 'Unavailable product',
    invalid: 'Select at least one available product and enter valid quantities.',
  };
}

export function SiteInquiryAdd({ id, name, locale, demo }: { id: string; name: string; locale: string; demo?: boolean }) {
  const selected = useInquirySelection(locale, !demo), labels = inquiryProductLabels(locale), added = selected.includes(id);
  const full = !added && selected.length >= MAX_INQUIRY_ITEMS;
  return <Button className="site-rfq-button" disabled={demo || full} aria-label={`${added ? labels.remove : labels.add}: ${name}`} aria-pressed={added}
    onClick={() => updateInquirySelection(locale, ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id])}>
    {added ? labels.added : full ? labels.limit : labels.add}
  </Button>;
}

export function SiteInquiryReviewLink({ href, locale, demo }: { href: string; locale: string; demo?: boolean }) {
  const selected = useInquirySelection(locale, !demo), labels = inquiryProductLabels(locale);
  if (!demo && !selected.length) return null;
  return <Button className="site-rfq-button" htmlType="button" href={demo ? undefined : href} type="primary" disabled={demo}>{labels.review}{demo ? '' : ` (${selected.length})`}</Button>;
}

export function SiteInquiryItems({ selected, products, values, onChange, onSelect, locale, disabled }: {
  selected: string[]; products: InquiryProductOption[]; values: Record<string, InquiryProductFields>;
  onChange: (id: string, fields: InquiryProductFields) => void; onSelect: (selected: string[]) => void; locale: string; disabled: boolean;
}) {
  const labels = inquiryProductLabels(locale), inputId = useId(), options = new Map(products.map(product => [product.id, product]));
  return <section className="site-rfq-fields" data-rfq-review aria-labelledby={`${inputId}-title`}>
    <Typography.Title level={3} id={`${inputId}-title`}>{labels.list}</Typography.Title>
    <Form.Item label={labels.select} htmlFor={`${inputId}-products`}>
      <Select mode="multiple" id={`${inputId}-products`} maxCount={MAX_INQUIRY_ITEMS} maxTagCount={1} value={selected} disabled={disabled}
        aria-label={labels.select} optionFilterProp="label" allowClear showSearch onChange={onSelect}
        options={[...products.map(product => ({ value: product.id, label: product.sku ? `${product.name} (${product.sku})` : product.name })),
          ...selected.filter(id => !options.has(id)).map(id => ({ value: id, label: labels.missingProduct }))]} />
    </Form.Item>
    <Space orientation="vertical" size={10} className="site-rfq-lines">
      {selected.some(id => !options.has(id)) && <Alert type="warning" showIcon title={labels.unavailable} />}
      {selected.map((id, index) => {
        const product = options.get(id);
        if (!product) return null;
        const row = inquiryProductFields(values, id);
        const quantityId = `${inputId}-${index}-quantity`, specsId = `${inputId}-${index}-requirements`;
        return <Card key={id} size="small" title={product.sku ? `${product.name} · ${product.sku}` : product.name} className="site-rfq-line">
          <div className="site-rfq-line-grid">
            <Form.Item label={labels.quantity} htmlFor={quantityId}>
              <InputNumber id={quantityId} aria-label={`${labels.quantity}: ${product.name}`} min={1} max={MAX_INQUIRY_QUANTITY} precision={0} value={row.quantity} disabled={disabled}
                onChange={quantity => onChange(id, { ...row, quantity })} />
            </Form.Item>
            <Form.Item label={labels.requirements} htmlFor={specsId}>
              <Input.TextArea id={specsId} aria-label={`${labels.requirements}: ${product.name}`} value={row.requirements} maxLength={MAX_INQUIRY_REQUIREMENTS} autoSize={{ minRows: 2, maxRows: 5 }} disabled={disabled}
                onChange={event => onChange(id, { ...row, requirements: event.target.value })} />
            </Form.Item>
          </div>
        </Card>;
      })}
    </Space>
  </section>;
}
