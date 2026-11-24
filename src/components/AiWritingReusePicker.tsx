'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Form, List, Modal, Select, Space, Spin, Tabs, Typography } from 'antd';
import type { AiWritingReuseCandidate, AiWritingReuseResponse } from '@/lib/ai-writing-reuse-types';
import { request, useStudioRuntime } from '@/lib/studio-client';
const { Text } = Typography;

/** 候选只读获取，初始无勾选；用户明确加入后仍是待确认事实，不自动用于模型。 */
export default function AiWritingReusePicker({ open, onClose, onPick, initialSourceId, remaining = 30, actionLabel = '加入编辑区（待确认）' }: { open: boolean; onClose: () => void; onPick: (items: AiWritingReuseCandidate[]) => void | Promise<void>; initialSourceId?: string; remaining?: number; actionLabel?: string }) {
  const runtime = useStudioRuntime(), [tab, setTab] = useState('source'), [sourceId, setSourceId] = useState<string>(), [productId, setProductId] = useState<string>();
  const [data, setData] = useState<AiWritingReuseResponse>(), [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0);
  async function load(source?: string, product?: string) {
    const seq = ++sequence.current; setBusy(true); setError(''); setSelected([]);
    try { const query = source ? `?sourceId=${encodeURIComponent(source)}` : product ? `?productId=${encodeURIComponent(product)}` : ''; const next = await request<AiWritingReuseResponse>(`/api/ai/writing/reuse${query}`); if (seq === sequence.current) setData(next); }
    catch (cause) { if (seq === sequence.current) { setData(undefined); setError(cause instanceof Error ? cause.message : '资料读取失败'); } }
    finally { if (seq === sequence.current) setBusy(false); }
  }
  useEffect(() => { if (!open) return; setTab('source'); setSourceId(initialSourceId); setProductId(undefined); void load(initialSourceId); return () => { sequence.current++; }; }, [open, initialSourceId]);
  async function pick() {
    if (busy || saving || !data) return;
    setSaving(true); setError('');
    try { await onPick(data.candidates.filter(item => selected.includes(item.id))); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加入未完成，选择仍保留'); }
    finally { setSaving(false); }
  }
  return <Modal title="从已有资料选入" open={open} onCancel={() => { if (!saving) onClose(); }} width={900} zIndex={1350} style={{ maxWidth: 'calc(100vw - 32px)', top: 24 }} destroyOnHidden mask={{ closable: !saving }} closable={!saving} keyboard={!saving} footer={<Space wrap><Text type="secondary">已选{selected.length}项，最多可加入{remaining}项</Text><Button disabled={saving} onClick={onClose}>返回</Button><Button type="primary" loading={saving} disabled={busy || !selected.length || selected.length > remaining} onClick={() => void pick()}>{actionLabel}</Button></Space>}>
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Alert type="info" showIcon title="复用摘录，仍由你确认" description="这里只读取本人暂存来源或你选择的产品。加入后保持待确认，不调用模型；原文件提取结果到期后，仅保留已保存摘录。" />
      <Tabs activeKey={tab} onChange={key => { setTab(key); setSourceId(undefined); setProductId(undefined); void load(); }} items={[{ key: 'source', label: 'PDF / Excel整理结果' }, { key: 'product', label: '当前产品参数' }]} />
      <Form layout="vertical"><Form.Item label={tab === 'source' ? '选择来源资料' : '选择产品'}>{tab === 'source' ? <Select aria-label="复用来源资料" showSearch optionFilterProp="label" style={{ width: '100%' }} value={sourceId} disabled={busy || saving} placeholder="选择本人仍可回查的来源" options={data?.sources.map(item => ({ value: item.id, label: `${item.fileName} · ${item.kind.toUpperCase()}` }))} onChange={id => { setSourceId(id); void load(id); }} /> : <Select aria-label="复用产品参数" showSearch optionFilterProp="label" style={{ width: '100%' }} value={productId} disabled={busy || saving} placeholder="选择需要核对的产品" options={runtime.envelope.state.products.map(item => ({ value: item.id, label: `${item.name} · ${item.sku}` }))} onChange={id => { setProductId(id); void load(undefined, id); }} />}</Form.Item></Form>
      {error && <Alert type="error" showIcon title={error} />}
      {data?.warnings.map(warning => <Alert key={warning} type="warning" showIcon title={warning} />)}
      {busy ? <Spin /> : !data?.candidates.length ? <Empty description="选择来源或产品后，核对可复用的内容" /> : <Checkbox.Group value={selected} disabled={saving} onChange={ids => setSelected(ids as string[])} style={{ width: '100%' }}><List dataSource={data.candidates} renderItem={item => <List.Item><Checkbox value={item.id}><Space orientation="vertical" size={4}><Text strong>{item.label}</Text><Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.text}</Text><Text type="secondary" style={{ overflowWrap: 'anywhere' }}>{item.source}</Text>{item.sourceRef.quotes?.map((quote, index) => <Text key={index} type="secondary" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>原文第{quote.pageNumber}页：{quote.quote}</Text>)}<Text type="secondary">适用范围：{item.scope === 'company' ? '公司资料' : '仅该产品及明确选择它的文章'}</Text></Space></Checkbox></List.Item>} /></Checkbox.Group>}
    </Space>
  </Modal>;
}
