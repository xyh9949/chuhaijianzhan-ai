"use client";
import SeoFields from './SeoFields';
import AiTranslationDialog from './AiTranslationDialog';
import RichTextComposer from './RichTextComposer';
import {richTextErrors, textToRichText} from '@/lib/presentation-content';
import ImagePicker from './ImagePicker';
import {productImages,MAX_PRODUCT_IMAGES} from '@/lib/product-images';
import MoreSettings from './MoreSettings';
import {editableLocaleShape} from '@/lib/localization';
import LocaleFields from './LocaleFields';
import RecordTermsFields from './RecordTermsFields';

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AutoComplete, Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { ArrowLeftOutlined, DeleteOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import type { ContentModel, Product } from "../lib/types";
import "./product-editor.css";
import './content-models.css';
import ModelFields, { compactModelValues } from './ModelFields';
import { validateModelValues } from '@/lib/content-models';
import { PUBLICATION_STATE, productPublicationState } from '@/lib/page-publication-state';
import { PRODUCT_CONTENT_LIMITS } from '@/lib/product-content-limits';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import type { AiWritingField, AiWritingProposal, AiWritingReceipt, AiWritingReceiptInput, AiWritingValue } from '@/lib/ai-writing-types';
import AiContentWriter from './AiContentWriter';
import WritingSaveCheck from './WritingSaveCheck';
import { WritingSaveUncertainError, writingRecordDifferences, type PendingWritingSave } from '@/lib/ai-writing-save-client';
import { ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';

type Specification = { label: string; value: string };
// 沿用原产品抽屉已有的扩展字段；编辑时保留未展示的字段和产品 ID。
export type ProductRecord = Product & {
  seoTitle?: string;
  seoDescription?: string;
  specifications?: Specification[];
};
type ProductFields = Omit<ProductRecord, "id">;
type ImageOption = { value: string; label: string };
// 标题与正文共用原生内距，避免移动端规则被Ant后注入的卡片默认样式覆盖。
const productCardStyles = { header: { paddingInline: 'var(--admin-panel-space,24px)' }, body: { padding: 'var(--admin-panel-space,24px)' } };
type ProductEditorProps = {
  product: ProductRecord | null;
  products: ProductRecord[];
  categories: string[];
  models: ContentModel[];
  imageOptions: ImageOption[];
  onSave: (product: ProductRecord, receipts?: AiWritingReceiptInput[], source?: ProductRecord | null) => Promise<void>;
  onBack: () => void;
};

function fieldsOf(product: Partial<ProductFields>): ProductFields {
  const images=productImages(product);
  return {
    locale:product.locale,translationGroupId:product.translationGroupId,translationState:product.translationState,
    termIds: product.termIds ?? [], sortOrder: product.sortOrder ?? 0, slug: product.slug ?? "", name: product.name ?? "", sku: product.sku ?? "", category: product.category ?? "",
    status: product.status ?? "draft", image: images[0]||"", images,
    description: product.description ?? "", ...(product.detailContent?{detailContent:structuredClone(product.detailContent)}:{}), material: product.material ?? "",
    seoImage: product.seoImage ?? "", noindex: product.noindex ?? false, seoTitle: product.seoTitle ?? "", seoDescription: product.seoDescription ?? "",
    modelId: product.modelId ?? "", customFields: structuredClone(product.customFields ?? {}),
    specifications: (product.specifications ?? []).map((item) => ({ label: item?.label ?? "", value: item?.value ?? "" })),
  };
}

type ProductRecovery = { actorId: string; id: string; existingId?: string; fields: ProductFields; source?: ProductRecord | null };
const productRecoveryKey = (actorId: string) => `form-studio:product-recovery:${actorId}`;
export function readProductRecovery(actorId: string): ProductRecovery | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(productRecoveryKey(actorId)) || 'null') as ProductRecovery | null;
    const fields = saved?.fields;
    if (saved?.actorId !== actorId || typeof saved.id !== 'string' || !fields || typeof fields !== 'object' || !['name', 'sku', 'category', 'image', 'description', 'material'].every(key => typeof fields[key as keyof ProductFields] === 'string') || !['draft', 'published'].includes(fields.status)) return null;
    // 恢复旧单图草稿仍有效；损坏的本地相册数据不能进入表单或覆盖产品。
    if (fields.images !== undefined && (!Array.isArray(fields.images) || fields.images.length > MAX_PRODUCT_IMAGES || fields.images.some(url => typeof url !== 'string') || new Set(fields.images).size !== fields.images.length)) return null;
    if (fields.specifications !== undefined && (!Array.isArray(fields.specifications) || !fields.specifications.every(item => item && typeof item.label === 'string' && typeof item.value === 'string'))) return null;
    if (fields.customFields !== undefined && (!fields.customFields || typeof fields.customFields !== 'object' || Array.isArray(fields.customFields) || !Object.values(fields.customFields).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value) && value.every(item => typeof item === 'string')))) return null;
    if(fields.detailContent!==undefined&&richTextErrors(fields.detailContent).length)return null;
    if(!editableLocaleShape(fields))return null;
    // 新恢复稿带原来源；旧稿没有版本仍可读，但必须先明确核对，不能把当前服务器记录冒充原基线。
    if (Object.hasOwn(saved, 'source')) {
      if (saved.existingId ? !saved.source || saved.source.id !== saved.existingId || !['name', 'sku', 'category', 'image', 'description', 'material'].every(key => typeof saved.source?.[key as keyof ProductRecord] === 'string') || !['draft', 'published'].includes(saved.source.status) : saved.source !== null) return null;
    }
    return saved;
  } catch { return null; }
}
function clearProductRecovery(actorId: string) { try { sessionStorage.removeItem(productRecoveryKey(actorId)); } catch { /* 正常保存不依赖浏览器存储。 */ } }

