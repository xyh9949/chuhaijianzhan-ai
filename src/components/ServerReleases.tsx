'use client';
import AuditLog from './AuditLog';
import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Collapse, Descriptions, Divider, Drawer, Empty, Flex, Grid, Input, Modal, Space, Spin, Table, Tag, Timeline, Typography, type TableProps } from 'antd';
import { CloudUploadOutlined } from '@ant-design/icons';
import { request, RequestError, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { FIELD_TYPE_LABELS, formatFieldValue } from '@/lib/content-models';
import { getContentEntryPath } from '@/lib/content-routes';
import type { ContentModel, ContentEntry, PageItem, Product, Release } from '@/lib/types';
import { formatDate } from '@/lib/date-format';
import './release-details.css';

type SnapshotCode = { css: string; js: string; cssEnabled: boolean; jsEnabled: boolean };
type SnapshotLayout = { header?: { mode: string; blockId?: string }; footer?: { mode: string; blockId?: string } };
type Activation = Pick<Release, 'id' | 'title'> & { expectedActiveReleaseId: string | null };

// 展开只读取历史快照；只读成员也可查看，不能继承外围写操作的禁用状态。
function mobileExpandIcon<RecordType extends object>(kind: string, label: (record: RecordType) => string): NonNullable<NonNullable<TableProps<RecordType>['expandable']>['expandIcon']> {
  return ({ expanded, onExpand, record }) => <Button type="link" className="release-detail-toggle" size="small" disabled={false} aria-expanded={expanded} aria-label={`${expanded ? '收起' : '查看'}${kind}详情：${label(record)}`} onClick={event => { event.stopPropagation(); onExpand(record, event); }}>{expanded ? '收起' : '详情'}</Button>;
}

/** 线上切换与草稿恢复使用独立接口，避免回滚网站时覆盖编辑中的内容。 */
export default function ServerReleases({ onPublish }: { onPublish: () => void }) {
  const runtime = useStudioRuntime(); const { message } = App.useApp();
  const compact = Grid.useBreakpoint().md === false;
  const [selected, setSelected] = useState<Release | null>(null);
  const [detailError, setDetailError] = useState('');
  const detailRequest = useRef<AbortController | null>(null);
  const [activation, setActivation] = useState<Activation>();
  const [activationBusy, setActivationBusy] = useState(false);
  const [activationError, setActivationError] = useState<{ message: string; conflict: boolean }>();
  const [restoring, setRestoring] = useState(false);
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [sharedBlockIds, setSharedBlockIds] = useState<string[]>([]);
  const [productIds, setProductIds] = useState<string[]>([]);
  const [contentModelIds, setContentModelIds] = useState<string[]>([]);
  const [contentEntryIds, setContentEntryIds] = useState<string[]>([]);
  // 主题可单独恢复，无需选择页面或切换公开版本。
  const [includeTheme, setIncludeTheme] = useState(false);
  const [includeSettings, setIncludeSettings] = useState(false);
  const [includeTemplates, setIncludeTemplates] = useState(false);
  const [includeForms, setIncludeForms] = useState(false);
  const [includeRedirects, setIncludeRedirects] = useState(false);
  const [includeCatalog, setIncludeCatalog] = useState(false);
  const [includeLayout, setIncludeLayout] = useState(false);
  const [includeCode, setIncludeCode] = useState(false);
  const [busy,setBusy]=useState(false),[restoreError,setRestoreError]=useState(''),[restoreCheck,setRestoreCheck]=useState<{expectedRevision:number;releaseId:string;requestKey:string;errors:string[];warnings:string[];summary:{objectIds:string[];fields:string[];totalPages:number;totalProducts:number;totalEntries:number}|null}>();
  const restoreScope={pageIds,productIds,contentModelIds,contentEntryIds,sharedBlockIds,includeTemplates,includeForms,includeRedirects,includeCatalog,includeLayout,includeCode,includeTheme,includeSettings};
  const restoreKey=JSON.stringify(restoreScope),hasRestoreSelection=!!(pageIds.length||productIds.length||contentModelIds.length||contentEntryIds.length||sharedBlockIds.length||includeTemplates||includeForms||includeRedirects||includeCatalog||includeLayout||includeCode||includeTheme||includeSettings);
  const restoreChecked=!!restoreCheck&&!restoreCheck.errors.length&&restoreCheck.releaseId===selected?.id&&restoreCheck.requestKey===restoreKey&&restoreCheck.expectedRevision===runtime.envelope.revision;
  const releases = runtime.envelope.state.releases;
  useEffect(() => () => detailRequest.current?.abort(), []);

  // 工作区只携带当前公开快照；历史详情打开时读取，关闭或换版取消旧请求。
  function showRelease(release: Release) {
    detailRequest.current?.abort();
    setSelected(release);
    setDetailError('');
    if (release.snapshot) return;
    const controller = new AbortController();
    detailRequest.current = controller;
    void request<{ snapshot: NonNullable<Release['snapshot']> }>(`/api/releases/${encodeURIComponent(release.id)}`, { signal: controller.signal }).then(({ snapshot }) => {
      if (!controller.signal.aborted) setSelected(current => current?.id === release.id ? { ...current, snapshot } : current);
    }).catch(error => {
      if (!controller.signal.aborted) setDetailError((error as Error).message);
    });
  }
  function closeRelease() {
    detailRequest.current?.abort();
    setSelected(null);
  }
  function activate(release: Release) {
    // 确认只授权切换打开弹窗时看到的线上版本，等待队列期间不能换成另一版本后直接提交。
    setActivation({ id: release.id, title: release.title, expectedActiveReleaseId: runtime.getEnvelope().activeReleaseId });
    setActivationError(undefined);
  }
  async function confirmActivation() {
    if (!activation || activationBusy || activationError?.conflict) return;
    setActivationBusy(true);
    try {
      await runtime.mutate(() => request<StudioEnvelope>(`/api/releases/${activation.id}/activate`, { method: 'POST', body: JSON.stringify({ expectedActiveReleaseId: activation.expectedActiveReleaseId }) }));
      setActivation(undefined); closeRelease(); message.success('公开版本已切换');
    } catch (error) {
      setActivationError({ message: (error as Error).message, conflict: error instanceof RequestError && error.status === 409 });
    } finally { setActivationBusy(false); }
  }
  async function readLatestActivation() {
    setActivationBusy(true);
    try {
      // 只恢复明确被拒绝的请求，不丢弃别的未保存输入，也不自动重放这次切换。
      await runtime.recoverRejectedMutation();
      setActivation(undefined); closeRelease(); message.info('已读取当前公开版本，请重新选择要切换的版本');
    } catch (error) {
      setActivationError({ message: (error as Error).message, conflict: true });
    } finally { setActivationBusy(false); }
  }
  async function checkRestore(){if(!selected)return;setBusy(true);setRestoreError('');setRestoreCheck(undefined);try{await runtime.flush();const result=await request<NonNullable<typeof restoreCheck>>(`/api/releases/${selected.id}/restore-preview`,{method:'POST',body:JSON.stringify({...restoreScope,expectedRevision:runtime.getEnvelope().revision})});setRestoreCheck({...result,requestKey:restoreKey});}catch(e){setRestoreError((e as Error).message);}finally{setBusy(false);}}
  async function restore() {
    if(!selected||!restoreCheck||!restoreChecked)return;setBusy(true);setRestoreError('');
    try {await runtime.mutate(env=>{if(env.revision!==restoreCheck.expectedRevision)throw new RequestError(409,'草稿已变化，请重新预检；尚未覆盖');return request<StudioEnvelope>(`/api/releases/${selected.id}/restore-draft`,{method:'POST',body:JSON.stringify({...restoreScope,expectedRevision:restoreCheck.expectedRevision})});});message.success('选中内容已恢复为草稿，公开版本未改变');setRestoring(false);setSelected(null);setRestoreCheck(undefined);}
    catch(e){setRestoreError((e as Error).message);setRestoreCheck(undefined);}finally{setBusy(false);}
  }
  const pages = (selected?.snapshot?.pages || []) as PageItem[];
  const sharedBlocks = (selected?.snapshot?.sharedBlocks || []) as { id: string; name: string }[];
  const models = (selected?.snapshot?.contentModels || []) as ContentModel[];
  const entries = (selected?.snapshot?.contentEntries || []) as ContentEntry[];
  const products = (selected?.snapshot?.products || []) as Product[];
  // 历史值始终按照该快照的模型解释，不能拿当前草稿字段标签或选项替换。
  const fieldDetails = (record: Pick<Product, 'modelId' | 'customFields'>) => {
    const model = models.find(item => item.id === record.modelId);
    // 自定义标签可以很长；手机让标签和值分行，避免值被标签挤成单字竖排。
    return model ? <Descriptions column={1} layout={compact ? 'vertical' : 'horizontal'} size="small" items={model.fields.map(field => ({ key: field.id, label: field.label, children: formatFieldValue(field, record.customFields?.[field.id]) || '未填写' }))} /> : <Typography.Text type="secondary">没有扩展模型</Typography.Text>;
  };
  const layout = (selected?.snapshot?.siteLayout || {}) as SnapshotLayout;
  const customCode = selected?.snapshot?.customCode as { global?: SnapshotCode; pages?: Record<string, SnapshotCode> } | undefined;
  const codeEntries = customCode ? [{ id: 'global', label: '整个网站', value: customCode.global }, ...Object.entries(customCode.pages || {}).map(([id, value]) => ({ id, label: pages.find(page => page.id === id)?.title || id, value }))] : [];
  // 版本名称与状态允许换行，窄屏不挤压长标题或操作区域。
  const layoutLabel = (slot?: { mode: string; blockId?: string }) => !slot || slot.mode === 'default' ? '默认布局' : slot.mode === 'hidden' ? '隐藏' : sharedBlocks.find(block => block.id === slot.blockId)?.name || '未找到区块';
  // 发布操作随标题正常换行，窄屏或建站流程提示出现时不再悬在标题上方。
  return <section className="sys-screen release-screen"><Flex className="sys-heading" wrap align="center" justify="space-between" gap={16}><div><Typography.Text className="sys-eyebrow">站点运营</Typography.Text><Typography.Title level={2}>发布管理</Typography.Title><Typography.Paragraph>查看已经发布的网站内容，需要时可找回以前的版本。</Typography.Paragraph></div><Button disabled={runtime.actor.role !== 'admin'} type="primary" icon={<CloudUploadOutlined />} onClick={onPublish}>发布更改</Button></Flex>
    <Alert showIcon type="info" title="保存用于保留修改，发布后才更新网站" description={<span>发布立即更新本实例的公开网站。域名解析和外部服务器部署仍需单独配置。 <a href="/" target="_blank" rel="noreferrer">打开公开网站 ↗</a></span>} />
    <Card style={{ marginTop: 24 }} styles={{body:{padding:'var(--admin-panel-space,24px)'}}}>{!releases.length ? <Empty description="尚未发布任何版本" /> : <Timeline items={releases.map(release => ({ color: release.status === 'current' ? 'blue' : 'gray', content: <div className="sys-release-item"><Space wrap><Typography.Title level={5}>{release.title}</Typography.Title>{release.status === 'current' && <Tag color="green">当前公开版本</Tag>}</Space><p>{formatDate(release.date, runtime.envelope.state.settings.timezone)} · {release.author}</p><Space wrap><Button size="small" disabled={false} onClick={() => showRelease(release)}>查看版本内容</Button>{runtime.actor.role === 'admin' && release.status !== 'current' && <Button size="small" onClick={() => activate(release)}>切换到此版本</Button>}</Space></div> }))} />}</Card>
    {runtime.actor.role === 'admin' && <Collapse style={{marginTop:24}} items={[{key:'audit',label:'操作审计 · 独立运行记录',children:<AuditLog />}]} />}
    <Drawer rootClassName="release-details-drawer" title="已发布的版本内容" open={!!selected} onClose={closeRelease} size={660}>{selected && !selected.snapshot && (detailError ? <Alert type="error" showIcon title={detailError} action={<Button size="small" onClick={() => showRelease(selected)}>重新读取</Button>} /> : <Spin size="small" description="正在读取版本内容"><div style={{ minHeight: 64 }} /></Spin>)}{selected?.snapshot && <><Descriptions column={1} items={[{ key: 'title', label: '版本', children: selected.title }, { key: 'date', label: '发布时间', children: formatDate(selected.date, runtime.envelope.state.settings.timezone) }, { key: 'author', label: '操作人', children: selected.author }, { key: 'id', label: '版本编号', children: selected.id }]} /><Typography.Title level={5}>包含的页面</Typography.Title>
    {/* 保留同一张表及其分页；手机只收起次要列，详情仍按当前历史快照解释。 */}
    <Table<PageItem> className="release-details-table release-pages-table" rowKey="id" size="small" tableLayout="fixed" pagination={false} dataSource={pages} columns={[{ title: '页面', dataIndex: 'title' }, { title: '路径', dataIndex: 'slug', responsive: ['md'] }]} expandable={{ showExpandColumn: compact, columnWidth: compact ? 64 : undefined, rowExpandable: () => compact, expandIcon: mobileExpandIcon('页面', (page: PageItem) => page.title), expandedRowRender: page => <Descriptions column={1} size="small" items={[{ key: 'title', label: '页面', children: page.title }, { key: 'path', label: '完整路径', children: page.slug }]} /> }} /><Typography.Paragraph style={{ marginTop: 20 }}>产品：{Array.isArray(selected.snapshot?.products) ? selected.snapshot.products.length : 0} 件 · 包含独立主题与公开资料</Typography.Paragraph>
    <Divider /><Typography.Title level={5}>栏目设置 · {models.length}</Typography.Title>{models.length ? <Collapse items={models.map(model => ({ key: model.id, label: `${model.name} · ${model.fields.length} 个字段`, children: <Table<ContentModel['fields'][number]> className="release-details-table release-fields-table" rowKey="id" size="small" tableLayout="fixed" pagination={false} dataSource={model.fields} columns={[{ title: '字段', dataIndex: 'label' }, { title: '类型', dataIndex: 'type', responsive: ['md'], render: type => FIELD_TYPE_LABELS[type as keyof typeof FIELD_TYPE_LABELS] }, { title: '必填', dataIndex: 'required', responsive: ['md'], render: value => value ? '是' : '否' }]} expandable={{ showExpandColumn: compact, columnWidth: compact ? 64 : undefined, rowExpandable: () => compact, expandIcon: mobileExpandIcon('字段', field => field.label), expandedRowRender: field => <Descriptions column={1} size="small" items={[{ key: 'label', label: '字段名称', children: field.label }, { key: 'type', label: '字段类型', children: FIELD_TYPE_LABELS[field.type] }, { key: 'required', label: '是否必填', children: field.required ? '是' : '否' }]} /> }} /> }))} /> : <Typography.Text type="secondary">此版本没有栏目设置</Typography.Text>}
    <Divider /><Typography.Title level={5}>产品资料与扩展字段</Typography.Title><Table<Product> className="release-details-table release-products-table" rowKey="id" size="small" tableLayout="fixed" pagination={{ pageSize: 8, hideOnSinglePage: true, disabled: false }} dataSource={products} columns={[{ title: '产品', dataIndex: 'name', render: (_, product) => compact ? <Space orientation="vertical" size={2} className="release-record-summary"><Typography.Text>{product.name}</Typography.Text><Typography.Text type="secondary" className="release-record-subtitle">{product.sku || '未填写型号'}</Typography.Text></Space> : product.name }, { title: '型号', dataIndex: 'sku', responsive: ['md'] }, { title: '所属栏目', dataIndex: 'modelId', responsive: ['md'], render: id => models.find(model => model.id === id)?.name || '基础产品' }]} expandable={{ columnWidth: compact ? 64 : undefined, expandIcon: compact ? mobileExpandIcon('产品', product => product.name) : undefined, expandedRowRender: product => compact ? <><Descriptions column={1} size="small" items={[{ key: 'name', label: '产品', children: product.name }, { key: 'sku', label: '完整型号', children: product.sku || '未填写' }, { key: 'model', label: '所属栏目', children: models.find(model => model.id === product.modelId)?.name || '基础产品' }]} />{fieldDetails(product)}</> : fieldDetails(product), rowExpandable: product => compact || !!product.modelId }} />
    <Typography.Title level={5}>独立内容 · {entries.length}</Typography.Title><Table<ContentEntry> className="release-details-table release-entries-table" rowKey="id" size="small" tableLayout="fixed" pagination={{ pageSize: 8, hideOnSinglePage: true, disabled: false }} dataSource={entries} columns={[{ title: '标题', dataIndex: 'title' }, { title: '所属栏目', dataIndex: 'modelId', responsive: ['md'], render: id => models.find(model => model.id === id)?.name || '未找到模型' }, { title: '历史详情路径', responsive: ['md'], render: (_, entry) => <Typography.Text code>{getContentEntryPath({ pages, contentModels: models, contentEntries: entries }, entry) || '无详情模板'}</Typography.Text> }]} expandable={{ columnWidth: compact ? 64 : undefined, expandIcon: compact ? mobileExpandIcon('内容', entry => entry.title) : undefined, expandedRowRender: entry => compact ? <><Descriptions column={1} size="small" items={[{ key: 'title', label: '标题', children: entry.title }, { key: 'model', label: '所属栏目', children: models.find(model => model.id === entry.modelId)?.name || '未找到模型' }, { key: 'path', label: '完整详情路径', children: getContentEntryPath({ pages, contentModels: models, contentEntries: entries }, entry) || '无详情模板' }]} />{fieldDetails(entry)}</> : fieldDetails(entry) }} />
    <Divider /><Typography.Title level={5}>同步区块 · {sharedBlocks.length}</Typography.Title>{sharedBlocks.length ? <Space wrap>{sharedBlocks.map(block => <Tag key={block.id}>{block.name}</Tag>)}</Space> : <Typography.Text type="secondary">此版本没有同步区块</Typography.Text>}<Descriptions style={{ marginTop: 20 }} column={1} items={[{ key: 'header', label: '全站页眉', children: layoutLabel(layout.header) }, { key: 'footer', label: '全站页脚', children: layoutLabel(layout.footer) }]} />
    <Typography.Title level={5}>自定义代码</Typography.Title>{codeEntries.length ? <Collapse size="small" items={codeEntries.map(item => ({ key: item.id, label: <Space wrap>{item.label}<Tag color={item.value?.cssEnabled ? 'blue' : 'default'}>CSS {item.value?.cssEnabled ? '启用' : '停用'}</Tag><Tag color={item.value?.jsEnabled ? 'blue' : 'default'}>JS {item.value?.jsEnabled ? '启用' : '停用'}</Tag></Space>, children: <Space orientation="vertical" style={{ width: '100%' }}><Typography.Text type="secondary">快照代码仅供阅读，不在后台执行。</Typography.Text><Input.TextArea readOnly aria-label={`${item.label} CSS 快照`} value={item.value?.css || ''} placeholder="没有 CSS" autoSize={{ minRows: 3, maxRows: 12 }} /><Input.TextArea readOnly aria-label={`${item.label} JavaScript 快照`} value={item.value?.js || ''} placeholder="没有 JavaScript" autoSize={{ minRows: 3, maxRows: 12 }} /></Space> }))} /> : <Typography.Text type="secondary">此版本没有自定义代码</Typography.Text>}
    <Space wrap style={{ marginTop: 24 }}>{runtime.actor.role !== 'viewer' && <Button onClick={() => { setPageIds(pages.map(p => p.id)); setSharedBlockIds([]); setProductIds([]); setContentModelIds([]); setContentEntryIds([]); setIncludeLayout(false); setIncludeCatalog(false); setIncludeRedirects(false); setIncludeTemplates(false); setIncludeTheme(false);setIncludeSettings(false); setIncludeForms(false); setIncludeCode(false); setRestoreCheck(undefined);setRestoreError('');setRestoring(true); }}>找回内容并继续编辑</Button>}{runtime.actor.role === 'admin' && selected.status !== 'current' && <Button type="primary" onClick={() => activate(selected)}>切换公开版本</Button>}</Space></>}</Drawer>
    <Modal title={activation ? `切换公开网站到「${activation.title}」？` : undefined} open={!!activation} confirmLoading={activationBusy} okText={activationError?.conflict ? '读取最新版本' : '切换公开版本'} cancelText="取消" cancelButtonProps={{ disabled: activationBusy }} okButtonProps={{ disabled: !activationError?.conflict && runtime.saveState === 'error' }} onCancel={() => !activationBusy && setActivation(undefined)} onOk={activationError?.conflict ? readLatestActivation : confirmActivation}>
      {activationError ? <Alert showIcon type={activationError.conflict ? 'warning' : 'error'} title={activationError.conflict ? '本次切换已停止' : '暂未确认切换结果'} description={activationError.message} /> : <Typography.Paragraph>公开页面、产品、样式、同步区块、页眉页脚、自定义代码及栏目设置/记录会一起切换到此版本。当前草稿、账号和询盘保持不变。</Typography.Paragraph>}
    </Modal>
    <Modal title="找回内容并继续编辑" open={restoring} onCancel={()=>!busy&&setRestoring(false)} footer={<Space wrap><Button disabled={busy} onClick={()=>setRestoring(false)}>取消</Button><Button loading={busy} disabled={!hasRestoreSelection} onClick={checkRestore}>检查要找回的内容</Button><Button type="primary" loading={busy} disabled={!restoreChecked} onClick={restore}>确认找回所选内容</Button></Space>}>{restoreError&&<Alert type="error" title={restoreError} />}{restoreCheck&&<Alert type={restoreCheck.errors.length?'error':restoreChecked?'success':'warning'} title={restoreCheck.errors.length?'恢复依赖未通过':restoreChecked?'恢复预检通过':'范围或工作区已变化，请重新预检'} description={<>{restoreCheck.errors.map(e=><p key={e}>{e}</p>)}{restoreCheck.warnings.map(w=><p key={w}>{w}</p>)}{restoreCheck.summary&&<p>恢复后草稿：{restoreCheck.summary.totalPages}页、{restoreCheck.summary.totalProducts}产品、{restoreCheck.summary.totalEntries}内容记录；覆盖{restoreCheck.summary.objectIds.length}个选中对象和{restoreCheck.summary.fields.length}组全站定义。</p>}</>} />}<Alert type="warning" showIcon title="选中内容的当前草稿将被覆盖" description="同步区块恢复会影响所有引用它的草稿页面。恢复到草稿后可以继续编辑，确认发布才会更新网站。" /><Typography.Title level={5}>页面</Typography.Title><Space orientation="vertical">{pages.map(p => <Checkbox key={p.id} checked={pageIds.includes(p.id)} onChange={e => setPageIds(ids => e.target.checked ? [...ids,p.id] : ids.filter(id => id !== p.id))}>{p.title}</Checkbox>)}</Space><Divider /><Typography.Title level={5}>产品资料（包含扩展字段）</Typography.Title><Space orientation="vertical">{products.map(product => <Checkbox key={product.id} checked={productIds.includes(product.id)} onChange={event => setProductIds(ids => event.target.checked ? [...ids, product.id] : ids.filter(id => id !== product.id))}>{product.name}</Checkbox>)}</Space>
    <Divider /><Typography.Title level={5}>栏目设置</Typography.Title><Typography.Paragraph type="secondary">恢复结构仅限管理员。记录或绑定需要历史字段定义时，请同时恢复模型；不兼容的恢复会被阻止。</Typography.Paragraph><Space orientation="vertical">{models.map(model => <Checkbox key={model.id} disabled={runtime.actor.role !== 'admin'} checked={contentModelIds.includes(model.id)} onChange={event => setContentModelIds(ids => event.target.checked ? [...ids, model.id] : ids.filter(id => id !== model.id))}>{model.name}</Checkbox>)}</Space>
    <Divider /><Typography.Title level={5}>独立内容记录</Typography.Title><Space orientation="vertical">{entries.map(entry => <Checkbox key={entry.id} checked={contentEntryIds.includes(entry.id)} onChange={event => setContentEntryIds(ids => event.target.checked ? [...ids, entry.id] : ids.filter(id => id !== entry.id))}>{entry.title}</Checkbox>)}</Space>
    <Divider /><Typography.Title level={5}>同步区块</Typography.Title><Typography.Paragraph type="secondary">如恢复的页面依赖已删除区块，请一并选择所需区块及其嵌套依赖。</Typography.Paragraph><Space orientation="vertical">{sharedBlocks.length ? sharedBlocks.map(block => <Checkbox key={block.id} checked={sharedBlockIds.includes(block.id)} onChange={event => setSharedBlockIds(ids => event.target.checked ? [...ids, block.id] : ids.filter(id => id !== block.id))}>{block.name}</Checkbox>) : <Typography.Text type="secondary">此版本没有同步区块</Typography.Text>}</Space><Divider /><Space orientation="vertical"><Checkbox checked={includeTheme} onChange={event => setIncludeTheme(event.target.checked)}>恢复全站主题与复用样式</Checkbox><Checkbox checked={includeSettings} disabled={runtime.actor.role!=='admin'} onChange={e=>setIncludeSettings(e.target.checked)}>恢复公开网站资料及语言配置</Checkbox><Checkbox checked={includeTemplates} disabled={runtime.actor.role !== 'admin'} onChange={event => setIncludeTemplates(event.target.checked)}>恢复页面模板资源库及详情条件规则</Checkbox><Checkbox checked={includeForms} disabled={runtime.actor.role !== 'admin'} onChange={event => setIncludeForms(event.target.checked)}>恢复网站表单定义</Checkbox><Checkbox checked={includeRedirects} disabled={runtime.actor.role !== 'admin'} onChange={event => setIncludeRedirects(event.target.checked)}>恢复重定向规则</Checkbox><Checkbox checked={includeCatalog} disabled={runtime.actor.role !== 'admin'} onChange={event => setIncludeCatalog(event.target.checked)}>恢复分类/标签定义</Checkbox><Checkbox checked={includeLayout} onChange={event => setIncludeLayout(event.target.checked)}>恢复全站页眉页脚设置</Checkbox><Checkbox checked={includeCode} disabled={runtime.actor.role !== 'admin'} onChange={event => setIncludeCode(event.target.checked)}>恢复全部自定义代码（全站及各页面，仅管理员）</Checkbox></Space>{(includeLayout || includeCode) && <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>旧版本没有对应数据时，将恢复为默认布局或空代码。</Typography.Paragraph>}</Modal>
  </section>;
}
