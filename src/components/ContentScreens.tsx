"use client";
import AiBatchTasks from './AiBatchTasks';
import { ExcelSkuUpdate } from './AiSourceImport';
import { inquirySearchText } from '@/lib/inquiry-items';
import {productImages} from '@/lib/product-images';
import LocaleFilter from './LocaleFilter';
import {localeOf} from '@/lib/localization';
import { requestLocalLeave } from '@/lib/local-recovery';
import { imageAttributes } from '@/lib/media-images';
import ProductParameters from './ProductParameters';
import {readRecovery as readParameterRecovery} from './ContentEditors';
import ContentImportDialog from './ContentImportDialog';
import { MediaInventoryPanel, MediaBatchActions } from './MediaOperations';
import MediaDetailsDrawer, { readMediaDetailsRecovery } from './MediaDetailsDrawer';
import { InquiryCsvButton, InquiryRecordOperations, InquiryRefreshButton, readInquiryNoteRecovery } from './InquiryOperations';
import InquirySourceStats from './InquirySourceStats';
import { formatDate } from '@/lib/date-format';
import { getInquiryFollowUpState, INQUIRY_PRIORITY_LABELS, matchesInquiryFollowUpFilter, type InquiryFollowUpFilter } from '@/lib/inquiry-tracking';
import { isInquiryNoteRecoveryScope, readInquiryNoteRecoveryFromScope } from '@/lib/inquiry-recovery';
import { PUBLICATION_STATE, productPublicationState, type PublicationState } from '@/lib/page-publication-state';

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Avatar, Button, Card, Checkbox, ConfigProvider, Descriptions, Divider, Drawer, Empty,
  Form, Grid, Image, Input, List, Menu, Modal, Segmented, Select,
  Space, Table, Tabs, Tag, Tooltip, Typography, Upload, message,
} from "antd";
import type { TableColumnsType } from "antd";
import { formatFieldValue } from '@/lib/content-models';
import {
  AppstoreOutlined, ArrowRightOutlined, CheckOutlined, CopyOutlined,
  DeleteOutlined, EditOutlined, FileTextOutlined, FolderOutlined,
  InboxOutlined, MailOutlined, PictureOutlined, PlusOutlined,
  SearchOutlined, UnorderedListOutlined, UploadOutlined,
} from "@ant-design/icons";
import type { Inquiry, MediaItem, ScreenProps } from "../lib/types";
import { ProductEditor, readProductRecovery, type ProductRecord } from "./ProductEditor";
import "./content.css";
import { request, RequestError, useStudioRuntime, type StudioEnvelope } from "@/lib/studio-client";
import type { AiWritingReceiptInput } from '@/lib/ai-writing-types';
import { saveWritingDraft } from '@/lib/ai-writing-save-client';
import { clearExternalContentEditor, readExternalContentEditor } from '@/lib/external-ai-review-client';

const { Text } = Typography;
const productPageSize = 8;
const inquiryStatus = {
  new: { label: "待处理", color: "gold" },
  contacted: { label: "已跟进", color: "green" },
  archived: { label: "已归档", color: "default" },
} as const;

function LocalNote({ children }: { children?: React.ReactNode }) {
  return <div className="cs-local-note"><span className="cs-local-dot" />{children ?? "保存用于保留修改，发布后更新网站"}</div>;
}

function ProductBadge({ status }: { status: PublicationState }) {
  return <Tag className="cs-status-tag" color={PUBLICATION_STATE[status].color}>{PUBLICATION_STATE[status].label}</Tag>;
}

function ContentHeader({ title, description, action }: {
  title: string; description: string; action?: React.ReactNode;
}) {
  return <div className="cs-page-header flex flex-wrap items-start justify-between gap-4">
    <div className="min-w-0"><h1>{title}</h1><p>{description}</p></div>
    <div className="cs-header-action">{action}</div>
  </div>;
}

