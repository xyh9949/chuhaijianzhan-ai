'use client';
import { useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Modal, Select, Space, Table, Typography } from 'antd';
import type { Taxonomy, TaxonomyTerm } from '@/lib/types';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';

/** 分类定义仅管理员维护；显式预览旧category迁移，保留原文字和已有分类ID。 */
export default function CatalogManager({source,modelId}:{source?:Taxonomy['source'];modelId?:string}={}) {
  const runtime = useStudioRuntime(), { message, modal } = App.useApp(), state = runtime.envelope.state;
  const readonly = runtime.actor.role !== 'admin';
  const [draft, setDraft] = useState<Taxonomy | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  // 栏目只管理内容分类，产品入口只管理产品分类；共享分类仍保留原ID与引用。
  const catalog = (state.taxonomies || []).filter(t=>(!source||t.source===source)&&(!modelId||!t.modelId||t.modelId===modelId));
  async function save(next: Taxonomy) {
    setBusy(true); try { await runtime.mutate(env => request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { taxonomies: [...(env.state.taxonomies || []).filter(item => item.id !== next.id), next] } }) })); setDraft(null); message.success('分类定义已保存为草稿'); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function migrate() {
    const categories = [...new Set(state.products.map(item => item.category).filter(Boolean))];
    modal.confirm({ title: '把原产品分类映射到稳定ID？', content: <div><p>将创建一个产品分类分组，关联当前 {state.products.length} 件产品，保留原category文字，不会自动发布。</p><Space wrap>{categories.map(value => <Typography.Text code key={value}>{value}</Typography.Text>)}</Space></div>, okText: '确认迁移到草稿', onOk: async () => {
      await runtime.mutate(env => {
        const categories = [...new Set(env.state.products.map(item => item.category).filter(Boolean))];
        const terms = categories.map((label, index) => ({ id: `term-${crypto.randomUUID()}`, label, slug: `category-${index + 1}` }));
        const taxonomy: Taxonomy = { id: `taxonomy-${crypto.randomUUID()}`, name: '产品分类', source: 'product', terms };
        return request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { taxonomies: [...(env.state.taxonomies || []), taxonomy], products: env.state.products.map(item => ({ ...item, termIds: [...(item.termIds || []), ...terms.filter(term => term.label === item.category).map(term => term.id)] })) } }) });
      }); message.success('已映射为草稿，请明确选择分类定义及产品发布');
    } });
  }
  const termPatch = (index: number, patch: Partial<TaxonomyTerm>) => draft && setDraft({ ...draft, terms: draft.terms.map((item, i) => i === index ? { ...item, ...patch } : item) });
  return <Card title="分类与标签" extra={<Space wrap>{source!=='entry'&&<Button disabled={readonly} onClick={migrate}>迁移原产品分类</Button>}<Button type="primary" disabled={readonly} onClick={() => { setDraft({ id: `taxonomy-${crypto.randomUUID()}`, name: '', source:source||'product', modelId, terms: [] }); setError(''); }}>新建分类分组</Button></Space>}>
    <Typography.Paragraph type="secondary">用分类和标签整理产品、案例等内容，也可以用于页面上的筛选和菜单。</Typography.Paragraph>
    <Table rowKey="id" scroll={{ x: 650 }} dataSource={catalog} columns={[{ title: '名称', dataIndex: 'name' }, { title: '来源', dataIndex: 'source', render: value => value === 'product' ? '产品' : '独立内容' }, { title: '项目', render: (_, tax) => tax.terms.length }, { title: '操作', render: (_, tax) => <Space><Button onClick={() => { setDraft(structuredClone(tax)); setError(''); }}>编辑</Button><Button danger disabled={readonly} onClick={() => modal.confirm({ title: '删除分类分组？', content: '仍被内容或查询引用时会阻止删除。', onOk: async () => { try { await runtime.mutate(env => request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { taxonomies: (env.state.taxonomies || []).filter(item => item.id !== tax.id) } }) })); } catch (e) { message.error((e as Error).message); } } })}>删除</Button></Space> }]} />
    <Modal open={!!draft} title="编辑分类分组" width={900} onCancel={() => setDraft(null)} okText="保存分类" confirmLoading={busy} okButtonProps={{ disabled: readonly }} onOk={() => draft && save(draft)}>
      {draft && <Form layout="vertical" disabled={readonly || busy}>{error && <Alert type="error" title={error} />}<Form.Item label="名称"><Input aria-label="分类分组名称" maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Form.Item><Space align="start"><Form.Item label="内容来源"><Select aria-label="分类内容来源" style={{ width: 180 }} disabled={!!source||catalog.some(item => item.id === draft.id)} value={draft.source} options={[{ value: 'product', label: '产品' }, { value: 'entry', label: '独立内容' }]} onChange={source => setDraft({ ...draft, source, modelId: undefined })} /></Form.Item><Form.Item label="只用于某个栏目（选填）"><Select aria-label="分类限定模型" style={{ width: 240 }} allowClear={!modelId} disabled={!!modelId} value={draft.modelId} options={(state.contentModels || []).filter(model => model.target === (draft.source === 'product' ? 'product' : 'content')).map(model => ({ value: model.id, label: model.name }))} onChange={modelId => setDraft({ ...draft, modelId })} /></Form.Item></Space>
        {draft.terms.map((term, index) => <div key={term.id} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}><Input aria-label={`分类名称 ${index + 1}`} style={{ flex: '1 1 160px' }} maxLength={120} value={term.label} placeholder="名称" onChange={e => termPatch(index, { label: e.target.value })} /><Input aria-label={`分类短路径 ${index + 1}`} style={{ flex: '1 1 150px' }} maxLength={100} value={term.slug} placeholder="网址中的名称，如 cabinets" onChange={e => termPatch(index, { slug: e.target.value })} /><Select aria-label={`父分类 ${index + 1}`} style={{ flex: '1 1 170px' }} allowClear placeholder="无父项" value={term.parentId} options={draft.terms.filter(item => item.id !== term.id).map(item => ({ value: item.id, label: item.label || item.id }))} onChange={parentId => termPatch(index, { parentId })} /><Button danger onClick={() => setDraft({ ...draft, terms: draft.terms.filter((_, i) => i !== index) })}>移除</Button></div>)}
        <Button disabled={draft.terms.length >= 500} onClick={() => setDraft({ ...draft, terms: [...draft.terms, { id: `term-${crypto.randomUUID()}`, label: '', slug: '' }] })}>添加分类项目</Button>
      </Form>}
    </Modal>
  </Card>;
}
