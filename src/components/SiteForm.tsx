'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Select, Space } from 'antd';
import { compileDesignCss, designClassName, type ResponsiveDesign } from '@/lib/responsive-style';
import type { FormDefinition, FormFieldDefinition } from '@/lib/types';
import { captureBrowserAttribution } from '@/lib/inquiry-attribution';
import {componentTranslatableLabels} from '@/lib/component-translatable-labels';
import { MAX_INQUIRY_ITEMS, MAX_INQUIRY_QUANTITY, type InquiryItemInput } from '@/lib/inquiry-items';
import { inquiryProductFields, inquiryProductLabels, SiteInquiryItems, updateInquirySelection, useInquirySelection, type InquiryProductFields, type InquiryProductOption } from './SiteInquiryItems';

type ProductOption = InquiryProductOption;
type Props = { definition: FormDefinition; instanceId: string; sourcePath: string; products: ProductOption[]; productId?: string; demo?: boolean; fieldDesign?: ResponsiveDesign; submitDesign?: ResponsiveDesign; buttonAlign?: 'left' | 'center' | 'right'; wideFields?: string[]; labels?: unknown; locale?: string };
type FormPayload = { token: string; answers: Record<string, unknown>; honeypot: unknown; attribution: ReturnType<typeof captureBrowserAttribution>; items?: InquiryItemInput[] };
class SubmitError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
async function formRequest(path: string, body: unknown, labels:Record<string,string>, signal?: AbortSignal) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const result = await response.json();
  if (!response.ok) throw new SubmitError(response.status >= 500 ? labels.receiptError : result.error || labels.tryAgain, response.status, result.code);
  return result;
}
/** 公开端使用Ant表单；无同源权限的SSR预览使用原生控件，提交始终仅演示。 */
export default function SiteForm({ definition, instanceId, sourcePath, products, productId, demo, fieldDesign, submitDesign, buttonAlign = 'left', wideFields, labels, locale = 'en' }: Props) {
  // 提示随原生组件保存，不改字段标识、校验规则、提交幂等流程或服务端表单定义。
  const messages=useMemo(()=>componentTranslatableLabels('Form',labels),[labels]);
  const [form] = Form.useForm<Record<string, unknown>>();
  const [current, setCurrent] = useState(definition), [options, setOptions] = useState(products);
  const [token, setToken] = useState(''), [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [received, setReceived] = useState(''), [reload, setReload] = useState(0), [uncertain, setUncertain] = useState(false);
  const originalPayload = useRef<FormPayload>(undefined);
  const multiProduct = current.multiProduct === true, inquiryLabels = inquiryProductLabels(locale);
  const selectedProducts = useInquirySelection(locale, multiProduct && !demo);
  const [productFields, setProductFields] = useState<Record<string, InquiryProductFields>>({});
  // 原表单可以直接开启询价单。仅替换映射到「咨询产品」的单选字段，客户自定义产品项继续显示。
  const fields = current.fields.filter(field => !multiProduct || field.type !== 'product' || field.mapTo !== 'product');
  useEffect(() => {
    if (demo || !multiProduct || new URLSearchParams(window.location.search).get('rfq') !== '1') return;
    const available = Array.from(document.querySelectorAll('[data-rfq-review]')).find(section => section.getClientRects().length > 0);
    available?.scrollIntoView({ block: 'start' });
  }, [demo, multiProduct]);
  useEffect(() => { setCurrent(definition); setOptions(products); }, [definition, products]);
  useEffect(() => {
    if (received || demo || !definition.enabled || uncertain) return;
    const controller = new AbortController(); let active = true, timer: ReturnType<typeof setTimeout>;
    setReady(false);
    void formRequest(`/api/public/forms/${encodeURIComponent(definition.id)}/session`, { sourcePath }, messages,controller.signal).then(result => {
      if (!active) return; setToken(result.token); setCurrent(result.form); setOptions(result.products); timer = setTimeout(() => active && setReady(true), result.minDelayMs);
    }).catch(e => { if (active && e.name !== 'AbortError') setError(e.message); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [definition.id, definition.enabled, demo, sourcePath, reload, uncertain, received,messages]);
  if (!current.enabled) return <div className="site-form-unavailable" hidden={!demo}>{demo ? 'This form is disabled.' : null}</div>;
  if (received) return <Space orientation="vertical"><Alert type="success" showIcon title={received} role="status" />{demo && <Button onClick={() => setReceived('')}>Reset demo</Button>}</Space>;
  const inputClass = designClassName(`${instanceId}-fields`), submitClass = designClassName(`${instanceId}-submit`);
  const css = compileDesignCss(`${instanceId}-fields`, fieldDesign, 'FormField') + compileDesignCss(`${instanceId}-submit`, submitDesign, 'FormSubmit');
  const isWide = (field: FormFieldDefinition) => wideFields ? wideFields.includes(field.id) : ['textarea', 'checkbox'].includes(field.type);
  const defaults = Object.fromEntries(current.fields.map(f => [f.id, f.type === 'checkbox' ? false : f.type === 'product' ? productId || '' : '']));
  async function submit(values: Record<string, unknown>) {
    if (busy || !ready) return;
    let payload = uncertain ? originalPayload.current : undefined;
    if (!payload) {
      const items: InquiryItemInput[] = [];
      if (multiProduct) {
        const available = new Set(options.map(product => product.id));
        for (const productId of selectedProducts) {
          const row = inquiryProductFields(productFields, productId);
          const quantity = row.quantity;
          if (!available.has(productId) || quantity === null || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_INQUIRY_QUANTITY) { setError(inquiryLabels.invalid); return; }
          items.push({ productId, quantity, ...(row.requirements.trim() ? { requirements: row.requirements.trim() } : {}) });
        }
        if (!items.length || items.length > MAX_INQUIRY_ITEMS) { setError(inquiryLabels.invalid); return; }
      }
      const answers = Object.fromEntries(fields.filter(field => Object.hasOwn(values, field.id)).map(field => [field.id, values[field.id]]));
      // 首次提交冻结来源、逐项需求和数量。失联重试原样重送，无须依赖浏览器列表后续变化。
      payload = { token, answers, honeypot: values._website || '', attribution: captureBrowserAttribution(), ...(multiProduct ? { items } : {}) };
    }
    setBusy(true); setError('');
    originalPayload.current = payload;
    try {
      const result = await formRequest(`/api/public/forms/${encodeURIComponent(current.id)}`, payload,messages);
      if (payload.items) {
        const receivedIds = new Set(payload.items.map(item => item.productId));
        updateInquirySelection(locale, ids => ids.filter(id => !receivedIds.has(id)));
      }
      setReceived(result.message); setUncertain(false);
    }
    catch (e) {
      const failure = e as SubmitError;
      if (!(e instanceof SubmitError) || failure.status >= 500) { setUncertain(true); setError(messages.unconfirmed); }
      else if (failure.code === 'SUBMISSION_CONFLICT') { setUncertain(true); setReady(false); setError(failure.message); }
      else { originalPayload.current = undefined; setUncertain(false); setError(failure.message); if (failure.code === 'FORM_VERSION_CHANGED' || failure.status === 410) { setReady(false); setToken(''); setReload(v => v + 1); } }
    } finally { setBusy(false); }
  }
  if (demo) return <form className="site-contact-form site-contact-form-native" data-form-demo="true" onSubmit={event => { event.preventDefault(); setReceived('Preview only — no inquiry was sent.'); }}>
    {multiProduct && <fieldset className="site-rfq-fields"><legend>{inquiryLabels.list}</legend><label>{inquiryLabels.select}<select multiple size={Math.min(4, Math.max(2, products.length))} defaultValue={productId ? [productId] : []}>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label><label>{inquiryLabels.quantity}<input type="number" defaultValue={1} min={1} max={MAX_INQUIRY_QUANTITY} /></label><label>{inquiryLabels.requirements}<textarea rows={2} /></label></fieldset>}
    <div className="site-contact-fields">{fields.map(field => <label key={field.id} style={isWide(field) ? { gridColumn: '1 / -1' } : undefined} htmlFor={`${instanceId}-${field.id}`}>{field.label}{field.required ? ' *' : ''}{nativeField(field, `${instanceId}-${field.id}`, products, productId, inputClass,messages.select)}</label>)}</div>
    <div className="site-form-actions" style={{ textAlign: buttonAlign }}><Button className={submitClass} htmlType="submit" type="primary">{current.submitLabel}</Button></div>{css && <style data-form-design={instanceId}>{css}</style>}<p className="site-form-demo-status" role="status">Preview only. Submissions are not stored.</p>
  </form>;
  // Ant 默认将 name 同时设为表单 DOM id；保留 name 生成字段 ID，但由外层区块独占站内锚点。
  return <Form form={form} name={instanceId} id={undefined} className="site-contact-form" layout="vertical" initialValues={defaults} onFinish={submit}>
    {multiProduct && <SiteInquiryItems selected={selectedProducts} products={options} values={productFields} locale={locale} disabled={busy || uncertain}
      onChange={(id, fields) => setProductFields(current => ({ ...current, [id]: fields }))} onSelect={ids => updateInquirySelection(locale, () => ids)} />}
    <div className="site-contact-fields">{fields.map(field => <Form.Item key={field.id} style={isWide(field) ? { gridColumn: '1 / -1' } : undefined} name={field.id} label={field.label} valuePropName={field.type === 'checkbox' ? 'checked' : 'value'} rules={[...(field.required ? field.type === 'checkbox' ? [{ validator: (_: unknown, value: unknown) => value === true ? Promise.resolve() : Promise.reject(new Error(messages.confirm)) }] : [{ required: true, whitespace: true, message: messages.required }] : []), ...(field.type === 'email' ? [{ type: 'email' as const, message: messages.email }] : [])]}>
      {antField(field, options, busy || uncertain, inputClass,messages.select)}
    </Form.Item>)}</div>
    <div className="site-form-honeypot" aria-hidden><Form.Item name="_website" label="Website"><Input tabIndex={-1} autoComplete="off" /></Form.Item></div>
    {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} role="alert" />}
    <div className="site-form-actions" style={{ textAlign: buttonAlign }}><Space wrap><Button className={submitClass} type="primary" htmlType="submit" loading={busy} disabled={!ready}>{uncertain ? messages.retry : current.submitLabel}</Button>{!ready && error && !uncertain && <Button onClick={() => { setError(''); setReload(v => v + 1); }}>{messages.refresh}</Button>}</Space></div>{css && <style data-form-design={instanceId}>{css}</style>}
    <noscript><p>{messages.noScript}</p></noscript>
  </Form>;
}
function antField(field: FormFieldDefinition, products: ProductOption[], disabled: boolean, className: string,selectLabel='Please select') {
  const common = { className, 'aria-label': field.label, disabled, placeholder: field.placeholder, maxLength: field.maxLength };
  if (field.type === 'textarea') return <Input.TextArea {...common} autoSize={{ minRows: 4 }} />;
  if (field.type === 'checkbox') return <Checkbox aria-label={field.label} disabled={disabled}>{field.placeholder || field.label}</Checkbox>;
  if (field.type === 'select' || field.type === 'product') return <Select className={className} aria-label={field.label} disabled={disabled} placeholder={field.placeholder || selectLabel} allowClear options={field.type === 'product' ? products.map(p => ({ label: p.name, value: p.id })) : field.options?.map(o => ({ label: o.label, value: o.id }))} />;
  return <Input {...common} type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'} autoComplete={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'country' ? 'country-name' : field.mapTo === 'name' ? 'name' : field.mapTo === 'company' ? 'organization' : undefined} />;
}
function nativeField(field: FormFieldDefinition, id: string, products: ProductOption[], productId?: string, className?: string,selectLabel='Please select') {
  const common = { className: field.type === 'checkbox' ? undefined : className, id, name: field.id, required: field.required, 'aria-label': field.label };
  if (field.type === 'textarea') return <textarea {...common} placeholder={field.placeholder} maxLength={field.maxLength} rows={4} />;
  if (field.type === 'checkbox') return <input {...common} type="checkbox" />;
  if (field.type === 'select' || field.type === 'product') return <select {...common} defaultValue={field.type === 'product' ? productId || '' : ''}><option value="">{field.placeholder || selectLabel}</option>{(field.type === 'product' ? products.map(p => ({ id: p.id, label: p.name })) : field.options || []).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select>;
  return <input {...common} type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'} placeholder={field.placeholder} maxLength={field.maxLength} />;
}