export function ProductsScreen({ state, update, navigate }: ScreenProps) {
  const runtime = useStudioRuntime();
  const compact = Grid.useBreakpoint().md === false;
  const [language,setLanguage]=useState('all');
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("all");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState("all");
  const [view, setView] = useState<string | number>("list");
  const [recovery] = useState(() => readProductRecovery(runtime.actor.id));
  const recoverable = !!recovery && runtime.actor.role !== 'viewer' && (!recovery.existingId || state.products.some(item => item.id === recovery.existingId));
  const [editorOpen, setEditorOpen] = useState(recoverable);
  const [editing, setEditing] = useState<ProductRecord | null>(() => recoverable && recovery?.existingId ? state.products.find(item => item.id === recovery.existingId)! : null);
  const [parametersOpen,setParametersOpen]=useState(()=>!!readParameterRecovery(runtime.actor.id,'product'));
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [productPage, setProductPage] = useState(1);
  const [removal, setRemoval] = useState<{ products: ProductRecord[]; activeReleaseId: string | null; batch: boolean } | null>(null);
  const [removing, setRemoving] = useState(false);
  const removalLock = useRef(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [externalEditor, setExternalEditor] = useState(() => readExternalContentEditor(runtime.actor.id));
  const [externalRecoveryNotice, setExternalRecoveryNotice] = useState(false);
  useEffect(() => {
    if (!externalEditor || externalEditor.target.kind !== 'product') return;
    if (editorOpen && editing?.id !== externalEditor.target.id) return;
    const product = state.products.find(item => item.id === externalEditor.target.id);
    // 恢复中的另一份表单先保留；回到列表后再打开已采用记录，不用服务器数据覆盖本地输入。
    if (!editorOpen && product) { setEditing(product); setEditorOpen(true); }
    else if (!product) messageApi.warning('这条产品已不存在，请核对最新草稿。');
    else if (recovery?.existingId === product.id) setExternalRecoveryNotice(true);
    clearExternalContentEditor(runtime.actor.id); setExternalEditor(null);
  }, [externalEditor, editorOpen, editing?.id, state.products, runtime.actor.id, messageApi]);
  const records = state.products as ProductRecord[];
  const statusOf = useMemo(() => productPublicationState(state.releases), [state.releases]);
  const categories = [...new Set(records.map((item) => item.category).filter(Boolean))];
  const imageOptions = [...new Map([
    ...records.flatMap(item=>productImages(item).map((url,index)=>[url,`${item.name} · ${index+1}`] as const)),
    ...state.media.filter((item) => item.kind === "image").map((item) => [item.url, item.name] as const),
  ]).entries()].map(([value, label]) => ({ value, label }));
  const filtered = useMemo(() => records.filter((item) => {
    if(language!=='all'&&localeOf(state.settings,item)!==language)return false;
    const query = search.trim().toLowerCase();
    return (status === "all" || statusOf(item) === status)
      && (category === "all" || item.category === category)
      && (term === "all" || item.termIds?.includes(term))
      && (!query || `${item.name} ${item.sku} ${item.material}`.toLowerCase().includes(query));
  }), [records, search, category, status, statusOf, term, language, state.settings]);
  const currentPage = Math.min(productPage, Math.max(1, Math.ceil(filtered.length / productPageSize)));
  const visibleProducts = filtered.slice((currentPage - 1) * productPageSize, currentPage * productPageSize);
  // 批量操作只认当前页的勾选；即使另一个窗口更新列表，也不能提交已经不可见的产品。
  const checkedProducts = visibleProducts.filter(item => selected.includes(item.id));

  function resetProductSelection(page = 1) {
    setSelected([]);
    setRemoval(null);
    setProductPage(page);
  }

  function openEditor(product?: ProductRecord) {
    setEditing(product ?? null);
    setEditorOpen(true);
    window.scrollTo({ top: 0 });
  }

  function clearProductFilters() {
    // “清除筛选”和保存后回列表共用完整重置，避免隐藏的语言/标签继续挡住产品。
    setSearch(""); setCategory("all"); setStatus("all"); setTerm("all"); setLanguage("all"); resetProductSelection();
  }

  async function saveProduct(product: ProductRecord, receipts: AiWritingReceiptInput[] = [], source: ProductRecord | null = editing) {
    // 只替换目标 ID，保留其他产品和扩展字段；清空列表筛选让新产品立即可见。
    let writingWarnings: string[] = [];
    await runtime.mutate(async env => {
      // 读取最新工作区不会替换编辑区旧表单；同时比较原记录快照，避免同毫秒/旧无日期记录后改被覆盖。
      const current = source && env.state.products.find(item => item.id === source.id);
      if (source && (!current || JSON.stringify({ ...current, status: undefined }) !== JSON.stringify({ ...source, status: undefined }))) throw new RequestError(409, '这条产品已在别处更新或删除，当前输入已保留，请返回列表核对最新产品。');
      const patch = { products: source
        ? env.state.products.map(item => item.id === source.id ? { ...item, ...product } : item)
        : [product, ...env.state.products.filter(item => item.id !== product.id)] };
      const result = receipts.length ? await saveWritingDraft(env,patch,receipts,{kind:'product',id:product.id,modelId:product.modelId},product) : await request<StudioEnvelope & { writingWarnings?: string[] }>('/api/studio', { method:'PATCH',body:JSON.stringify({expectedRevision:env.revision,patch}) });
      writingWarnings = result.writingWarnings || []; return result;
    });
    setEditorOpen(false);
    setEditing(null);
    setExternalRecoveryNotice(false);
    clearProductFilters();
    window.scrollTo({ top: 0 });
    messageApi.success(source ? "产品修改已保存到数据库" : "产品已加入列表，可按名称或型号搜索");
    if (writingWarnings.length) messageApi.warning(writingWarnings.join('；'), 8);
  }

  function openRemoval(products: ProductRecord[], batch: boolean) {
    // 确认框的产品和线上版本来自同一次显示，保存队列刷新后仍以此为准。
    setRemoval({ products, activeReleaseId: runtime.envelope.activeReleaseId, batch });
  }

  async function removeProducts({ products, activeReleaseId }: NonNullable<typeof removal>) {
    if (!products.length || removalLock.current || runtime.actor.role === 'viewer') return false;
    removalLock.current = true;
    setRemoving(true);
    try {
      await runtime.mutate(env => {
        const targets = new Map(products.map(item => [item.id, item]));
        // 再检查实际提交时的草稿，不能按已过时的名称或选择移除新版本；公开状态单独由服务器投影。
        for (const [id, target] of targets) {
          const current = env.state.products.find(item => item.id === id);
          if (!current || JSON.stringify({ ...current, status: undefined }) !== JSON.stringify({ ...target, status: undefined })) throw new RequestError(409, '选中的产品已更新或移除，请重新核对后再操作。');
        }
        return request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, expectedActiveReleaseId: activeReleaseId, patch: { products: env.state.products.filter(item => !targets.has(item.id)) } }) });
      });
      resetProductSelection(currentPage);
      messageApi.success('已从产品草稿列表中移除');
      return true;
    } catch (error) {
      // 过期确认必须重新核对，关闭弹窗以便直接使用工作区的重新加载入口。
      if (error instanceof RequestError && error.status === 409) resetProductSelection(currentPage);
      messageApi.error((error as Error).message);
      return false;
    } finally {
      removalLock.current = false;
      setRemoving(false);
    }
  }

  const columns: TableColumnsType<ProductRecord> = [
    { title: "产品", dataIndex: "name", key: "name", width: compact ? undefined : 310, render: (_, item) => <div className="cs-product-cell flex min-w-0 items-center gap-3">
      {item.image?<Image src={item.image} alt={item.name} width={40} height={40} preview={false} className="cs-product-thumb" />:<Avatar shape="square" size={40} icon={<PictureOutlined/>} aria-label="尚未设置产品封面"/>}
      <div className="min-w-0"><Button className="cs-title-link" type="link" onClick={() => openEditor(item)}>{item.name}</Button><span className="cs-metadata">{item.sku}</span>{compact && <Space size={4} wrap><ProductBadge status={statusOf(item)} /><Typography.Text type="secondary">{item.category || '未分类'}</Typography.Text></Space>}</div>
    </div> },
    { title: "分类", dataIndex: "category", key: "category", width: 120, responsive: ['md'], render: (value) => <span className="cs-table-label">{value || "未分类"}</span> },
    { title: "参数分组", key: "model", width: 150, responsive: ['md'], render: (_, item) => <span className="cs-table-muted">{state.contentModels?.find(model => model.id === item.modelId)?.name || "基础资料"}</span> },
    { title: "材质", dataIndex: "material", key: "material", responsive: ['md'], ellipsis: true, render: (value) => <span className="cs-table-muted">{value || "—"}</span> },
    { title: "状态", key: "status", width: 112, responsive: ['md'], render: (_, item) => <ProductBadge status={statusOf(item)} /> },
    { title: "操作", key: "actions", width: 110, responsive: ['md'], render: (_, item) => <Space size={4}>
      <Tooltip title="编辑产品"><Button type="text" aria-label={`编辑${item.name}`} icon={<EditOutlined />} onClick={() => openEditor(item)} /></Tooltip>
      <Button type="text" aria-label={`删除${item.name}`} icon={<DeleteOutlined />} onClick={() => openRemoval([item], false)} />
    </Space> },
  ];

  // 保留同一个Table的分页和选择；手机展开资料及参数，写操作仍继承原角色禁用。
  const productDetails = (item: ProductRecord) => {
    const model = state.contentModels?.find(model => model.id === item.modelId);
    return <Space className="mobile-table-details" orientation="vertical" size={12} style={{ width: '100%' }}><Descriptions column={1} size="small" layout="vertical" items={[
      { key: 'name', label: '产品名称', children: item.name }, { key: 'sku', label: '型号', children: item.sku || '未填写' },
      { key: 'category', label: '分类', children: item.category || '未分类' }, { key: 'material', label: '材质', children: item.material || '未填写' },
      { key: 'model', label: '参数分组', children: model?.name || '基础资料' }, { key: 'description', label: '产品介绍', children: item.description || '未填写' },
      ...(model?.fields.map(field => ({ key: `custom:${field.id}`, label: field.label, children: formatFieldValue(field, item.customFields?.[field.id]) || '未填写' })) || []),
    ]} /><Space wrap><Button icon={<EditOutlined />} aria-label={`编辑${item.name}`} onClick={() => openEditor(item)}>编辑产品</Button><Button danger icon={<DeleteOutlined />} aria-label={`删除${item.name}`} onClick={() => openRemoval([item], false)}>移除草稿</Button></Space></Space>;
  };

  if (editorOpen) return <>{contextHolder}{externalEditor?.target.kind === 'product' && editing?.id !== externalEditor.target.id && <Alert style={{ marginBottom: 20 }} type="info" showIcon title="先保留当前产品的未保存输入" description="已采用的外部AI内容仍在草稿中。处理当前表单并返回列表后，会打开那条产品继续编辑。" />}{externalRecoveryNotice && <Alert style={{ marginBottom: 20 }} type="warning" showIcon title="当前显示之前未保存的产品输入" description="外部AI保存的草稿仍在服务器中。这份本地恢复稿已完整保留，请核对差异后再保存，避免覆盖刚采用的内容。" />}<ProductEditor key={editing?.id ?? "new"} product={editing} products={records} categories={categories} models={state.contentModels || []} imageOptions={imageOptions} onSave={saveProduct} onBack={() => { setExternalRecoveryNotice(false); setEditorOpen(false); setEditing(null); window.scrollTo({ top: 0 }); }} /></>;

  return <section className="content-screen cs-products min-w-0">
    {contextHolder}
    {/* 原记录被删时只导出本地输入，不把恢复稿自动当成新产品，也不清除浏览器副本。 */}
    {recovery?.existingId && !recoverable && runtime.actor.role !== 'viewer' && <Alert style={{ marginBottom: 20 }} type="warning" showIcon title="有一份已删除产品的恢复输入" description="原产品已不存在，恢复输入仍保存在当前浏览器，没有自动新建产品。可以先下载保留，避免关闭窗口后丢失。" action={<Button onClick={() => { const blob = new Blob([JSON.stringify(recovery, null, 2)], { type: 'application/json;charset=utf-8' }), url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = 'product-recovery.json'; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }}>下载恢复输入</Button>} />}
    {parametersOpen&&<ProductParameters onClose={()=>setParametersOpen(false)}/>}
    <ContentHeader title="产品管理" description="管理产品资料、图片和展示状态。" action={<Space wrap><AiBatchTasks sourceKind="product"/><ContentImportDialog /><ExcelSkuUpdate /><Button disabled={false} onClick={()=>setParametersOpen(true)}>产品参数</Button><Button icon={<PictureOutlined />} onClick={() => navigate("media")}>素材库</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>新建产品</Button></Space>} />
    {/* 列表卡片统一提供留白，标签、筛选与表格不再各自重复缩进。 */}
    <Card className="cs-main-card" styles={{ body: { padding: 'var(--admin-panel-space,24px)' } }}>
      <Tabs className="cs-status-tabs" tabBarStyle={{ marginBottom: 20 }} activeKey={status} onChange={(key) => { setStatus(key); resetProductSelection(); }} items={[
        { key: "all", label: `全部产品 ${records.length}` },
        ...(['published', 'modified', 'draft'] as const).map(key => ({ key, label: `${PUBLICATION_STATE[key].label} ${records.filter(item => statusOf(item) === key).length}` })),
      ]} />
      {/* 查看权限仍可本地筛选和切换视图；新增、编辑、批量写入继续继承只读禁用。 */}
      <ConfigProvider componentDisabled={false}><div className="cs-toolbar flex flex-wrap items-center gap-3">
        <Input allowClear prefix={<SearchOutlined />} placeholder="搜索产品名称、型号或材质" value={search} onChange={(event) => { setSearch(event.target.value); resetProductSelection(); }} className="cs-search" aria-label="搜索产品" />
        <LocaleFilter settings={state.settings} value={language} onChange={key => { setLanguage(key); resetProductSelection(); }}/><Select aria-label="产品分类" value={category} onChange={key => { setCategory(key); resetProductSelection(); }} className="cs-category-select" options={[{ value: "all", label: "全部分类" }, ...categories.map((item) => ({ value: item, label: item }))]} />
        <Select aria-label="产品标签筛选" value={term} onChange={key => { setTerm(key); resetProductSelection(); }} style={{ minWidth: 180 }} options={[{ value: 'all', label: '全部标签' }, ...(state.taxonomies || []).filter(tax => tax.source === 'product').flatMap(tax => tax.terms.map(term => ({ value: term.id, label: `${tax.name} / ${term.label}` })))]} />
        <div className="cs-toolbar-spacer flex-1" />
        <Segmented aria-label="产品显示方式" value={view} onChange={(value) => { setView(value); resetProductSelection(currentPage); }} options={[
          { value: "list", label: <Tooltip title="列表视图"><UnorderedListOutlined aria-label="列表视图" /></Tooltip> },
          { value: "grid", label: <Tooltip title="网格视图"><AppstoreOutlined aria-label="网格视图" /></Tooltip> },
        ]} />
      </div></ConfigProvider>
      {checkedProducts.length > 0 && <div className="cs-batch-bar flex flex-wrap items-center gap-3"><span>当前页已选择 {checkedProducts.length} 件产品</span><Button size="small" danger icon={<DeleteOutlined />} disabled={removing} onClick={() => openRemoval(checkedProducts, true)}>批量移除</Button><Button size="small" type="text" disabled={removing} onClick={() => setSelected([])}>取消选择</Button></div>}
      <Modal title={removal?.batch ? `移除 ${removal.products.length} 件产品草稿？` : '移除这个产品草稿？'} open={!!removal} onCancel={() => { if (!removing) setRemoval(null); }} okText={removal?.batch ? '确认移除' : '移除'} cancelText="取消" confirmLoading={removing} okButtonProps={{ danger: true }} cancelButtonProps={{ disabled: removing }} onOk={() => {
        if (!removal) return;
        const eligible = removal.batch ? checkedProducts : visibleProducts;
        if (!removal.products.every(item => eligible.some(current => current.id === item.id))) {
          messageApi.warning('当前选择已变化，请重新核对要移除的产品。');
          setRemoval(null);
          return;
        }
        void removeProducts(removal);
      }}>
        <Typography.Paragraph>公开网站保留已发布内容。请核对以下草稿，如需下架，请在发布时确认。</Typography.Paragraph>
        <List size="small" bordered dataSource={removal?.products || []} renderItem={item => <List.Item key={item.id}><Space orientation="vertical" size={2} style={{ overflowWrap: 'anywhere', minWidth: 0 }}><Text strong>{item.name}</Text><Text type="secondary">{item.sku}</Text></Space></List.Item>} />
      </Modal>
      {/* 表头全选按各行配置判断禁用，必须显式给出只读状态，不能只依赖外层主题。 */}
      {view === "list" ? <Table<ProductRecord> className="cs-table mobile-record-table" rowKey="id" columns={columns} dataSource={filtered} rowSelection={{ selectedRowKeys: checkedProducts.map(item => item.id), onChange: setSelected, getCheckboxProps: () => ({ disabled: removing || runtime.actor.role === 'viewer' }) }} pagination={{ current: currentPage, onChange: resetProductSelection, pageSize: productPageSize, showSizeChanger: false, showTotal: (total) => `共 ${total} 件产品` }} locale={{ emptyText: <Empty description="没有找到符合条件的产品"><Button disabled={false} onClick={clearProductFilters}>清除筛选</Button></Empty> }} scroll={compact ? undefined : { x: 820 }} tableLayout={compact ? 'fixed' : undefined} expandable={compact ? { columnWidth: 64, expandedRowRender: productDetails, expandIcon: ({ expanded, onExpand, record }) => <Button className="mobile-record-toggle" type="link" size="small" disabled={false} aria-label={`${expanded ? '收起' : '查看'}产品详情：${record.name}`} aria-expanded={expanded} onClick={event => onExpand(record, event)}>{expanded ? '收起' : '详情'}</Button> } : undefined} /> : <div className="cs-product-grid grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((item) => <Card key={item.id} className="cs-product-card" styles={{ body: { padding: 16 } }} hoverable cover={item.image?<Image src={item.image} alt={item.name} preview={false} />:<div style={{height:160,display:'grid',placeItems:'center'}}><Avatar shape="square" size={64} icon={<PictureOutlined/>} aria-label="尚未设置产品封面"/></div>}>
          <div className="cs-card-category flex items-center justify-between gap-2">{item.category}<ProductBadge status={statusOf(item)} /></div>
          <Button type="link" className="cs-grid-product-name" onClick={() => openEditor(item)}>{item.name}</Button>
          <div className="cs-grid-product-bottom flex items-center justify-between gap-2"><span>{item.sku}</span><Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEditor(item)}>编辑</Button></div>
        </Card>)}
        {filtered.length === 0 && <Empty className="cs-grid-empty col-span-full" description="没有找到符合条件的产品"><Button disabled={false} onClick={clearProductFilters}>清除筛选</Button></Empty>}
      </div>}
    </Card>
    <LocalNote />
  </section>;
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function MediaScreen({ state }: ScreenProps) {
  const runtime = useStudioRuntime();
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState("all");
  const [recovery] = useState(() => runtime.actor.role === 'viewer' ? undefined : readMediaDetailsRecovery(runtime.actor.id));
  const [selected, setSelected] = useState<MediaItem | null>(() => state.media.find(item => item.id === recovery?.snapshot.id) || null);
  const [detailsOpen, setDetailsOpen] = useState(() => !!state.media.find(item => item.id === recovery?.snapshot.id));
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [localFolders, setLocalFolders] = useState<string[]>([]);
  const [messageApi, contextHolder] = message.useMessage();
  const mediaRef = useRef(state.media);
  mediaRef.current = state.media;
  const folders = [...new Set([...state.media.map((item) => item.folder).filter(Boolean), ...localFolders])];
  const searchKey = search.trim().toLowerCase();
  const filtered = state.media.filter((item) => (folder === "all" || item.folder === folder)
    && `${item.name} ${item.alt}`.toLowerCase().includes(searchKey));
  const checked = new Set(checkedIds);
  const checkedMedia = filtered.filter(item => checked.has(item.id));

  // 搜索和文件夹切换时清空勾选，批量操作始终只接收当前列表内仍可见的素材。
  function filterBySearch(value: string) {
    if (value.trim().toLowerCase() !== searchKey) setCheckedIds([]);
    setSearch(value);
  }

  function filterByFolder(value: string) {
    if (value !== folder) setCheckedIds([]);
    setFolder(value);
  }

  useEffect(() => {
    // 恢复入口按素材ID打开本账号的副本；先处理当前详情未保存输入，不重放保存或删除。
    const resume = (event: Event) => {
      const scope = (event as CustomEvent<{ scope?: string }>).detail?.scope;
      if (typeof scope !== 'string' || runtime.actor.role === 'viewer') return;
      const saved = readMediaDetailsRecovery(runtime.actor.id, undefined, scope), item = state.media.find(media => media.id === saved?.snapshot.id);
      if (saved && item) requestLocalLeave(() => { setSelected(item); setDetailsOpen(true); }, 'media-recover');
    };
    window.addEventListener('form-studio:recover-local', resume);
    return () => window.removeEventListener('form-studio:recover-local', resume);
  }, [runtime.actor.id, runtime.actor.role, state.media]);

  function showDetails(item: MediaItem) {
    requestLocalLeave(() => { setSelected(item); setDetailsOpen(true); }, 'media-open');
  }

  async function uploadLocal(file: File) {
    // 多文件串行上传，每次使用最新 revision，避免并发覆盖素材索引。
    uploadQueue.current = uploadQueue.current.catch(() => {}).then(async () => {
      await runtime.mutate(env => {
        const body = new FormData(); body.append('file', file);
        body.append('expectedRevision', String(env.revision));
        body.append('folder', folder === 'all' ? '上传素材' : folder);
        return request<StudioEnvelope>('/api/media', { method: 'POST', body });
      });
      messageApi.success(`${file.name} 已上传并保存`);
    }).catch(error => { messageApi.error(error.message); });
    await uploadQueue.current; return Upload.LIST_IGNORE;
  }

  return <section className="content-screen cs-media min-w-0">
    {contextHolder}
    <ContentHeader title="素材库" description="上传和整理产品图片、PDF目录及视频。" action={<Space wrap><Button icon={<FolderOutlined />} onClick={() => setNewFolderOpen(true)}>新建文件夹</Button><Upload accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,application/pdf" multiple showUploadList={false} beforeUpload={uploadLocal}><Button type="primary" icon={<UploadOutlined />}>上传素材</Button></Upload></Space>} />
    <MediaInventoryPanel />
    <MediaBatchActions key={JSON.stringify([folder, searchKey])} selected={checkedMedia} filteredIds={filtered.map(item => item.id)} setIds={setCheckedIds} />
    <div className="cs-media-layout grid min-w-0 items-start gap-5 lg:grid-cols-[200px_minmax(0,1fr)]">
      <Card className="cs-folder-card" styles={{ body: { padding: "20px 12px" } }}>
        <div className="cs-panel-label">素材文件夹</div>
        {/* inline 模式让图标与自定义数量标签共用一行，避免 vertical 行盒裁掉标签。 */}
        <Menu mode="inline" selectedKeys={[folder]} onClick={({ key }) => filterByFolder(key)} items={[
          { key: "all", icon: <AppstoreOutlined />, label: <span className="cs-folder-label">全部素材 <span>{state.media.length}</span></span> },
          ...folders.map((item) => ({ key: item, icon: <FolderOutlined />, label: <span className="cs-folder-label">{item}<span>{state.media.filter((media) => media.folder === item).length}</span></span> })),
        ]} />
        <div className="cs-folder-tip"><PictureOutlined /><strong>图片上传说明</strong><p>支持静态 JPG、PNG、WebP。上传后统一转为 WebP 并清除元数据。</p><span>图片 ≤ 8 MB / 4000 万像素；PDF ≤ 10 MB；视频 ≤ 40 MB</span></div>
      </Card>
      <Card className="cs-media-main" styles={{ body: { padding: 'var(--admin-panel-space,24px)' } }}>
        {/* 素材搜索只影响当前列表，不解除上传、勾选或详情保存的权限限制。 */}
        <div className="cs-media-heading flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-3"><h2>{folder === "all" ? "全部素材" : folder}</h2><span>{filtered.length} 份素材</span></div><ConfigProvider componentDisabled={false}><Input allowClear className="cs-search" prefix={<SearchOutlined />} placeholder="搜索文件名称或描述" aria-label="搜索素材" value={search} onChange={(event) => filterBySearch(event.target.value)} /></ConfigProvider></div>
        <div className="cs-media-grid grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => <Card key={item.id} className="cs-media-card" styles={{ body: { padding: 16 } }} hoverable tabIndex={0} role="button" aria-label={`查看素材 ${item.name}`} onClick={() => showDetails(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showDetails(item); } }} cover={<div className="cs-media-cover">{item.kind === "image" ? <Image {...imageAttributes(item.url, state.media, '320')} alt={item.alt || item.name} preview={false} height={172} width="100%" styles={{ image: { objectFit: "cover", objectPosition: "center" } }} /> : <div className="cs-document-cover"><FileTextOutlined /><span>{item.kind === "video" ? "VIDEO" : "DOCUMENT"}</span></div>}<span style={{ position: "absolute", left: 10, top: 10, zIndex: 2 }} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}><Checkbox aria-label={`选择素材 ${item.name}`} disabled={runtime.actor.role === "viewer"} checked={checkedIds.includes(item.id)} onChange={e => setCheckedIds(p => e.target.checked ? [...p, item.id] : p.filter(id => id !== item.id))} /></span><span className="cs-media-type">{item.kind === "image" ? "图片" : item.kind === "video" ? "视频" : "文档"}</span></div>}>
            <Tooltip title={item.name}><div className="cs-media-filename">{item.name}</div></Tooltip><div className="cs-media-meta flex items-center justify-between gap-2"><span>{item.folder}{item.kind === "image" && !item.alt && <Tag color="orange">缺Alt</Tag>}</span><span>{item.size}</span></div>
          </Card>)}
          {filtered.length === 0 && <Empty className="cs-grid-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={search ? "没有找到符合条件的素材" : "这个文件夹还没有素材"}><Upload accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,application/pdf" multiple showUploadList={false} beforeUpload={uploadLocal}><Button icon={<UploadOutlined />}>添加第一份素材</Button></Upload></Empty>}
        </div>
      </Card>
    </div>
    <LocalNote>图片会保存在当前网站中；已发布页面仍在使用的图片会继续保留。</LocalNote>
    <Modal title="新建素材文件夹" open={newFolderOpen} okText="创建文件夹" cancelText="取消" onCancel={() => { setNewFolderOpen(false); setNewFolder(""); }} onOk={() => {
      const name = newFolder.trim();
      if (!name) { messageApi.warning("请填写文件夹名称"); return; }
      if (name === "all" || folders.includes(name)) { messageApi.warning("这个文件夹名称已存在"); return; }
      setLocalFolders([...localFolders, name]); filterByFolder(name); setNewFolder(""); setNewFolderOpen(false);
      messageApi.success("文件夹已创建，添加素材后将随素材记录保存");
    }}><Form layout="vertical"><Form.Item label="文件夹名称" required><Input autoFocus maxLength={30} placeholder="例如：2026 新品" value={newFolder} onChange={(event) => setNewFolder(event.target.value)} /></Form.Item><Text type="secondary">空文件夹仅在本次页面停留期间保留，添加素材后会随素材一同保存。</Text></Form></Modal>
    {detailsOpen && selected && <MediaDetailsDrawer key={selected.id} item={selected} folders={folders} onClose={() => setDetailsOpen(false)} />}
  </section>;
}

