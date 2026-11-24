'use client';
import { Form, InputNumber, Select } from 'antd';
import type { Taxonomy } from '@/lib/types';

/** 表单仅写稳定分类ID；不存在的旧选择不自动清空，由服务端说明引用错误。 */
export default function RecordTermsFields({ taxonomies = [], source, modelId }: { taxonomies?: Taxonomy[]; source: 'product' | 'entry'; modelId?: string }) {
  const options = taxonomies.filter(tax => tax.source === source && (!tax.modelId || tax.modelId === modelId)).flatMap(tax => tax.terms.map(term => ({ value: term.id, label: `${tax.name} / ${term.label}` })));
  return <><Form.Item name="termIds" label="分类与标签"><Select aria-label="内容分类与标签" mode="multiple" options={options} placeholder="选择已定义分类" /></Form.Item><Form.Item name="sortOrder" label="手动顺序" extra="数字越小越靠前；相同数值沿用系统顺序。"><InputNumber aria-label="内容手动顺序" min={0} max={1000000} precision={0} /></Form.Item></>;
}
