'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Collapse, Descriptions, Empty, Flex, List, Space, Spin, Tag, Typography } from 'antd';
import { EditOutlined, ReloadOutlined, UndoOutlined } from '@ant-design/icons';
import type { ScreenProps } from '@/lib/types';
import type { AiWritingValue } from '@/lib/ai-writing-types';
import type { ExternalAiWritingView } from '@/lib/external-ai-writing-types';
import { richTextPlainText } from '@/lib/presentation-content';
import { writingTextDifference } from '@/lib/ai-writing-difference';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { queueExternalContentEditor } from '@/lib/external-ai-review-client';
import { RichDocument } from '@/lib/presentation-components';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import './ai-content-writer.css';

const { Text, Paragraph, Title } = Typography;
const plain = (value: AiWritingValue) => typeof value === 'string' ? value : value ? richTextPlainText(value) : '';

/** 外部模型只交候选；此页使用本人会话、真实前后值和明确按钮完成草稿采用及安全撤销。 */
export default function ExternalContentReview({ navigate }: ScreenProps) {
  const runtime = useStudioRuntime(), { message } = App.useApp();
  const [proposal, setProposal] = useState<ExternalAiWritingView>(), [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const lock = useRef(false), readSequence = useRef(0), selectedProposal = useRef('');
  const admin = runtime.actor.role === 'admin';
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope: 'external-content-review', screen: 'ai-content-review', title: '外部AI内容审核', dirty: false, busy: !!busy, snapshot: null, discard: () => undefined });
  function choose(value: ExternalAiWritingView) {
    setProposal(value);
    if (selectedProposal.current !== value.id) { selectedProposal.current = value.id; setSelected(value.fields.map(field => field.key)); }
    else setSelected(current => current.filter(key => value.fields.some(field => field.key === key)));
  }
  async function read(id: string) {
    if (!/^eaw-[a-f0-9-]{36}$/.test(id)) throw new Error('审核地址不正确，请让外部AI重新提供内容审核入口。');
    return request<ExternalAiWritingView>(`/api/external-ai/content/${encodeURIComponent(id)}`);
  }
  useEffect(() => {
    const load = () => {
      const id = new URL(location.href).searchParams.get('externalContent');
      const sequence = ++readSequence.current;
      if (!admin || !id) { setProposal(undefined); setBusy(''); return; }
      setBusy('读取内容建议'); setError(''); setSuccess('');
      void read(id).then(value => { if (sequence === readSequence.current) choose(value); }).catch(cause => { if (sequence === readSequence.current) { setProposal(undefined); setError(cause instanceof Error ? cause.message : '读取内容建议失败。'); } }).finally(() => { if (sequence === readSequence.current) setBusy(''); });
    };
    load(); window.addEventListener('popstate', load); window.addEventListener('hashchange', load);
    return () => { readSequence.current++; window.removeEventListener('popstate', load); window.removeEventListener('hashchange', load); };
  }, [admin]);
  async function run(name: string, work: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(name); setError(''); setSuccess('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，建议仍保留。'); } finally { lock.current = false; setBusy(''); }
  }
  async function refresh() {
    const id = proposal?.id || new URL(location.href).searchParams.get('externalContent');
    if (!id) return;
    await run('读取最新状态', async () => { await runtime.refresh(); choose(await read(id)); });
  }
  async function act(action: 'apply' | 'undo') {
    if (!proposal) return;
    await run(action === 'apply' ? '保存内容草稿' : '撤销内容修改', async () => {
      await runtime.flush();
      let saved: ExternalAiWritingView | undefined;
      await runtime.mutate(async envelope => {
        const value = await request<StudioEnvelope & { externalContent: ExternalAiWritingView }>(`/api/external-ai/content/${encodeURIComponent(proposal.id)}/${action}`, { method: 'POST', body: JSON.stringify({ expectedRevision: envelope.revision, ...(action === 'apply' ? { selectedKeys: selected } : {}) }) });
        saved = value.externalContent; return value;
      });
      choose(saved || await read(proposal.id));
      const text = action === 'apply' ? '已保存为草稿，可以继续自由编辑；发布仍需另行确认。' : '本次内容修改已撤销，其他资料和公开网站保持。';
      setSuccess(text); message.success(text);
    });
  }
  function openEditor() {
    if (!proposal || proposal.status !== 'applied' || busy) return;
    try { queueExternalContentEditor(runtime.actor.id, proposal.target); navigate(proposal.target.kind === 'product' ? 'products' : 'content-models'); }
    catch { setError('浏览器未能保存编辑入口，请到产品管理或内容管理按名称打开；草稿已保留。'); }
  }
  const differences = useMemo(() => new Map(proposal?.fields.map(field => [field.key, writingTextDifference(plain(field.before), plain(field.after))]) || []), [proposal]);
  const renderValue = (value: AiWritingValue) => typeof value === 'string' || value === null ? <div className="ai-writing-plain">{value || <Text type="secondary">未填写</Text>}</div> : <div className="ai-writing-rich"><RichDocument doc={value} media={runtime.envelope.state.media} derived={false} /></div>;
  const expired = !!proposal && Date.parse(proposal.expiresAt) <= Date.now(), pending = proposal?.status === 'pending';
  const requiredKeys = proposal?.isNew && proposal.target.kind === 'entry' ? ['title'] : [];
  // 新文章的空创建种子不含展示资料；只有真实填写的基础值才显示卡片。
  const creationDetails = Object.entries(proposal?.creation || {}).filter(([, value]) => typeof value === 'string' && !!value.trim());
  if (!admin) return <Alert type="info" showIcon title="请使用创建这份建议的管理员账号审核" />;
  return <section className="sys-screen external-content-review">{guard.dialog}
    <Flex className="sys-heading" justify="space-between" align="flex-end" gap={16} wrap><div><Text className="sys-eyebrow">外部AI建议</Text><Title level={2}>核对内容，再保存</Title><Paragraph>文章排版、产品介绍和搜索文案都可以逐项核对，确认后继续在原编辑器修改。</Paragraph></div><Button icon={<ReloadOutlined aria-hidden="true" />} disabled={!!busy} loading={busy === '读取最新状态'} onClick={() => void refresh()}>读取最新状态</Button></Flex>
    <Space orientation="vertical" size={20} style={{ width: '100%', minWidth: 0 }}>
      {error && <Alert type="error" showIcon title="操作未完成" description={error} />}
      {success && <Alert type="success" showIcon title={success} />}
      {!proposal ? busy ? <Spin tip="正在读取本人内容建议"><div style={{ minHeight: 160 }} /></Spin> : <Empty description={error ? '当前建议无法读取，请检查账号和审核地址。' : '从外部AI返回的审核地址打开一份内容建议。'} /> : <>
        <Card size="small"><Flex justify="space-between" align="center" gap={16} wrap><Space orientation="vertical" size={6}><Space wrap><Text strong>{proposal.recordLabel}</Text><Tag>{proposal.isNew ? '新建草稿' : '调整现有内容'}</Tag><Tag color={proposal.status === 'applied' ? 'green' : proposal.status === 'undone' ? undefined : 'blue'}>{proposal.status === 'applied' ? '已保存' : proposal.status === 'undone' ? '已撤销' : '待确认'}</Tag></Space><Text type="secondary">有效至{new Date(proposal.expiresAt).toLocaleString()} · 查看和采用不调用站内AI服务</Text></Space><Space wrap>{proposal.status === 'applied' && <><Button icon={<EditOutlined aria-hidden="true" />} disabled={!!busy} onClick={openEditor}>继续自由编辑</Button><Button icon={<UndoOutlined aria-hidden="true" />} disabled={!!busy || expired || proposal.canUndo === false} loading={busy === '撤销内容修改'} onClick={() => void act('undo')}>撤销本次内容修改</Button></>}{pending && <Button type="primary" disabled={!!busy || expired || proposal.stale || !selected.length} loading={busy === '保存内容草稿'} onClick={() => void act('apply')}>确认保存选中内容到草稿</Button>}</Space></Flex></Card>
        {proposal.status === 'applied' && proposal.canUndo === false && proposal.undoReason && <Alert type="info" showIcon title="当前不能自动撤销" description={proposal.undoReason} />}
        {!pending && <Alert type="info" showIcon title="这里保留本次候选与原文的对照" description="标签标明本次实际采用的字段；没有选择的建议不会保存。当前草稿可能已有后续编辑，请到原编辑器核对。" />}
        {proposal.isNew && !!creationDetails.length && <Card size="small" title="本次新建的基础资料"><Descriptions size="small" column={{ xs: 1, sm: 2 }} items={creationDetails.map(([key, value]) => ({ key, label: ({ name: '产品名称', title: '内容标题', sku: '型号', category: '分类', material: '材质', slug: '网址名称', locale: '语言', modelId: '所属栏目' } as Record<string, string>)[key] || key, children: String(value) }))} /></Card>}
        {proposal.stale && pending && <Alert type="warning" showIcon title="原资料或写作依据已有变化" description="这份候选仍保留，暂时不能采用。请让外部AI读取最新上下文并重新准备，避免覆盖后续修改。" />}
        {expired && <Alert type="warning" showIcon title="这份内容建议或撤销期限已过" description="请让外部AI读取最新资料，重新准备候选。" />}
        {proposal.warnings.map((warning, index) => <Alert key={index} type="warning" showIcon title={warning} />)}
        {!!proposal.missingFacts.length && <Card size="small" title="发布前需要补充或核对"><List size="small" dataSource={proposal.missingFacts} renderItem={item => <List.Item>{item}</List.Item>} /></Card>}
        <Flex gap={12} justify="space-between" align="center" wrap><Text strong>前后对比 · {proposal.fields.length}项内容</Text>{pending && <Checkbox checked={selected.length === proposal.fields.length} indeterminate={!!selected.length && selected.length < proposal.fields.length} disabled={!!busy || expired || proposal.stale} onChange={event => setSelected(event.target.checked ? proposal.fields.map(field => field.key) : requiredKeys.filter(key => proposal.fields.some(field => field.key === key)))}>全选内容（{selected.length}/{proposal.fields.length}）</Checkbox>}</Flex>
        {proposal.fields.map(field => { const difference = differences.get(field.key); return <Card size="small" key={field.key} title={pending ? <Checkbox checked={selected.includes(field.key)} disabled={!!busy || expired || proposal.stale || requiredKeys.includes(field.key)} onChange={event => setSelected(current => event.target.checked ? [...current, field.key] : current.filter(key => key !== field.key))}>{field.label}{requiredKeys.includes(field.key) ? '（新建必需）' : ''}</Checkbox> : <Space wrap>{field.label}<Tag color={proposal.appliedKeys?.includes(field.key) && proposal.status === 'applied' ? 'green' : undefined}>{!proposal.appliedKeys ? '候选内容，以保存回执为准' : proposal.appliedKeys.includes(field.key) ? proposal.status === 'undone' ? '本次采用已撤销' : '本次已采用' : '本次未采用'}</Tag></Space>}>
          <Space orientation="vertical" size={16} style={{ width: '100%', minWidth: 0 }}><div className="ai-writing-compare-grid"><div><Text type="secondary">{proposal.isNew ? '新建前（尚无内容）' : '修改前'}</Text>{renderValue(field.before)}</div><div><Text strong>建议内容与排版</Text>{renderValue(field.after)}</div></div>{difference?.changed && <Collapse size="small" items={[{ key: 'diff', label: '查看文字增删', children: <><Space wrap style={{ marginBottom: 12 }}><Text className="ai-writing-added-label">新增文字</Text><Text className="ai-writing-removed-label">删除文字</Text></Space><div className="ai-writing-difference" tabIndex={0} aria-label={`${field.label}文字增删对照`}>{difference.parts.map((part, index) => part.kind === 'added' ? <ins key={index}>{part.text}</ins> : part.kind === 'removed' ? <del key={index}>{part.text}</del> : <span key={index}>{part.text}</span>)}</div></> }]} />}</Space>
        </Card>; })}
        {!!proposal.evidence.length && <Collapse items={[{ key: 'facts', label: `本次参考的${proposal.evidence.length}项已确认资料`, children: <List size="small" dataSource={proposal.evidence} renderItem={fact => <List.Item><List.Item.Meta title={fact.label} description={`${fact.text} · 来源：${fact.source || '人工填写'}`} /></List.Item>} /> }]} />}
        <Alert type="info" showIcon title="需要继续调整？把具体反馈告诉外部AI" description="例如：保留已认可的标题，只缩短第二段并补上采购流程。让AI基于本次候选继续准备，新版本仍需在这里核对确认。网站图片、参数、正文和排版可在原编辑器继续修改。" />
      </>}
    </Space>
  </section>;
}