function inquiryProductSummary(item: Inquiry) {
  return item.items?.length ? `${item.items[0].name} · ${item.items.length} 款` : item.product || '一般咨询';
}

export function InquiriesScreen({ state }: ScreenProps) {
  const runtime = useStudioRuntime();
  const compact = Grid.useBreakpoint().md === false;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [country, setCountry] = useState("all");
  const [followUpFilter, setFollowUpFilter] = useState<InquiryFollowUpFilter>('all');
  const [now, setNow] = useState(() => Date.now());
  const [selectedId,setSelectedId]=useState<string|null>(()=>{const saved=readInquiryNoteRecovery(runtime.actor.id);return saved&&state.inquiries.some(i=>i.id===saved.snapshot.inquiryId)?saved.snapshot.inquiryId:null;});
  const [messageApi, contextHolder] = message.useMessage();
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []);
  useEffect(()=>{const resume=(e:Event)=>{const scope=(e as CustomEvent<{scope?:string}>).detail?.scope;if(isInquiryNoteRecoveryScope(scope)){const saved=readInquiryNoteRecoveryFromScope(runtime.actor.id,scope);if(saved&&state.inquiries.some(i=>i.id===saved.snapshot.inquiryId))requestLocalLeave(()=>setSelectedId(saved.snapshot.inquiryId),'inquiry-recover');}};window.addEventListener('form-studio:recover-local',resume);return()=>window.removeEventListener('form-studio:recover-local',resume);},[runtime.actor.id,state.inquiries]);
  const selected = state.inquiries.find((item) => item.id === selectedId);
  const countries = [...new Set(state.inquiries.map((item) => item.country).filter(Boolean))];
  const filtered = state.inquiries.filter((item) => (status === "all" || item.status === status)
    && (country === "all" || item.country === country)
    && matchesInquiryFollowUpFilter(item, followUpFilter, runtime.actor.id, now)
    && inquirySearchText(item).includes(search.trim().toLowerCase()));
  const newCount = state.inquiries.filter((item) => item.status === "new").length;

  async function changeStatus(id: string, next: Inquiry["status"]) {
    if (runtime.actor.role === 'viewer') return;
    // 状态变更仅记录业务跟进结果，不发送邮件。
    try {
      const old = state.inquiries.find(item => item.id === id) as (Inquiry & { revision?: number }) | undefined;
      const result = await request<{ item: Inquiry }>(`/api/inquiries/${id}`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: old?.revision, status: next }) });
      const current = runtime.getEnvelope();
      runtime.accept({ ...current, state: { ...current.state, inquiries: current.state.inquiries.map(item => item.id === id ? result.item : item) } });
    } catch(error) { messageApi.error((error as Error).message); return; }
    messageApi.success(`已标记为${inquiryStatus[next].label}，状态已保存到数据库`);
  }

  async function copyEmail(email: string) {
    try { await navigator.clipboard.writeText(email); messageApi.success("邮箱已复制，没有发送邮件"); }
    catch { messageApi.info("浏览器未允许复制，请在详情中选择邮箱手动复制"); }
  }

  const columns: TableColumnsType<Inquiry> = [
    { title: "联系人", dataIndex: "name", key: "name", width: compact ? undefined : "27%", render: (_, item) => <div className="cs-inquiry-person"><Avatar size={40} className={`cs-person-avatar ${item.status === "new" ? "is-new" : ""}`}>{item.name.split(" ").map((part) => part[0]).slice(0, 2).join("")}</Avatar><div><Button type="link" className="cs-title-link" onClick={() => setSelectedId(item.id)}>{item.name || "网站访客"}{item.status === "new" && <span className="cs-unread-dot" />}</Button><span className="cs-metadata">{item.company || item.email}</span>{compact && <Space wrap size={4}><Tag color={inquiryStatus[item.status].color}>{inquiryStatus[item.status].label}</Tag>{getInquiryFollowUpState(item, now) === 'overdue' && <Tag color="red">跟进逾期</Tag>}{item.priority && item.priority !== 'normal' && <Tag color="orange">{INQUIRY_PRIORITY_LABELS[item.priority]}</Tag>}{item.qualification === 'invalid' && <Tag>无效</Tag>}</Space>}</div></div> },
    { title: "感兴趣的产品", dataIndex: "product", key: "product", responsive: ['md'], ellipsis: true, render: (_, item) => <span className="cs-table-label">{inquiryProductSummary(item)}</span> },
    { title: "国家 / 地区", dataIndex: "country", key: "country", responsive: ['md'], width: 130 },
    { title: "收到时间", dataIndex: "date", key: "date", responsive: ['md'], width: 155, render: (value) => <span className="cs-table-muted">{formatDate(value, state.settings.timezone)}</span> },
    { title: "状态 / 跟进", dataIndex: "status", key: "status", responsive: ['md'], width: 140, render: (value: Inquiry["status"], item) => <Space orientation="vertical" size={5}><Tag className="cs-status-tag" color={inquiryStatus[value].color}>{inquiryStatus[value].label}</Tag><Space size={4} wrap>{getInquiryFollowUpState(item, now) === 'overdue' && <Tag color="red">跟进逾期</Tag>}{item.priority && item.priority !== 'normal' && <Tag color={item.priority === 'urgent' ? 'volcano' : 'orange'}>{INQUIRY_PRIORITY_LABELS[item.priority]}</Tag>}{item.qualification === 'invalid' && <Tag>无效</Tag>}</Space></Space> },
    { title: "", key: "action", width: 74, render: (_, item) => <Button type="text" icon={<ArrowRightOutlined />} aria-label={`查看${item.name}的询盘`} onClick={() => setSelectedId(item.id)} /> },
  ];

  // 只读成员仍可搜索、查看详情与统计；写入按钮逐项禁用，服务端继续独立鉴权。
  return <ConfigProvider componentDisabled={false}><section className="content-screen cs-inquiries min-w-0">
    {contextHolder}
    <ContentHeader title="询盘管理" description="查看客户需求，整理联系人资料与跟进状态。" action={<Tag className="cs-demo-tag" icon={<InboxOutlined />}>询盘记录</Tag>} />
    <Card className="cs-main-card" styles={{ body: { padding: 'var(--admin-panel-space,24px)' } }}>
      <Tabs className="cs-status-tabs" tabBarStyle={{ marginBottom: 20 }} activeKey={status} onChange={setStatus} items={[
        { key: "all", label: `全部 ${state.inquiries.length}` }, { key: "new", label: `待处理 ${newCount}` },
        { key: "contacted", label: "已跟进" }, { key: "archived", label: "已归档" },
      ]} />
      <div className="cs-toolbar flex flex-wrap items-center gap-3"><Input allowClear className="cs-search" prefix={<SearchOutlined />} placeholder="搜索联系人、公司或产品" aria-label="搜索询盘" value={search} onChange={(event) => setSearch(event.target.value)} /><Select className="cs-category-select" aria-label="询盘国家地区" value={country} onChange={setCountry} options={[{ value: "all", label: "全部国家 / 地区" }, ...countries.map((item) => ({ value: item, label: item }))]} /><Select className="cs-follow-up-filter" aria-label="询盘跟进筛选" value={followUpFilter} onChange={setFollowUpFilter} options={[{ value: 'all', label: '全部跟进' }, { value: 'mine', label: '我负责的' }, { value: 'unassigned', label: '待分配' }, { value: 'overdue', label: '已到期' }, { value: 'priority', label: '高优先级' }]} /><div className="cs-toolbar-spacer flex-1" /><Text type="secondary">{filtered.length} 条记录</Text><InquiryRefreshButton /><InquiryCsvButton search={search} status={status} country={country} followUpFilter={followUpFilter} /></div>
      <Table<Inquiry> rowKey="id" className="cs-table cs-inquiry-table mobile-record-table" columns={columns} dataSource={filtered} rowClassName={(item) => item.status === "new" ? "cs-inquiry-unread" : ""} pagination={{ pageSize: 7, showSizeChanger: false, showTotal: (total) => `共 ${total} 条询盘` }} scroll={compact ? undefined : { x: 900 }} tableLayout={compact ? 'fixed' : undefined} expandable={compact ? { columnWidth: 64, expandIcon: ({ expanded, onExpand, record }) => <Button className="mobile-record-toggle" type="link" size="small" disabled={false} aria-label={`${expanded ? '收起' : '查看'}询盘摘要：${record.name || '网站访客'}`} aria-expanded={expanded} onClick={event => onExpand(record, event)}>{expanded ? '收起' : '详情'}</Button>, expandedRowRender: item => <Descriptions className="mobile-table-details" column={1} size="small" items={[{ key: 'email', label: '邮箱', children: item.email }, { key: 'country', label: '国家 / 地区', children: item.country || '未填写' }, { key: 'product', label: '感兴趣的产品', children: item.product || '一般咨询' }, { key: 'date', label: '收到时间', children: formatDate(item.date, state.settings.timezone) }, { key: 'assignee', label: '负责人', children: item.assignee?.name || '未分配' }, { key: 'message', label: '客户留言', children: item.message || '未填写' }]} /> } : undefined} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的询盘"><Button onClick={() => { setSearch(""); setStatus("all"); setCountry("all"); setFollowUpFilter('all'); }}>查看全部询盘</Button></Empty> }} />
    </Card>
    <InquirySourceStats inquiries={state.inquiries} />
    <LocalNote>客户提交表单后可在这里查看并跟进；邮件通知情况请查看询盘详情。切换网站版本不会覆盖询盘。</LocalNote>
    <Drawer title="询盘详情" open={Boolean(selected)} onClose={()=>requestLocalLeave(()=>setSelectedId(null),'inquiry-close')} size={560} className="cs-drawer" footer={selected && <div className="cs-drawer-footer"><Button disabled={runtime.actor.role === 'viewer'} onClick={() => changeStatus(selected.id, selected.status === "archived" ? "new" : "archived")}>{selected.status === "archived" ? "移回待处理" : "归档询盘"}</Button><Button type="primary" icon={<CheckOutlined />} disabled={runtime.actor.role === 'viewer' || selected.status === "contacted"} onClick={() => changeStatus(selected.id, "contacted")}>{selected.status === "contacted" ? "已标记跟进" : "标记已跟进"}</Button></div>}>
      {selected && <><div className="cs-contact-heading"><Avatar size={58} className="cs-person-avatar">{selected.name.split(" ").map((part) => part[0]).slice(0, 2).join("")}</Avatar><div><h2>{selected.name || "网站访客"}</h2><p>{selected.company}</p></div><Tag color={inquiryStatus[selected.status].color}>{inquiryStatus[selected.status].label}</Tag></div>
        <Descriptions column={1} colon={false} className="cs-contact-details" items={[
          { key: "email", label: "电子邮箱", children: <Space><Text copyable={false}>{selected.email}</Text><Tooltip title="复制邮箱"><Button size="small" type="text" icon={<CopyOutlined />} aria-label="复制客户邮箱" disabled={!selected.email} onClick={() => copyEmail(selected.email)} /></Tooltip></Space> },
          { key: "country", label: "国家 / 地区", children: selected.country || "未填写" },
          { key: "date", label: "收到时间", children: formatDate(selected.date, state.settings.timezone) },
          { key: "product", label: "咨询产品", children: inquiryProductSummary(selected) },
        ]} />
        {!!selected.items?.length && <><Divider /><Typography.Title level={5}>询价清单（{selected.items.length} 款）</Typography.Title>
          <List size="small" bordered dataSource={selected.items} rowKey="productId" renderItem={item => <List.Item><Space orientation="vertical" size={2} style={{ width: '100%', overflowWrap: 'anywhere' }}>
            <Text strong>{item.name}</Text><Text type="secondary">{item.sku} · 数量 {item.quantity}</Text>
            {item.requirements && <Text style={{ whiteSpace: 'pre-wrap' }}>{item.requirements}</Text>}
          </Space></List.Item>} />
        </>}
        <Divider /><div className="cs-message-label">客户留言</div><div className="cs-inquiry-message">{selected.message || "客户没有填写留言内容。"}</div>
        <div className="cs-inquiry-action-note"><MailOutlined /><span>“标记已跟进”只更新记录状态；自动通知另行显示。</span></div><InquiryRecordOperations key={selected.id} inquiry={selected} onDeleted={() => setSelectedId(null)} />
      </>}
    </Drawer>
  </section></ConfigProvider>;
}