export function ProductEditor({ product, products, categories, models, imageOptions, onSave, onBack }: ProductEditorProps) {
  const runtime = useStudioRuntime();
  const [modal, modalContext] = Modal.useModal();
  const [form] = Form.useForm<ProductFields>();
  const [recovery] = useState(() => { const saved = readProductRecovery(runtime.actor.id); return saved && saved.existingId === product?.id ? saved : null; });
  const [initialValues] = useState(() => fieldsOf(recovery?.fields ?? product ?? { category: categories[0] ?? "", status: "draft" }));
  const baseline = useRef(JSON.stringify(fieldsOf(product ?? { category: categories[0] ?? "", status: "draft" })));
  // 来源快照只随明确确认的保存/撤销更新；工作区刷新不能让旧表单自动取得覆盖新记录的资格。
  const sourceRecord = useRef<ProductRecord | null>(recovery && Object.hasOwn(recovery, 'source') ? recovery.source! : product);
  const legacyRecovery = useRef(!!recovery?.existingId && !Object.hasOwn(recovery, 'source'));
  const recordId = useRef(product?.id || recovery?.id || `product-${crypto.randomUUID()}`);
  const savingRef = useRef(false);
  const imageUploads=useRef(0);const [imagesUploading,setImagesUploading]=useState(false);
  // 同页封面、分享图和扩展相册共用上传锁；不允许在文件尚未入库时保存或离开。
  const onImageUploading=useCallback((active:boolean)=>{imageUploads.current=Math.max(0,imageUploads.current+(active?1:-1));setImagesUploading(imageUploads.current>0);},[]);
  const dirtyRef = useRef(!!recovery);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const pendingLeave = useRef<(() => void) | null>(null);
  const [dirty, setDirty] = useState(!!recovery);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const modelId = Form.useWatch('modelId', form) ?? initialValues.modelId;
  const currentModel = models.find(model => model.id === modelId && model.target === 'product');
  const savedProduct = products.find(item => item.id === recordId.current);
  const publication = savedProduct ? productPublicationState(runtime.envelope.state.releases)(savedProduct) : 'draft';
  const [writerOpen, setWriterOpen] = useState(false), [writerBusy, setWriterBusy] = useState(false);
  const [writerFields, setWriterFields] = useState<AiWritingField[]>([]), [writerSource, setWriterSource] = useState('');
  const [writerLanguage, setWriterLanguage] = useState(runtime.envelope.state.settings.language || 'en');
  const [writerChoices, setWriterChoices] = useState<{ id: string; label: string; text: string }[]>([]);
  const [aiReceipts, setAiReceipts] = useState<AiWritingReceiptInput[]>([]);
  const [pendingWritingSave,setPendingWritingSave]=useState<PendingWritingSave>();
  const [savedRecord,setSavedRecord]=useState(!!product);
  const writerContext = useRef('');
  const writerBusyRef = useRef(false);
  const aiReceiptsRef = useRef<AiWritingReceiptInput[]>([]); aiReceiptsRef.current = aiReceipts;
  const localUndo = useRef<{ receipt: AiWritingReceiptInput; previous: AiWritingReceiptInput[] }[]>([]);
  const onWriterBusy = useCallback((value: boolean) => { writerBusyRef.current = value; setWriterBusy(value); }, []);
  function writingContext() { const values = fieldsOf(form.getFieldsValue(true)); return JSON.stringify({ name: values.name, sku: values.sku, category: values.category, material: values.material, modelId: values.modelId, locale: values.locale || runtime.envelope.state.settings.language || 'en', customFields: values.customFields }); }
  function writingValue(key: string): AiWritingValue { const values = form.getFieldsValue(true); if(key==='detailContent')return values.detailContent||null; if (key.startsWith('customFields:')) { const value = values.customFields?.[key.slice(13)]; return typeof value === 'string' ? value : null; } const value = values[key as keyof ProductFields]; return typeof value === 'string' ? value : null; }
  function setWritingValue(key: string, value: AiWritingValue) { if(key==='detailContent'){form.setFieldValue('detailContent',typeof value==='string'?textToRichText(value):value||undefined);return;} if (value !== null && typeof value !== 'string') throw new Error('产品文案只支持纯文字'); if (key.startsWith('customFields:')) { const fieldId = key.slice(13), next = { ...(form.getFieldValue('customFields') || {}) }; if (value === null) delete next[fieldId]; else next[fieldId] = value; form.setFieldValue('customFields', next); } else form.setFieldValue(key as keyof ProductFields, value ?? ''); }
  function openWriter(preferredField='description') {
    if (savingRef.current || imageUploads.current) { messageApi.info('请先等待保存或图片上传完成'); return; }
    const values = fieldsOf(form.getFieldsValue(true));
    const custom = values.customFields || {};
    const model = models.find(item => item.id === values.modelId && item.target === 'product');
    const editable: AiWritingField[] = [{ key: 'description', label: '产品介绍', kind: 'text', maxLength: 1500, before: values.description }, {key:'detailContent',label:'产品图文详情',kind:'richtext',maxLength:30000,before:values.detailContent||null}, { key: 'seoTitle', label: '搜索标题', kind: 'text', maxLength: 200, before: values.seoTitle || '' }, { key: 'seoDescription', label: '搜索介绍', kind: 'text', maxLength: 500, before: values.seoDescription || '' }, ...(model?.fields.filter(field => field.type === 'text' || field.type === 'textarea').map(field => ({ key: `customFields:${field.id}`, label: field.label, kind: 'text' as const, maxLength: field.type === 'textarea' ? 30000 : 2000, before: typeof values.customFields?.[field.id] === 'string' ? values.customFields[field.id] as string : null })) || [])];
    const language = values.locale || runtime.envelope.state.settings.language || 'en';
    setWriterLanguage(language); setWriterFields(preferredField==='detailContent'?editable.filter(field=>field.key==='detailContent'):editable); setWriterSource([`产品名称：${values.name}`, `型号：${values.sku}`, `分类：${values.category}`, `材质：${values.material}`, `语言：${language}`].join('\n'));
    setWriterChoices(model?.fields.filter(field => !['image', 'gallery', 'relation', 'url'].includes(field.type) && custom[field.id] !== null && custom[field.id] !== undefined && custom[field.id] !== '').map(field => ({ id: field.id, label: field.label, text: `${field.label}：${Array.isArray(custom[field.id]) ? (custom[field.id] as string[]).join('、') : String(custom[field.id])}${field.unit || ''}` })) || []);
    writerContext.current = writingContext(); setWriterOpen(true);
  }
  async function applyWriting(proposal: AiWritingProposal, keys: string[]) {
    if (writerContext.current !== writingContext()) throw new Error('产品资料或语言已变化，旧建议仍保留，请按当前资料重新核对后生成。');
    const changes = proposal.fields.filter(field => keys.includes(field.key));
    if (!changes.length) throw new Error('请选择要填入的字段');
    // 对照当前真实表单，不用React旧闭包判断；未选参数、图片和其他字段保持原值。
    for (const field of changes) if (JSON.stringify(writingValue(field.key)) !== JSON.stringify(field.before)) throw new Error(`${field.label}已有人工修改，不能用旧建议覆盖。`);
    const before: Record<string, AiWritingValue> = {}, after: Record<string, AiWritingValue> = {}, beforePresent: Record<string, boolean> = {};
    const originalCustom = form.getFieldValue('customFields') || {};
    // 区分原本缺省的扩展项与明确空值，保存后撤销可真正删除新填入的可选字段。
    for (const field of changes) {
      if(field.key==='detailContent'){
        const doc=typeof field.after==='string'?textToRichText(field.after):field.after;
        if(richTextErrors(doc).length)throw new Error('产品图文详情格式不正确，原内容保持');
        before[field.key]=writingValue(field.key);beforePresent[field.key]=before[field.key]!==null;after[field.key]=doc;
      }else{if (typeof field.after !== 'string') throw new Error('产品文案格式不正确，原内容保持'); before[field.key] = writingValue(field.key); beforePresent[field.key] = field.key.startsWith('customFields:') ? Object.hasOwn(originalCustom, field.key.slice(13)) && originalCustom[field.key.slice(13)] !== undefined : true; after[field.key] = field.key.startsWith('customFields:') ? field.after : field.after.trim();}
    }
    const selectedKeys = changes.map(field => field.key);
    // 后一次AI接管的字段从旧回执移走，避免同一次保存对一个字段登记两份撤销。
    const retained = aiReceiptsRef.current.map(item => {
      const remaining = item.selectedKeys.filter(key => !selectedKeys.includes(key));
      return { ...item, selectedKeys: remaining, before: Object.fromEntries(remaining.map(key => [key, item.before[key]])), after: Object.fromEntries(remaining.map(key => [key, item.after[key]])), ...(item.beforePresent ? { beforePresent: Object.fromEntries(remaining.map(key => [key, item.beforePresent![key]])) } : {}) };
    }).filter(item => item.selectedKeys.length);
    if (retained.length >= 12) throw new Error('本次已有多项AI采用记录，请先保存当前产品，再继续写作。');
    const receipt = { proposalId: proposal.id, selectedKeys, before, after, beforePresent };
    localUndo.current.push({ receipt, previous: aiReceiptsRef.current });
    for (const field of changes) setWritingValue(field.key, after[field.key]);
    setAiReceipts([...retained, receipt]); markDirty();
    messageApi.success('已填入产品编辑区，请核对并保存产品。');
  }
  function detachWriting() {
    modal.confirm({ title: '保留文字，继续手工保存？', content: '当前产品的文字、图片和参数保持。必要时先读取最新工作区；尚有其它待提交内容或未确认请求时会阻止操作。本次修改不再登记为AI撤销记录，之后仍需点击“保存产品”，不会自动保存或发布。', okText: '保留文字并继续', cancelText: '返回编辑', onOk: async () => {
      // 明确拒绝的写作保存先只读恢复控制器，表单留在原处；不自动重送失败请求。
      try {
        if (runtime.getSaveState() === 'error') await runtime.recoverRejectedMutation();
        else if (runtime.getSaveState() !== 'saved' || runtime.isMutating) throw new Error('工作区仍在同步，请等待完成；当前表单保持。');
      } catch (cause) { messageApi.error(cause instanceof Error ? cause.message : '读取最新工作区失败，当前输入保持'); throw cause; }
      setAiReceipts([]); localUndo.current = []; messageApi.info('文字已保留，请按原流程保存产品。');
    } });
  }
  function undoLocalWriting() {
    const step = localUndo.current.at(-1), last = step?.receipt; if (!last || !step) return;
    for (const key of last.selectedKeys) if (JSON.stringify(writingValue(key)) !== JSON.stringify(last.after[key])) { messageApi.warning('这次填入的字段已有后续人工修改，不能用旧内容覆盖。'); return; }
    last.selectedKeys.forEach(key => setWritingValue(key, last.before[key])); localUndo.current.pop(); setAiReceipts(step.previous); markDirty();
  }
  async function undoSavedWriting(receipt: AiWritingReceipt) {
    if (dirtyRef.current || savingRef.current || imageUploads.current) throw new Error('当前产品有未保存修改或上传，请先处理原编辑区，再撤销已保存的AI字段。');
    await runtime.mutate(env => request<StudioEnvelope>(`/api/ai/writing/receipts/${encodeURIComponent(receipt.id)}/undo`, { method: 'POST', body: JSON.stringify({ expectedRevision: env.revision }) }));
    const latest = runtime.getEnvelope().state.products.find(item => item.id === recordId.current);
    if (!latest) throw new Error('产品已不存在，请返回列表核对');
    // Ant的合并回填不会删除缺省属性；撤销新增长详情时必须清空旧文档，防止续存带回旧AI内容。
    const values = fieldsOf(latest); sourceRecord.current = latest; form.setFieldsValue(values); form.setFieldValue('detailContent',values.detailContent); form.setFieldValue('customFields', values.customFields); baseline.current = JSON.stringify(values); dirtyRef.current = false; setDirty(false); setAiReceipts([]); localUndo.current = [];
  }

  // 翻译只处理已保存记录；确认/撤销后同步源记录元数据，不让旧表单覆盖新建立的语言组。
  function syncTranslationSource() {
    if (dirtyRef.current) return;
    const current = runtime.getEnvelope().state.products.find(item => item.id === recordId.current);
    if (!current) return;
    sourceRecord.current = current;
    const values = fieldsOf(current); form.setFieldsValue(values); form.setFieldValue('detailContent',values.detailContent); form.setFieldValue('customFields', values.customFields); baseline.current = JSON.stringify(values);
  }

  function markDirty() {
    const next = JSON.stringify(fieldsOf(form.getFieldsValue(true))) !== baseline.current;
    dirtyRef.current = next;
    setDirty(next);
    if (!next) clearProductRecovery(runtime.actor.id);
  }

  function requestLeave(proceed: () => void) {
    if (writerBusyRef.current) { messageApi.info('正在等待AI写作结果，请稍后再离开'); return; }
    if(imageUploads.current){messageApi.info('正在上传图片，请稍候');return;}
    if (savingRef.current) { messageApi.info('正在保存，请等待服务器确认'); return; }
    if (!dirtyRef.current) { proceed(); return; }
    pendingLeave.current = proceed;
    setLeaveOpen(true);
  }

  useEffect(() => {
    // 保存遇到会话过期时根工作区将卸载；同步保留产品表单供同账号重新登录恢复。
    const retain = () => { if (dirtyRef.current) { try { sessionStorage.setItem(productRecoveryKey(runtime.actor.id), JSON.stringify({ actorId: runtime.actor.id, id: recordId.current, existingId: sourceRecord.current?.id, fields: fieldsOf(form.getFieldsValue(true)), ...(legacyRecovery.current ? {} : { source: sourceRecord.current }) } satisfies ProductRecovery)); } catch { /* 存储受限时保留能力不可用，不影响正常编辑。 */ } } };
    window.addEventListener('form-studio:session-expired', retain, true);
    return () => window.removeEventListener('form-studio:session-expired', retain, true);
  }, [runtime.actor.id, product?.id, form]);

  useEffect(() => {
    // 根导航暂停切换后由本表单决定是否继续；刷新、关闭窗口使用浏览器原生提示。
    const guardNavigation = (event: Event) => {
      const detail = (event as CustomEvent<{ proceed?: () => void; target?: string }>).detail;
      const proceed = detail?.proceed;
      if (typeof proceed !== "function") return;
      if (writerBusyRef.current) { event.preventDefault(); messageApi.info('正在等待AI写作结果，请稍后再离开'); return; }
      // 在途保存无法通过“放弃”撤销；等待结果后再决定离开，避免误认为已取消写入。
      if(imageUploads.current){event.preventDefault();messageApi.info('正在上传图片，请稍候');return;}
      if (savingRef.current) { event.preventDefault(); messageApi.info('正在保存，请等待服务器确认'); return; }
      const sameModule = detail.target === "products";
      if (!dirtyRef.current) {
        if (sameModule) onBackRef.current();
        return;
      }
      event.preventDefault();
      pendingLeave.current = () => { if (sameModule) onBackRef.current(); proceed(); };
      setLeaveOpen(true);
    };
    const guardUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current&&!imageUploads.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("form-studio:before-navigate", guardNavigation);
    window.addEventListener("beforeunload", guardUnload);
    return () => {
      window.removeEventListener("form-studio:before-navigate", guardNavigation);
      window.removeEventListener("beforeunload", guardUnload);
    };
  }, []);

  async function saveProduct(): Promise<boolean> {
    if (writerBusyRef.current) { messageApi.info('请先等待AI写作结果'); return false; }
    if(imageUploads.current){messageApi.info('正在上传图片，请稍候再保存');return false;}
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      await form.validateFields();
      if (legacyRecovery.current) {
        const latest = await request<StudioEnvelope>('/api/studio'), current = latest.state.products.find(item => item.id === recordId.current);
        if (!current) throw new Error('原产品已被删除，恢复输入仍保留；请先复制或导出需要保留的资料，不会自动重建产品。');
        const values = { ...sourceRecord.current!, ...fieldsOf(form.getFieldsValue(true)) }, differences = writingRecordDifferences(values, current).filter(item => item.key !== 'status');
        // 旧恢复格式缺少原版本，只在本人看过当前差异并明确同意后，才建立新的来源快照。
        const confirmed = await new Promise<boolean>(resolve => modal.confirm({ title: '核对旧恢复稿与当前产品', width: 860, content: <Space orientation="vertical" size={16} style={{ width: '100%' }}><Alert type="warning" showIcon title="这份旧恢复稿没有原版本记录" description="请核对当前服务器资料。确认后，本次表单中的资料将用于覆盖当前产品；取消会完整保留输入，不会保存。" />{differences.length ? <Table size="small" rowKey="key" pagination={false} scroll={{ x: 560 }} dataSource={differences} columns={[{ title: '项目', dataIndex: 'label', width: 100 }, { title: '恢复输入', dataIndex: 'local', render: value => <Typography.Paragraph ellipsis={{ rows: 3, expandable: true }}>{typeof value === 'string' ? value : JSON.stringify(value) ?? '未填写'}</Typography.Paragraph> }, { title: '当前服务器资料', dataIndex: 'server', render: value => <Typography.Paragraph ellipsis={{ rows: 3, expandable: true }}>{typeof value === 'string' ? value : JSON.stringify(value) ?? '未填写'}</Typography.Paragraph> }]} /> : <Typography.Text>本次表单与当前服务器内容一致。</Typography.Text>}</Space>, okText: '已核对，用恢复输入保存', cancelText: '返回编辑，保留输入', onOk: () => { sourceRecord.current = current; legacyRecovery.current = false; resolve(true); }, onCancel: () => resolve(false) }));
        if (!confirmed) return false;
      }
      const values = fieldsOf(form.getFieldsValue(true));
      const customFields = compactModelValues(values.customFields);
      if (values.modelId) {
        const model = models.find(item => item.id === values.modelId && item.target === 'product');
        if (!model) throw new Error('所选产品模型已不存在，请重新选择');
        const errors = validateModelValues(model, customFields);
        if (errors.length) throw new Error(errors.join('；'));
      }
      const next: ProductRecord = {
        ...sourceRecord.current, ...values, modelId: values.modelId || undefined, customFields,
        id: recordId.current,
        name: values.name.trim(), sku: values.sku.trim(), category: values.category.trim(),
        material: values.material?.trim() ?? "", description: values.description?.trim() ?? "",
        seoTitle: values.seoTitle?.trim() ?? "", seoDescription: values.seoDescription?.trim() ?? "",
        specifications: (values.specifications ?? []).map((item) => ({ label: item.label.trim(), value: item.value.trim() })),
      };
      // 服务器确认保存后才解除离开拦截；失败保留输入和脏状态。
      await onSave(next, aiReceiptsRef.current, sourceRecord.current);
      setAiReceipts([]); localUndo.current = [];
      clearProductRecovery(runtime.actor.id);
      dirtyRef.current = false;
      setDirty(false);
      return true;
    } catch (error) {
      if(error instanceof WritingSaveUncertainError)setPendingWritingSave(error.pending);
      dirtyRef.current = JSON.stringify(fieldsOf(form.getFieldsValue(true))) !== baseline.current;
      setDirty(dirtyRef.current);
      const validation = error as { errorFields?: { name: (string | number)[] }[] };
      if (validation.errorFields?.length) {
        form.scrollToField(validation.errorFields[0].name, { block: "center", behavior: "smooth", focus: true });
        messageApi.warning("请完善标出的字段，当前输入已保留");
      } else {
        messageApi.error(error instanceof Error ? error.message : "产品保存未完成，当前输入已保留，请重试");
      }
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function discardAndLeave() {
    clearProductRecovery(runtime.actor.id);
    dirtyRef.current = false;
    setDirty(false);
    setLeaveOpen(false);
    const proceed = pendingLeave.current;
    pendingLeave.current = null;
    proceed?.();
  }

  async function saveAndLeave() {
    const proceed = pendingLeave.current;
    // 先收起弹窗，校验失败时允许直接修正原字段，不丢弃用户输入。
    setLeaveOpen(false);
    if (await saveProduct()) {
      pendingLeave.current = null;
      proceed?.();
    }
  }

  return <section className="content-screen pe-screen min-w-0">
    {contextHolder}{modalContext}
    {recovery && dirty && <Alert type="warning" showIcon title="已恢复会话过期前的产品输入，尚未保存" style={{ marginBottom: 20 }} />}
    {aiReceipts.length > 0 && <Alert className="ai-writing-adoption-notice" type="info" showIcon title="已填入编辑区，尚未保存产品" description="可以继续修改，再点击“保存产品”。建议过期或资料变化时，也可保留文字继续手工保存。" style={{ marginBottom: 20 }} action={<Space wrap><Button icon={<UndoOutlined />} disabled={saving || writerBusy} onClick={undoLocalWriting}>撤回本次填入</Button><Button disabled={saving || writerBusy} onClick={detachWriting}>保留文字，继续保存</Button></Space>} />}
    <div className="pe-back-row flex items-center gap-3">
      <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => requestLeave(onBack)}>返回产品列表</Button>
      <span className="pe-path">产品管理 / {product ? "编辑产品" : "新建产品"}</span>
    </div>
    <div className="pe-page-header flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0"><h1>{product ? product.name : "新建产品"}</h1><p>{product ? `产品型号：${product.sku} · 修改资料后保存` : "完善产品资料，保存后可在产品列表中继续管理。"}</p></div>
      <Space wrap>{runtime.actor.role === 'admin' && <Button icon={<ThunderboltOutlined />} disabled={saving || imagesUploading || writerBusy} onClick={()=>openWriter()}>AI写介绍</Button>}{savedRecord && <AiTranslationDialog target={{kind:'product',id:recordId.current}} disabled={dirty || saving || writerBusy || imagesUploading} onApplied={syncTranslationSource}/>}<Tag className="pe-save-tag" color={dirty ? "gold" : "default"}>{dirty ? "有未保存的修改" : savedRecord ? "正在编辑已保存记录" : "尚未保存"}</Tag></Space>
    </div>
    <Form disabled={saving} form={form} initialValues={initialValues} layout="vertical" onValuesChange={markDirty} requiredMark="optional" className="pe-form">
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_288px]">
        <div className="grid min-w-0 gap-6">
          <Card className="pe-card" styles={productCardStyles} title="产品图片" extra={<span className="pe-secondary">首张为封面</span>}>
            <Form.Item name="images" label="产品图片" rules={[{required:true,validator:(_,value)=>Array.isArray(value)&&value.length>0?Promise.resolve():Promise.reject(new Error('请至少上传或选择一张产品图片'))}]} extra="可一次上传或选择多张，最多20张。首张为封面，也可以调整顺序或指定封面。">
              <ImagePicker label="产品图片" multiple coverFirst max={MAX_PRODUCT_IMAGES} disabled={saving} legacyOptions={imageOptions} onUploadingChange={onImageUploading}/>
            </Form.Item>
          </Card>
          <Card className="pe-card" styles={productCardStyles} title="基础信息">
            <Form.Item name="name" label="产品名称" rules={[{ required: true, whitespace: true, message: "请输入产品名称" }, { max: PRODUCT_CONTENT_LIMITS.name }]}><Input maxLength={PRODUCT_CONTENT_LIMITS.name} showCount placeholder="例如：Arc 弧线休闲椅" /></Form.Item>
            <div className="grid gap-x-5 sm:grid-cols-2">
              <Form.Item name="sku" label="产品型号" rules={[{ required: true, whitespace: true, message: "请输入产品型号" }, { max: PRODUCT_CONTENT_LIMITS.sku }, { validator: (_, value?: string) => !value || !products.some((item) => item.id !== recordId.current && item.sku.trim().toLowerCase() === value.trim().toLowerCase()) ? Promise.resolve() : Promise.reject(new Error("这个型号已存在，请使用其他型号")) }]}><Input maxLength={PRODUCT_CONTENT_LIMITS.sku} placeholder="例如：MR-CH-001" /></Form.Item>
              <Form.Item name="category" label="产品分类" rules={[{ required: true, whitespace: true, message: "请选择产品分类" }, { max: PRODUCT_CONTENT_LIMITS.category }]}><AutoComplete options={categories.map(value=>({value}))} filterOption={(input,option)=>String(option?.value||'').toLowerCase().includes(input.toLowerCase())}><Input aria-label="产品分类" maxLength={PRODUCT_CONTENT_LIMITS.category} placeholder="输入新分类，或选择已有分类" /></AutoComplete></Form.Item>
            </div>
            <Form.Item name="material" label="材质" rules={[{ max: PRODUCT_CONTENT_LIMITS.material }]}><Input maxLength={PRODUCT_CONTENT_LIMITS.material} placeholder="例如：橡木 / 亚麻织物" /></Form.Item>
            <Form.Item name="description" label="产品介绍" rules={[{ max: PRODUCT_CONTENT_LIMITS.description }]} extra="请填写可核实的设计、用途与特点，不使用未经确认的参数或认证。"><Input.TextArea rows={5} maxLength={PRODUCT_CONTENT_LIMITS.description} showCount placeholder="向客户介绍这款产品的主要特点与适用场景。" /></Form.Item>
          </Card>
          {/* 长详情独立于短介绍，生成只填入本编辑区；图片仍显式上传/选取，最终由原保存与发布流程提交。 */}
          <Card className="pe-card" styles={productCardStyles} title="产品图文详情" extra={<span className="pe-secondary">选填</span>}>
            <Typography.Paragraph type="secondary">使用标题、段落、列表和图片完整介绍产品；可继续自由排版。默认详情页会展示这里的内容，也可在页面编辑器中动态绑定。</Typography.Paragraph>
            <Form.Item name="detailContent" rules={[{validator:(_,value)=>{const errors=value===undefined?[]:richTextErrors(value);return errors.length?Promise.reject(new Error(errors.join('；'))):Promise.resolve();}}]}>
              <RichTextComposer label="产品图文详情" readOnly={saving||writerBusy} onChange={doc=>{form.setFieldValue('detailContent',doc);markDirty();}} onUploadingChange={onImageUploading}/>
            </Form.Item>
            <Button icon={<ThunderboltOutlined/>} disabled={saving||writerBusy||imagesUploading||runtime.actor.role!=='admin'} onClick={()=>openWriter('detailContent')}>AI写图文详情</Button>
          </Card>
          <MoreSettings title="分类标签与显示顺序（选填）"><RecordTermsFields taxonomies={runtime.envelope.state.taxonomies} source="product" modelId={modelId} /></MoreSettings>
          {(models.some(model=>model.target==='product')||!!modelId)&&<Card className="pe-card" styles={productCardStyles} title="补充产品资料" extra={<span className="pe-secondary">按需要填写</span>}>
            <Form.Item label="使用哪组产品参数" extra="选择后填写下方资料；切换时会先提示如何处理已有内容。">
              <Select aria-label="使用哪组产品参数" value={modelId || undefined} allowClear placeholder="暂不添加额外参数" options={models.filter(model => model.target === 'product').map(model => ({ value: model.id, label: model.name }))} onChange={next => {
                const apply = () => { form.setFieldValue('modelId', next || ''); form.setFieldValue('customFields', {}); markDirty(); };
                // 切换模型不自动迁移不同语义的字段；只有确认并保存后才会替换数据库值。
                if (Object.keys(form.getFieldValue('customFields') || {}).length) modal.confirm({ title: '切换产品参数组？', content: '当前参数组中填写的内容会从本次编辑中清空；基础资料保持不变，保存产品后才生效。', okText: '切换并清空参数', cancelText: '继续使用当前参数组', onOk: apply });
                else apply();
              }} />
            </Form.Item>
            <Form.Item name="modelId" hidden><Input /></Form.Item>
            {currentModel ? <>{currentModel.description && <p className="pe-help">{currentModel.description}</p>}<ModelFields model={currentModel} imageOptions={imageOptions} productImages imagesDisabled={saving} onUploadingChange={onImageUploading} /></> : <p className="pe-help">选择参数分组后，在这里填写尺寸、图片或其他资料。管理员可在产品管理的“产品参数”中调整填写项目。</p>}
          </Card>}
          <Card className="pe-card" styles={productCardStyles} title="产品规格" extra={<span className="pe-secondary">选填</span>}>
            <p className="pe-help pe-section-help">按名称与内容成对填写，尺寸、重量等数值请同时注明单位。</p>
            <Form.List name="specifications">{(fields, { add, remove }) => <>
              {fields.map((field, index) => <div className="pe-spec-row grid items-start gap-3" key={field.key}>
                <Form.Item name={[field.name, "label"]} label={index === 0 ? "规格名称" : undefined} rules={[{ required: true, whitespace: true, message: "请填写规格名称" }, { max: 80, message: "名称最多 80 个字符" }]}><Input aria-label={`第 ${index + 1} 项规格名称`} maxLength={80} placeholder="例如：宽度" /></Form.Item>
                <Form.Item name={[field.name, "value"]} label={index === 0 ? "规格内容" : undefined} rules={[{ required: true, whitespace: true, message: "请填写规格内容" }, { max: 250, message: "内容最多 250 个字符" }]}><Input aria-label={`第 ${index + 1} 项规格内容`} maxLength={250} placeholder="例如：80 cm" /></Form.Item>
                <Button className={index === 0 ? "pe-spec-first-remove" : ""} type="text" icon={<DeleteOutlined />} aria-label={`移除第 ${index + 1} 项规格`} onClick={() => remove(field.name)} />
              </div>)}
              <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ label: "", value: "" })}>添加规格</Button>
            </>}</Form.List>
          </Card>
          <div><SeoFields media={runtime.envelope.state.media} fallbackTitle={product?.name} productImages imagesDisabled={saving} onUploadingChange={onImageUploading}>
            <Form.Item name="slug" label="产品网址名称" extra="一般可以留空。若修改已发布产品的网址，旧链接需另行设置跳转。" rules={[{ pattern: /^[a-z0-9][a-z0-9_-]{0,99}$/, message: '使用小写字母、数字、短横线或下划线，最多100字符' }]}><Input aria-label="产品网址名称" maxLength={100} /></Form.Item>
          </SeoFields><LocaleFields settings={runtime.envelope.state.settings}/></div>
        </div>
        <aside className="grid min-w-0 gap-5 xl:sticky xl:top-6">
          <Card className="pe-card" styles={productCardStyles} title="状态与保存">
            <Form.Item name="status" hidden><Input /></Form.Item>
            <Form.Item label="发布状态"><Tag color={PUBLICATION_STATE[publication].color}>{PUBLICATION_STATE[publication].label}</Tag></Form.Item>
            <div className="pe-status-note">{publication === 'published' ? '已保存草稿与公开版本一致' : publication === 'modified' ? '网站仍展示上次发布的资料' : '当前公开版本未包含此产品'}</div>
            <Button type="primary" block icon={<SaveOutlined />} loading={saving} disabled={imagesUploading} onClick={() => { void saveProduct(); }}>保存产品</Button>
            <Button block onClick={() => requestLeave(onBack)} className="pe-cancel">返回列表</Button>
            {imagesUploading&&<p role="status" className="pe-help pe-save-help">正在上传图片，请稍候再保存产品。</p>}
            <p className="pe-help pe-save-help">保存后返回产品列表。需要更新网站时，再到发布管理确认发布。</p>
          </Card>
          <Alert type="info" showIcon title="草稿与发布" description="保存用于保留修改，发布后客户才会看到新资料。" />
        </aside>
      </div>
    </Form>
    {pendingWritingSave&&<WritingSaveCheck pending={pendingWritingSave} current={()=>({...pendingWritingSave.record,...fieldsOf(form.getFieldsValue(true)),id:recordId.current})} onConfirmed={saved=>{sourceRecord.current=saved as ProductRecord;const values=fieldsOf(saved as Product);form.setFieldsValue(values);form.setFieldValue('detailContent',values.detailContent);form.setFieldValue('customFields',values.customFields);baseline.current=JSON.stringify(values);dirtyRef.current=false;setDirty(false);setSavedRecord(true);setAiReceipts([]);localUndo.current=[];setPendingWritingSave(undefined);clearProductRecovery(runtime.actor.id);messageApi.success('已确认保存，当前产品可以继续编辑。');}}/>}
    <AiContentWriter open={writerOpen} onClose={() => setWriterOpen(false)} target={{ kind: 'product', id: recordId.current, ...(modelId ? { modelId } : {}) }} fields={writerFields} sourceText={writerSource} sourceChoices={writerChoices} initialLanguage={writerLanguage} initialTask="product" initialInstruction={writerFields.length===1&&writerFields[0].key==='detailContent'?'只依据已有资料，按买家关注点组织有依据的标题、段落和列表，缺失参数列为待补；保留原图和链接。':''} onApply={applyWriting} onUndoSaved={undoSavedWriting} onBusyChange={onWriterBusy} />
    <Modal title="产品修改尚未保存" open={leaveOpen} onCancel={() => { pendingLeave.current = null; setLeaveOpen(false); }} footer={<Space wrap><Button onClick={() => { pendingLeave.current = null; setLeaveOpen(false); }}>继续编辑</Button><Button danger onClick={discardAndLeave}>放弃修改并离开</Button><Button type="primary" loading={saving} onClick={() => { void saveAndLeave(); }}>保存并离开</Button></Space>}>
      <p className="pe-leave-description">离开此页会丢失未保存的产品修改。你可以先保存，或继续留在这里编辑。</p>
    </Modal>
  </section>;
}
