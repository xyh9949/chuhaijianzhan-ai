import type { Inquiry, InquiryItem } from './types';

export const MAX_INQUIRY_ITEMS = 20;
export const MAX_INQUIRY_QUANTITY = 1_000_000;
export const MAX_INQUIRY_REQUIREMENTS = 500;

/** 访客只能填写产品 ID、数量和要求；提交时的型号和名称由服务端取得。 */
export type InquiryItemInput = Pick<InquiryItem, 'productId' | 'quantity' | 'requirements'>;

/** 列表与导出用同一文本匹配，查第二款的型号也能找到整份询价。 */
export function inquirySearchText(item: Inquiry) {
  return [item.name, item.email, item.company, item.product, ...(item.items ?? []).flatMap(line => [line.sku, line.name])].join(' ').toLowerCase();
}

/** 邮件和表格使用同一行项格式，内容源于询盘快照，不临时查产品表。 */
export function formatInquiryItems(items: InquiryItem[] | undefined) {
  return items?.map(line => `${line.name} [${line.sku}] × ${line.quantity}${line.requirements ? ` — ${line.requirements}` : ''}`).join('\n') ?? '';
}
