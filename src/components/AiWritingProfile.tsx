'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Collapse, Flex, Form, Input, Select, Space, Spin, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import type { AiWritingFact, AiWritingProfile, AiWritingProfileInput } from '@/lib/ai-writing-types';
import { request, useStudioRuntime } from '@/lib/studio-client';
import { readLocalRecovery } from '@/lib/local-recovery';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import AiWritingReusePicker from './AiWritingReusePicker';
import type { AiWritingReuseCandidate, AiWritingReuseResponse, AiWritingSourceState } from '@/lib/ai-writing-reuse-types';
import './ai-content-writer.css';

const { Paragraph, Text } = Typography;
const empty = (): AiWritingProfileInput => ({ expectedRevision: 0, brandName: '', audience: '', market: '', tone: '', terminology: '', avoidedClaims: '', facts: [] });
const inputOf = (profile: AiWritingProfile): AiWritingProfileInput => ({ expectedRevision: profile.revision, brandName: profile.brandName, audience: profile.audience, market: profile.market, tone: profile.tone, terminology: profile.terminology, avoidedClaims: profile.avoidedClaims, facts: structuredClone(profile.facts) });
function validDraft(value: unknown): value is AiWritingProfileInput {
  if (!value || typeof value !== 'object') return false;
  const item = value as AiWritingProfileInput;
  return Number.isSafeInteger(item.expectedRevision) && item.expectedRevision >= 0 && ['brandName', 'audience', 'market', 'tone', 'terminology', 'avoidedClaims'].every(key => typeof item[key as keyof AiWritingProfileInput] === 'string' && (item[key as keyof AiWritingProfileInput] as string).length <= 6000) && Array.isArray(item.facts) && item.facts.length <= 30 && item.facts.every(fact => fact && typeof fact.id === 'string' && typeof fact.label === 'string' && typeof fact.text === 'string' && typeof fact.source === 'string' && typeof fact.confirmed === 'boolean' && ['company', 'product'].includes(fact.scope));
}

