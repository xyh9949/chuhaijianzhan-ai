'use client';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import { readLocalRecovery,clearLocalRecovery } from '@/lib/local-recovery';
import { useState } from 'react';
import { Alert, App, Button, Descriptions, Flex, Form, Modal, Select, Space, Table, Tag, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { IMPORT_MAX_BYTES, parseImportFile, type ContentImportSpec, type ImportPreview } from '@/lib/content-import';
import { csvDocument } from '@/lib/form-content';
import { request, RequestError, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';

const labels: Record<string, string> = { key: '导入编号（防止重复）', name: '产品名称（必须对应）', sku: '型号SKU（必映射）', category: '旧分类文字', image: '封面图片地址', images:'产品图片地址列表（首张封面）', description: '介绍', material: '材质', title: '内容标题（必映射）', slug: '短路径', seoTitle: 'SEO标题', seoDescription: 'SEO描述', sortOrder: '排序' };
/** 文件只在当前浏览器会话内预览；服务器签名绑定文件/映射/版本，点击确认后才原子新增草稿。 */
export default function ContentImportDialog({ target = 'product', modelId: initialModelId }: { target?: 'product' | 'entry'; modelId?: string }) {
  const runtime = useStudioRuntime(), { message } = App.useApp();
  const scope=`content-import:${target}`;
  type Recovery={target:string;format:ContentImportSpec['format'];content:string;filename:string;modelId:string;mapping:Record<string,string>};
  const [recovered]=useState(()=>readLocalRecovery<Recovery>(runtime.actor.id,scope,value=>{const v=value as Recovery;if(!v||v.target!==target||!['csv','json'].includes(v.format)||typeof v.content!=='string'||v.content.length>IMPORT_MAX_BYTES||typeof v.filename!=='string'||typeof v.modelId!=='string'||!v.mapping||typeof v.mapping!=='object'||Array.isArray(v.mapping)||Object.keys(v.mapping).length>110||Object.values(v.mapping).some(x=>typeof x!=='string'||x.length>130))return false;try{parseImportFile(v.format,v.content,target);return true;}catch{return false;}}));
  const [open,setOpen]=useState(!!recovered),[format,setFormat]=useState<ContentImportSpec['format']>(recovered?.snapshot.format||'csv'),[content,setContent]=useState(recovered?.snapshot.content||''),[filename,setFilename]=useState(recovered?.snapshot.filename||'');
  const [modelId,setModelId]=useState(recovered?.snapshot.modelId||initialModelId||''),[mapping,setMapping]=useState<Record<string,string>>(recovered?.snapshot.mapping||{}),[headers,setHeaders]=useState<string[]>(()=>recovered?parseImportFile(recovered.snapshot.format,recovered.snapshot.content,target).headers:[]);
  const [plan, setPlan] = useState<ImportPreview>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const models = (runtime.envelope.state.contentModels || []).filter(m => m.target === (target === 'entry' ? 'content' : 'product')), model = models.find(m => m.id === modelId);
  const builtins = target === 'product' ? ['key', 'name', 'sku', 'category', 'image', 'images', 'description', 'material', 'slug', 'seoTitle', 'seoDescription', 'sortOrder'] : ['key', 'title', 'slug', 'seoTitle', 'seoDescription', 'sortOrder'];
  const options = [{ value: '', label: '忽略此列' }, ...builtins.map(k => ({ value: `builtin:${k}`, label: labels[k] + (target === 'entry' && k === 'key' ? '（必映射）' : '') })), ...(model?.fields.map(f => ({ value: `field:${f.id}`, label: `${f.label} · ${f.type}` })) || [])];
  function suggest(columns: string[], nextModel = model) { return Object.fromEntries(columns.map(h => { const builtin = builtins.find(k => k.toLowerCase() === h.toLowerCase()), field = nextModel?.fields.find(f => f.key === h); return [h, builtin ? `builtin:${builtin}` : field ? `field:${field.id}` : '']; })); }
  async function load(file: File) {
    setPlan(undefined); setError('');
    try { if (file.size > IMPORT_MAX_BYTES) throw new Error('文件最多2 MB，请分批导入'); const nextFormat = /\.csv$/i.test(file.name) ? 'csv' : /\.json$/i.test(file.name) ? 'json' : undefined; if (!nextFormat) throw new Error('请选择.csv或.json文件'); const next = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()), parsed = parseImportFile(nextFormat, next, target); setFormat(nextFormat); setContent(next); setFilename(file.name); setHeaders(parsed.headers); setMapping(suggest(parsed.headers)); }
    catch (e) { setError(`新文件未载入，原文件和映射仍保留：${(e as Error).message}`); }
    return Upload.LIST_IGNORE;
  }
  async function preview() {
    setBusy(true); setError(''); setPlan(undefined);
    try { await runtime.flush(); const env = runtime.getEnvelope(); setPlan(await request<ImportPreview>('/api/content-import/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: env.revision, format, content, target, modelId, mapping }) })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function commit() {
    if (!plan?.confirmation) return;
    setBusy(true); setError('');
    try { await runtime.mutate(env => { if (env.revision !== plan.revision) throw new RequestError(409, '工作区已变化，请重新预检；文件和映射仍保留'); return request<StudioEnvelope>('/api/content-import/commit', { method: 'POST', body: JSON.stringify({ expectedRevision: plan.revision, format, content, target, modelId, mapping, confirmation: plan.confirmation }) }); }); clearLocalRecovery(runtime.actor.id,scope);message.success(`已新增${plan.rowCount}条草稿，尚未发布`); setOpen(false); setContent(''); setHeaders([]); setPlan(undefined); setFilename(''); }
    catch (e) { setError((e as Error).message); setPlan(undefined); } finally { setBusy(false); }
  }
  function reset(){setContent('');setHeaders([]);setMapping({});setPlan(undefined);setFilename('');setError('');}
  const guard=useLocalDraftGuard({actorId:runtime.actor.id,scope,screen:target==='entry'?'content-models':'products',title:target==='entry'?'内容导入文件与映射':'产品导入文件与映射',dirty:open&&!!content,busy,snapshot:{target,format,content,filename,modelId,mapping},discard:reset});
  function sample(nextFormat: 'csv' | 'json') {
    const row = target === 'product' ? { key: 'demo-product-001', name: 'Demonstration product', sku: 'DEMO-001', category: 'Demonstration', description: 'Synthetic sample; replace with verified product information.', image: '' } : { key: 'demo-record-001', title: 'Demonstration record', slug: 'demo-record-001' };
    const data = nextFormat === 'csv' ? csvDocument([Object.keys(row), Object.values(row)]) : JSON.stringify({ schemaVersion: 1, kind: target, rows: [row] }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: nextFormat === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' })), link = document.createElement('a'); link.href = url; link.download = `content-import-example.${nextFormat}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <>{guard.dialog}<Button icon={<UploadOutlined />} disabled={runtime.actor.role === 'viewer'} onClick={() => { if (!content) setModelId(initialModelId || ''); setOpen(true); }}>批量导入{target === 'product' ? '产品' : '内容'}</Button>
    <Modal open={open} title={`批量导入${target === 'product' ? '产品' : '独立内容'}草稿`} width={960} onCancel={()=>guard.ask(()=>setOpen(false))} footer={<Space><Button disabled={busy} onClick={()=>guard.ask(()=>setOpen(false))}>关闭</Button><Button loading={busy} disabled={!content || target === 'entry' && !modelId} onClick={preview}>预检全部记录</Button><Button type="primary" loading={busy} disabled={!plan?.confirmation || !!plan?.errors.length} onClick={commit}>{plan ? `确认新增${plan.rowCount}条草稿` : '确认新增草稿'}</Button></Space>}>
      <Space orientation="vertical" style={{ width: '100%' }}>{recovered&&<Alert type="warning" title="已恢复本账号的文件与映射，需重新预检；不会自动导入" />}<Alert type="info" showIcon title="先映射和预检，再整批新增；不覆盖已有数据" description="UTF-8编码，CSV逗号分隔、双引号转义；日期YYYY-MM-DD，布尔true/false，多个值使用JSON文本数组。每次最多500行/2 MB，整体草稿仍受4 MB限制。只新增，不自动发布或下载远程图片。" />
      {error && <Alert type="error" showIcon title={error} />}
      <Flex gap={8} wrap><Upload accept=".csv,.json" showUploadList={false} beforeUpload={load} disabled={busy}><Button icon={<UploadOutlined />}>选择CSV / JSON文件</Button></Upload><Button onClick={() => sample('csv')}>下载CSV样例</Button><Button onClick={() => sample('json')}>下载JSON样例</Button>{filename && <Tag>{filename}</Tag>}</Flex>
      <Form layout="vertical"><Form.Item label={target === 'entry' ? '资料栏目（必选）' : '产品扩展模型（可不选）'}><Select aria-label="导入资料栏目" value={modelId || undefined} allowClear={target === 'product'} placeholder="选择已有模型" options={models.map(m => ({ value: m.id, label: m.name }))} onChange={id => { setModelId(id || ''); setMapping(suggest(headers, models.find(m => m.id === id))); setPlan(undefined); }} /></Form.Item></Form>
      {!!headers.length && <Table size="small" rowKey="source" pagination={false} scroll={{ y: 240 }} dataSource={headers.map(source => ({ source }))} columns={[{ title: '文件中的列', dataIndex: 'source' }, { title: '写入字段', render: (_, r) => <Select aria-label={`导入列${r.source}`} style={{ width: '100%', minWidth: 200 }} value={mapping[r.source] || ''} options={options} onChange={v => { setMapping(p => ({ ...p, [r.source]: v })); setPlan(undefined); }} /> }]} />}
      {plan && <><Alert type={plan.errors.length ? 'error' : 'success'} showIcon title={plan.errors.length ? `${plan.errors.length}处错误，尚未写入` : `预检通过，共${plan.rowCount}条；5分钟内确认`} description={<>{plan.warnings.map(w => <p key={w}>{w}</p>)}</>} />
      {!!plan.errors.length && <Table rowKey={(_, i) => String(i)} size="small" scroll={{ y: 200 }} pagination={{ pageSize: 10 }} dataSource={plan.errors} columns={[{ title: '行', dataIndex: 'row' }, { title: '字段', dataIndex: 'field' }, { title: '问题', dataIndex: 'message' }]} />}
      <Table rowKey="row" size="small" scroll={{ x: 760, y: 260 }} pagination={{ pageSize: 10 }} dataSource={plan.rows} columns={[{ title: '行', dataIndex: 'row', width: 50 }, { title: '导入key', dataIndex: 'key' }, { title: '名称/标题', dataIndex: 'title' }, { title: 'SKU', dataIndex: 'sku' }, { title: '短路径', dataIndex: 'slug' }]} expandable={{ expandedRowRender: r => <Descriptions column={1} size="small" items={Object.entries(r.values).map(([key, value]) => ({ key, label: options.find(o => o.value === `field:${key}` || o.value === `builtin:${key}`)?.label || key, children: <Typography.Text>{JSON.stringify(value)}</Typography.Text> }))} /> }} /></>}
      </Space>
    </Modal></>;
}