/** 写作依据独立于模型密钥；只有人工确认且被本次写作选中的事实才供生成使用。 */
export default function AiWritingProfile() {
  const runtime = useStudioRuntime(), { message } = App.useApp(), admin = runtime.actor.role === 'admin';
  const [recovered] = useState(() => readLocalRecovery<AiWritingProfileInput>(runtime.actor.id, 'ai-writing-profile', validDraft));
  const [draft, setDraft] = useState<AiWritingProfileInput>(recovered?.snapshot || empty()), [saved, setSaved] = useState<AiWritingProfile>();
  const [busy, setBusy] = useState<'load' | 'save' | 'reload' | ''>('load'), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const [reuseOpen, setReuseOpen] = useState(false), [sourceStates, setSourceStates] = useState<Record<string, AiWritingSourceState>>({});
  const lock = useRef(false), live = useRef(false), operation = useRef(0), draftRef = useRef(draft); draftRef.current = draft;
  const dirty = !!saved && JSON.stringify(draft) !== JSON.stringify(inputOf(saved));
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope: 'ai-writing-profile', screen: 'settings', title: '企业写作资料', dirty: admin && dirty, busy: !!busy, snapshot: draft, discard: () => setDraft(saved ? inputOf(saved) : empty()), save: save });
  async function load(preserve = false) {
    if (lock.current || !admin) return; lock.current = true; const read = ++operation.current; setBusy(preserve ? 'reload' : 'load'); setError(''); setSuccess('');
    // 首次失败后的空值只是占位，重读须填回真实资料；仅保留已加载表单或确有恢复稿的输入。
    const preserveInput = preserve && !!(saved || recovered);
    try { const value = await request<AiWritingProfile>('/api/ai/writing/profile'); if (!live.current || read !== operation.current) return; setSaved(value); if (preserveInput) { setDraft(current => ({ ...current, expectedRevision: value.revision })); setSuccess('已读取最新版本，当前输入仍保留；请核对已保存资料后再保存。'); } else if (!recovered) { setDraft(inputOf(value)); if (preserve) setSuccess('已读取保存的写作资料，尚未作任何修改。'); } void readSourceStates(); }
    catch (cause) { if (live.current && read === operation.current) setError(cause instanceof Error ? cause.message : '写作资料读取失败，当前输入仍保留。'); }
    finally { if (live.current && read === operation.current) { lock.current = false; setBusy(''); } }
  }
  useEffect(() => { live.current = true; if (admin) void load(); else setBusy(''); return () => { live.current = false; operation.current++; lock.current = false; }; }, [admin]);
  function change(patch: Partial<AiWritingProfileInput>) { setDraft(current => ({ ...current, ...patch })); setSuccess(''); }
  function changeFact(id: string, patch: Partial<AiWritingFact>) {
    // 已确认内容变更后重新核对；旧的确认不能自动转用于新事实或另一产品。
    const requiresReview = ['text', 'source', 'scope', 'productId'].some(key => Object.hasOwn(patch, key));
    setDraft(current => ({ ...current, facts: current.facts.map(fact => fact.id === id ? { ...fact, ...patch, ...(['text', 'scope', 'productId'].some(key => Object.hasOwn(patch, key)) ? { sourceRef: undefined } : {}), ...(requiresReview ? { confirmed: false } : {}) } : fact) })); setSuccess('');
  }
  async function readSourceStates() { try { const result = await request<AiWritingReuseResponse>('/api/ai/writing/reuse'); if (live.current) setSourceStates(result.states); } catch { if (live.current) setSourceStates({}); } }
  function addReused(items: AiWritingReuseCandidate[]) {
    const current = draftRef.current, additions = items.filter(item => !current.facts.some(fact => fact.sourceRef?.fingerprint === item.sourceRef.fingerprint));
    if (current.facts.length + additions.length > 30) throw new Error('最多保留30项资料，请减少选择或先移除不需要的资料。');
    // 复用只带入待确认摘录；必须保存并由企业核对后，写作时才能明确选用。
    change({ facts: [...current.facts, ...additions.map(item => ({ id: `fact-${crypto.randomUUID()}`, label: item.label, text: item.text, source: item.source, scope: item.scope, productId: item.productId, sourceRef: item.sourceRef, confirmed: false }))] });
    setSuccess(additions.length ? `已加入${additions.length}项待确认资料，请核对适用范围后保存。` : '所选摘录已在当前资料中，没有重复加入。');
  }
  async function save(): Promise<boolean> {
    if (lock.current || !saved || !admin) return false;
    const value = draftRef.current;
    if (value.facts.some(fact => !fact.label.trim() || !fact.text.trim() || !fact.source.trim() || fact.scope === 'product' && !fact.productId)) { setError('请为每项资料填写名称、事实内容、来源，并为产品资料选择适用产品。'); return false; }
    lock.current = true; setBusy('save'); setError(''); setSuccess('');
    try {
      const next = await request<AiWritingProfile>('/api/ai/writing/profile', { method: 'PATCH', body: JSON.stringify(value) });
      if (!live.current) return false;
      setSaved(next); setDraft(inputOf(next)); guard.clear(); setSuccess('企业写作资料已保存；尚未调用AI，也不会修改网站内容。');
      window.dispatchEvent(new Event('form-studio:ai-writing-profile-saved')); return true;
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : '保存未完成，当前输入仍保留。'); return false; }
    finally { if (live.current) { lock.current = false; setBusy(''); } }
  }
  if (!admin) return <Alert type="info" showIcon title="企业写作资料由管理员维护" />;
  return <>{guard.dialog}<Card title="企业写作资料" className="ai-writing-profile" style={{ maxWidth: 960 }} styles={{ body: { padding: 'var(--admin-panel-space,24px)' } }}>
    <Space orientation="vertical" size={20} style={{ width: '100%' }}>
      <Alert type="info" showIcon title="让内容来自自己的企业资料" description="写作时选择需要的资料，产品与文章使用一致的品牌表达。事实和写作偏好分开；没有依据的认证、价格、交期或业绩不要填写为已确认。" />
      {recovered && dirty && <Alert type="warning" showIcon title="已恢复上次未保存的写作资料，尚未提交" description="原版本号保留；如果服务器已更新，保存时需先读取最新版本并人工核对。" />}
      {busy === 'load' && <Space><Spin size="small" /><Text type="secondary">正在读取已保存资料…</Text></Space>}
      <Form layout="vertical" disabled={!!busy || !saved}>
        <div className="ai-writing-input-grid"><Form.Item label="品牌或公司称谓"><Input aria-label="写作品牌称谓" maxLength={120} value={draft.brandName} placeholder="文章和产品中统一使用的名称" onChange={event => change({ brandName: event.target.value })} /></Form.Item><Form.Item label="主要读者（选填）"><Input aria-label="默认写作读者" maxLength={500} value={draft.audience} placeholder="例如：经销商、工程采购" onChange={event => change({ audience: event.target.value })} /></Form.Item><Form.Item label="目标市场（选填）"><Input aria-label="写作目标市场" maxLength={500} value={draft.market} placeholder="例如：北美、欧洲" onChange={event => change({ market: event.target.value })} /></Form.Item><Form.Item label="写作语气（选填）"><Input aria-label="默认写作语气" maxLength={500} value={draft.tone} placeholder="例如：简洁、专业、采购导向" onChange={event => change({ tone: event.target.value })} /></Form.Item></div>
        <Collapse items={[{ key: 'terms', label: '固定称谓和避免使用的说法（选填）', children: <><Form.Item label="固定拼写与术语" extra="首批作为写作约束使用，不代表已经接上自动翻译。"><Input.TextArea aria-label="写作固定术语" rows={3} maxLength={4000} value={draft.terminology} placeholder="每行一项，例如品牌拼写、系列名称" onChange={event => change({ terminology: event.target.value })} /></Form.Item><Form.Item label="避免使用的说法"><Input.TextArea aria-label="写作禁用说法" rows={3} maxLength={4000} value={draft.avoidedClaims} placeholder="例如：无依据的行业第一、保证交期" onChange={event => change({ avoidedClaims: event.target.value })} /></Form.Item></> }]} />
      </Form>
      <Flex justify="space-between" align="center" gap={12} wrap><div><Text strong>可供写作选用的事实</Text><Paragraph type="secondary" style={{ margin: '4px 0 0' }}>保留来源与适用范围；勾选确认仅表示由企业核对，不代表系统验证了资料真实性。最多30项。</Paragraph></div><Space wrap><Button disabled={!!busy || !saved || draft.facts.length >= 30} onClick={() => setReuseOpen(true)}>从已有资料选入</Button><Button icon={<PlusOutlined />} disabled={!!busy || !saved || draft.facts.length >= 30} onClick={() => change({ facts: [...draft.facts, { id: `fact-${crypto.randomUUID()}`, label: '', text: '', source: '', confirmed: false, scope: 'company' }] })}>添加资料</Button></Space></Flex>
      {!draft.facts.length && <Text type="secondary">可以先不添加；写作时也能使用当前产品或文章里已填写的资料。</Text>}
      {draft.facts.map((fact, index) => <Card key={fact.id} size="small" title={<Space wrap><Text strong>资料{index + 1}</Text><Tag color={fact.confirmed ? 'green' : 'default'}>{fact.confirmed ? '人工已确认' : '待确认，不用于生成'}</Tag></Space>} extra={<Button type="text" danger aria-label={`移除资料${index + 1}`} icon={<DeleteOutlined />} disabled={!!busy} onClick={() => change({ facts: draft.facts.filter(item => item.id !== fact.id) })} />}>
        <Form layout="vertical" disabled={!!busy}>
          <Form.Item label="资料名称"><Input aria-label={`资料${index + 1}名称`} maxLength={120} value={fact.label} placeholder="例如：板材规格、生产流程" onChange={event => changeFact(fact.id, { label: event.target.value })} /></Form.Item>
          <Form.Item label="可核实的事实"><Input.TextArea aria-label={`资料${index + 1}事实`} rows={3} maxLength={2000} value={fact.text} placeholder="填写已确认的内容；保留数字和单位" onChange={event => changeFact(fact.id, { text: event.target.value })} /></Form.Item>
          <Form.Item label="来源与核对依据"><Input aria-label={`资料${index + 1}来源`} maxLength={500} value={fact.source} placeholder="例如：产品表2026-11版第3行、公司资料第2页、负责人确认日期" onChange={event => changeFact(fact.id, { source: event.target.value })} /></Form.Item>
          {fact.sourceRef && <Alert type={sourceStates[fact.id]?.status === 'changed' ? 'warning' : 'info'} showIcon title={sourceStates[fact.id]?.message || '来源摘录已带入，保存后可检查原来源状态'} description={`${fact.sourceRef.locator} · 摘录时间${new Date(fact.sourceRef.capturedAt).toLocaleString()}。修改事实或适用范围将转为人工摘录，并需要重新确认。`} />}
          <div className="ai-writing-input-grid"><Form.Item label="适用范围"><Select aria-label={`资料${index + 1}范围`} value={fact.scope} options={[{ value: 'company', label: '公司资料' }, { value: 'product', label: '指定产品' }]} onChange={scope => changeFact(fact.id, { scope, productId: undefined })} /></Form.Item>{fact.scope === 'product' && <Form.Item label="适用产品"><Select aria-label={`资料${index + 1}产品`} showSearch optionFilterProp="label" value={fact.productId} placeholder="选择真实产品" options={runtime.envelope.state.products.map(product => ({ value: product.id, label: `${product.name} · ${product.sku}` }))} onChange={productId => changeFact(fact.id, { productId })} /></Form.Item>}</div>
          <Checkbox checked={fact.confirmed} onChange={event => changeFact(fact.id, { confirmed: event.target.checked })}>我已核对内容及适用范围，允许写作时选择使用</Checkbox>
        </Form>
      </Card>)}
      {error && <Alert type="error" showIcon title="写作资料操作未完成" description={error} action={<Button size="small" icon={<ReloadOutlined />} disabled={!!busy} onClick={() => void load(true)}>读取最新版本</Button>} />}
      {success && <Alert type="success" showIcon title={success} />}
      <Flex gap={12} wrap justify="space-between" align="center"><Text type="secondary">此资料为本实例私有写作依据，保存不会调用模型或发布网站。</Text><Button type="primary" icon={<SaveOutlined />} loading={busy === 'save'} disabled={!!busy || !saved || !dirty} onClick={() => void save()}>保存写作资料</Button></Flex>
    </Space>
  </Card><AiWritingReusePicker open={reuseOpen} onClose={() => setReuseOpen(false)} onPick={addReused} remaining={Math.max(0, 30 - draft.facts.length)} /></>;
}
