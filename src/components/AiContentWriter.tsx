'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Collapse, Drawer, Empty, Flex, Form, Input, List, Select, Space, Tabs, Tag, Typography } from 'antd';
import { ReloadOutlined, SettingOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { AiWritingField, AiWritingGenerateInput, AiWritingProfile, AiWritingProposal, AiWritingReceipt, AiWritingTarget, AiWritingTask, AiWritingValue } from '@/lib/ai-writing-types';
import { richTextPlainText } from '@/lib/presentation-content';
import { RichDocument } from '@/lib/presentation-components';
import { request, useStudioRuntime } from '@/lib/studio-client';
import { readLocalRecovery } from '@/lib/local-recovery';
import { siteLocales } from '@/lib/localization';
import { writingTextDifference } from '@/lib/ai-writing-difference';
import { useAiSettings } from './AiProviderSettings';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import './ai-content-writer.css';

const { Text, Paragraph } = Typography;
const taskNames: Record<AiWritingTask, string> = { product: '写产品介绍', outline: '先准备文章大纲', article: '写采购文章', rewrite: '调整这段文字', summary: '生成简短摘要' };
const taskExamples: Record<AiWritingTask, string[]> = {
  product: ['面向经销商，说明产品选型和实际用途，保持简洁。', '面向工程采购，突出已知材质、规格和使用限制。'],
  outline: ['面向经销商，围绕选型时的实际问题准备文章大纲。', '面向工程采购，先梳理规格、应用与需核对的事项。'],
  article: ['面向经销商，写一篇有依据的选型指南，回答实际采购问题。', '面向工程采购，说明选型依据、应用限制和需补充的资料。'],
  rewrite: ['保留原意和参数，把这段话写得更清楚、简洁。', '保留事实，改成采购人员容易理解的表达。'],
  summary: ['保留关键信息，整理成简短摘要，不增加新事实。', '提炼采购人员需要先了解的重点，避免空泛说法。'],
};
type Options = { instruction: string; sourceText: string; language: string; audience: string; tone: string; task: AiWritingTask; outputKeys: string[]; factIds: string[]; sourceKeys?: string[]; proposalId?: string };
export type AiContentWriterProps = {
  open: boolean; onClose: () => void; target: AiWritingTarget; fields: AiWritingField[]; sourceText: string;
  initialTask?: AiWritingTask; initialInstruction?: string; initialLanguage?: string; tasks?: AiWritingTask[];
  sourceChoices?: { id: string; label: string; text: string }[]; applyNotice?: string;
  referenceProductIds?: string[];
  onApply: (proposal: AiWritingProposal, selectedKeys: string[]) => Promise<void>;
  onUndoSaved?: (receipt: AiWritingReceipt) => Promise<void>; onBusyChange?: (busy: boolean) => void;
};
const valueText = (value: AiWritingValue) => typeof value === 'string' ? value : value ? richTextPlainText(value) : '';
function languageLabel(code: string, label?: string) {
  if (label && label !== code) return label;
  try { const english = new Intl.DisplayNames(['en'], { type: 'language' }).of(code), chinese = new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(code); return english && chinese && english !== chinese ? `${english} · ${chinese}` : english || chinese || code; }
  catch { return code; }
}
function validOptions(value: unknown): value is Options {
  if (!value || typeof value !== 'object') return false;
  const item = value as Options;
  return typeof item.instruction === 'string' && item.instruction.length <= 2000 && typeof item.sourceText === 'string' && item.sourceText.length <= 12000 && typeof item.language === 'string' && item.language.length <= 35 && typeof item.audience === 'string' && item.audience.length <= 1000 && typeof item.tone === 'string' && item.tone.length <= 1000 && Object.hasOwn(taskNames, item.task) && Array.isArray(item.outputKeys) && item.outputKeys.length <= 12 && item.outputKeys.every(key => typeof key === 'string' && key.length <= 120) && Array.isArray(item.factIds) && item.factIds.length <= 30 && item.factIds.every(id => typeof id === 'string' && id.length <= 100) && (item.sourceKeys === undefined || Array.isArray(item.sourceKeys) && item.sourceKeys.length <= 100 && item.sourceKeys.every(key => typeof key === 'string' && key.length <= 100)) && (!item.proposalId || typeof item.proposalId === 'string' && item.proposalId.length <= 100);
}

/** 只准备私有建议；明确勾选后交给原表单填入，不在这里保存产品、文章或公开网站。 */
export default function AiContentWriter({ open, onClose, target, fields, sourceText, initialTask, initialInstruction = '', initialLanguage, tasks, sourceChoices = [], referenceProductIds = [], applyNotice, onApply, onUndoSaved, onBusyChange }: AiContentWriterProps) {
  const runtime = useStudioRuntime(), aiSettings = useAiSettings(), { message } = App.useApp();
  const admin = runtime.actor.role === 'admin', scope = `ai-writing:${target.kind}:${target.id}${fields.length===1&&fields[0].key==='detailContent'?':detailContent':''}`;
  const defaultOptions = (): Options => ({ instruction: initialInstruction, sourceText: sourceText.slice(0, 12000), language: initialLanguage || runtime.envelope.state.settings.language || 'en', audience: '', tone: '', task: initialTask || (target.kind === 'product' ? 'product' : 'article'), outputKeys: target.kind === 'product' ? fields.filter(field => field.key === 'description'||fields.length===1&&field.key==='detailContent').map(field => field.key) : fields.filter(field => !field.key.startsWith('seo')).map(field => field.key), factIds: [], sourceKeys: [] });
  const [options, setOptions] = useState<Options>(defaultOptions), [snapshot, setSnapshot] = useState<AiWritingField[]>([]);
  const [profile, setProfile] = useState<AiWritingProfile>(), [provider, setProvider] = useState<{ enabled: boolean; model: string }>();
  const [proposal, setProposal] = useState<AiWritingProposal>(), [proposals, setProposals] = useState<AiWritingProposal[]>([]), [receipts, setReceipts] = useState<AiWritingReceipt[]>([]);
  const [selected, setSelected] = useState<string[]>([]), [outline, setOutline] = useState(''), [proposalOutline, setProposalOutline] = useState(''), [tab, setTab] = useState('prepare');
  const [busy, setBusy] = useState(''), [loading, setLoading] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState(''), [readErrors, setReadErrors] = useState<string[]>([]);
  const lock = useRef(false), sequence = useRef(0), priorOpen = useRef(false), targetKey = `${target.kind}:${target.id}`;
  const openedTarget = useRef('');
  const targetRef = useRef(targetKey); targetRef.current = targetKey;
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope, screen: target.kind === 'product' ? 'products' : 'content-models', title: target.kind === 'product' ? 'AI产品文案要求' : 'AI文章写作要求', dirty: open && dirty, busy: open && !!busy, snapshot: { ...options, ...(proposal ? { proposalId: proposal.id } : {}) }, discard: () => { setOptions(defaultOptions()); setDirty(false); } });
  function change(patch: Partial<Options>) { setOptions(current => ({ ...current, ...patch })); setDirty(true); setError(''); }
  async function loadState() {
    const read = ++sequence.current; setLoading(true); setReadErrors([]);
    const query = `kind=${target.kind}&id=${encodeURIComponent(target.id)}`;
    const results = await Promise.allSettled([request<AiWritingProfile>('/api/ai/writing/profile'), request<{ enabled: boolean; model: string }>('/api/ai/provider'), request<{ items: AiWritingProposal[] }>(`/api/ai/writing/proposals?${query}`), request<{ items: AiWritingReceipt[] }>(`/api/ai/writing/receipts?${query}`)]);
    if (read !== sequence.current) return;
    const failures: string[] = [];
    if (results[0].status === 'fulfilled') { const value = results[0].value; setProfile(value); setOptions(current => ({ ...current, audience: current.audience || value.audience, tone: current.tone || value.tone })); } else { setProfile(undefined); failures.push('写作资料未读到，请重新读取。'); }
    if (results[1].status === 'fulfilled') setProvider(results[1].value); else { setProvider(undefined); failures.push('AI服务状态未读到，当前不能判断是否启用。'); }
    if (results[2].status === 'fulfilled') setProposals(results[2].value.items.filter(item => item.target.kind === target.kind && item.target.id === target.id)); else failures.push('本人已有建议暂时未读到。');
    if (results[3].status === 'fulfilled') setReceipts(results[3].value.items); else failures.push('已保存修改的撤销记录暂时未读到。');
    setReadErrors(failures); setLoading(false);
  }
  useEffect(() => {
    if (!open || !admin) { priorOpen.current = false; sequence.current++; return; }
    if (!priorOpen.current || openedTarget.current !== targetKey) {
      openedTarget.current = targetKey;
      const recovered = readLocalRecovery<Options>(runtime.actor.id, scope, validOptions);
      setOptions(recovered?.snapshot || defaultOptions()); setSnapshot(structuredClone(fields)); setDirty(!!recovered); setProposal(undefined); setOutline(''); setProposalOutline(''); setSelected([]); setError(''); setTab('prepare');
      if (recovered?.snapshot.proposalId) void request<AiWritingProposal>(`/api/ai/writing/proposals/${encodeURIComponent(recovered.snapshot.proposalId)}`).then(value => { if (targetRef.current === `${value.target.kind}:${value.target.id}`) showProposal(value, recovered.snapshot); }).catch(cause => setError(cause instanceof Error ? cause.message : '旧建议读取失败，要求仍保留。'));
    }
    priorOpen.current = true; void loadState();
    return () => { sequence.current++; };
    // 只在开窗时冻结原字段；配置保存只重读状态，不更新生成基线或抹掉输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, admin, targetKey, aiSettings.changeVersion]);
  useEffect(() => { onBusyChange?.(!!busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  async function run(label: string, action: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(label); setError('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，原输入仍保留。'); }
    finally { lock.current = false; setBusy(''); }
  }
  async function generate(task = options.task, approvedOutline = '') {
    if (!profile || !provider?.enabled) { setError('请先成功读取写作资料，并在站点设置中启用自己的AI服务。'); return; }
    if (!options.outputKeys.length) { setError('请选择至少一项要准备的内容。'); return; }
    if (options.outputKeys.length > 12) { setError('单次最多准备12项字段，请减少本次选择；当前输入保持。'); return; }
    const requestSource = sourceFor(approvedOutline);
    if (requestSource.length > 12000) { setError('所选参考资料和大纲超过单次12000字符，请精简后再生成；当前输入保持。'); return; }
    await run('生成内容建议', async () => {
      const input: AiWritingGenerateInput = { target, fields: snapshot.filter(field => options.outputKeys.includes(field.key)), outputKeys: options.outputKeys, task, sourceText: requestSource, instruction: options.instruction, language: options.language, audience: options.audience, tone: options.tone, factIds: options.factIds, referenceProductIds, profileRevision: profile.revision };
      const next = await request<AiWritingProposal>('/api/ai/writing/proposals', { method: 'POST', body: JSON.stringify(input) });
      setProposal(next); setProposalOutline(approvedOutline); setSelected(next.fields.map(field => field.key)); setTab('compare'); setDirty(true);
      if (task === 'outline') setOutline(next.fields.filter(field => field.kind === 'richtext').map(field => valueText(field.after)).join('\n\n') || next.fields.map(field => valueText(field.after)).join('\n\n'));
      setProposals(current => [next, ...current.filter(item => item.id !== next.id)]); message.success('建议已生成，核对后再填入编辑区。');
    });
  }
  const allowedTasks = tasks || (target.kind === 'product' ? ['product', 'rewrite', 'summary'] : ['outline', 'article', 'rewrite', 'summary']) as AiWritingTask[];
  function sourceFor(approvedOutline = '', current = options) { const chosen = sourceChoices.filter(choice => current.sourceKeys?.includes(choice.id)).map(choice => choice.text).join('\n'); return `${current.sourceText}${chosen ? `\n\n本次选用的参数：\n${chosen}` : ''}${approvedOutline ? `\n\n已人工核对的大纲：\n${approvedOutline}` : ''}`.trim(); }
  function showProposal(next: AiWritingProposal, current = options) {
    const prefix = `${sourceFor('', current)}\n\n已人工核对的大纲：\n`;
    setProposalOutline(next.sourceText.startsWith(prefix) ? next.sourceText.slice(prefix.length) : '');
    setProposal(next); setSelected(next.fields.map(field => field.key)); setTab('compare');
    if (next.task === 'outline') setOutline(next.fields.filter(field => field.kind === 'richtext').map(field => valueText(field.after)).join('\n\n') || next.fields.map(field => valueText(field.after)).join('\n\n'));
  }
  // 文章只开放明确关联产品的事实，展示不代表已选用，服务端仍需核对适用范围。
  const eligibleFacts = profile?.facts.filter(fact => fact.confirmed && (fact.scope === 'company' || target.kind === 'product' && fact.productId === target.id || target.kind === 'entry' && !!fact.productId && referenceProductIds.includes(fact.productId))) || [];
  const languageMap = new Map(siteLocales(runtime.envelope.state.settings).map(item => [item.code, { value: item.code, label: languageLabel(item.code, item.label) }]));
  if (!languageMap.has(options.language)) languageMap.set(options.language, { value: options.language, label: languageLabel(options.language) });
  const languageOptions = [...languageMap.values()];
  // 历史建议也比较本次实际会发送的文字依据；不能仅因介绍未改就沿用旧材质/参数文案。
  const sameReferences = (left: string[] = [], right: string[] = []) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  const stale = !!proposal && (proposal.stale || profile?.revision !== proposal.profileRevision || Date.parse(proposal.expiresAt) <= Date.now() || proposal.sourceText !== sourceFor(proposalOutline) || !sameReferences(proposal.referenceProductIds, referenceProductIds));
  const differences = useMemo(() => new Map(proposal?.fields.map(field => [field.key, writingTextDifference(valueText(field.before), valueText(field.after))]) || []), [proposal]);
  const outputLabels = snapshot.filter(field => options.outputKeys.includes(field.key)).map(field => field.label);
  const selectedSources = sourceChoices.filter(choice => options.sourceKeys?.includes(choice.id));
  const stateLabel = proposal?.savedRevision !== undefined && proposal.savedRevision !== null ? '已保存，可查看这次修改' : proposal ? '建议已生成，尚未填入' : '准备内容';
  const renderValue = (value: AiWritingValue) => typeof value === 'string' || value === null ? <div className="ai-writing-plain">{value || <Text type="secondary">未填写</Text>}</div> : <div className="ai-writing-rich"><RichDocument doc={value} media={runtime.envelope.state.media} derived={false} /></div>;
  return <>{guard.dialog}<Drawer title={target.kind === 'product' ? fields.length===1&&fields[0].key==='detailContent'?'AI写产品图文详情':'AI写产品介绍' : 'AI写文章'} open={open} size="min(1040px, 100vw)" onClose={() => guard.ask(onClose)} closable={!busy} mask={{ closable: !busy }} keyboard={!busy} className="ai-content-writer" styles={{ body: { padding: 20 } }} footer={<Flex justify="space-between" gap={12} align="center" wrap><Text type="secondary">填入后仍需原编辑页保存，网站发布另行确认。</Text><Space wrap><Button disabled={!!busy} onClick={() => guard.ask(onClose)}>返回编辑</Button>{admin && tab === 'prepare' && <Button type="primary" icon={<ThunderboltOutlined />} loading={busy === '生成内容建议'} disabled={!!busy || loading || !profile || !provider?.enabled || !options.outputKeys.length} onClick={() => void generate()}>生成内容建议</Button>}</Space></Flex>}>
    {!admin ? <Alert type="info" showIcon title="AI写作由管理员使用" description="仍可按原权限手工编辑文章和产品。" /> : <Space orientation="vertical" size={20} style={{ width: '100%', minWidth: 0 }}>
      <Flex justify="space-between" gap={12} wrap align="center"><Space wrap><Text strong>全站AI服务</Text><Tag color={provider?.enabled ? 'green' : 'default'}>{loading ? '正在读取' : !provider ? '未读到状态' : provider.enabled ? '已启用' : '未启用'}</Tag>{provider?.enabled && <Text type="secondary">{provider.model}</Text>}</Space><Space wrap><Button icon={<ReloadOutlined />} loading={loading} disabled={!!busy} onClick={() => void loadState()}>读取最新状态</Button><Button icon={<SettingOutlined />} disabled={!!busy} onClick={aiSettings.open}>AI服务设置</Button></Space></Flex>
      {readErrors.map(item => <Alert key={item} type="warning" showIcon title={item} />)}
      {error && <Alert type="error" showIcon title="本次操作未完成" description={error} />}
      {applyNotice && <Alert type="info" showIcon title={applyNotice} />}
      <Flex className="ai-writing-state-strip" justify="space-between" align="center" gap={12} wrap><Text strong>{stateLabel}</Text><Text type="secondary">生成建议 → 核对并填入 → 原编辑页保存</Text></Flex>
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: 'prepare', label: '准备内容', children: <Space orientation="vertical" size={20} style={{ width: '100%' }}>
          <Form layout="vertical" disabled={!!busy}>
            <Form.Item label="这次需要什么"><Select aria-label="AI写作任务" value={options.task} options={allowedTasks.map(task => ({ value: task, label: taskNames[task] }))} onChange={task => change({ task })} /></Form.Item>
            <Form.Item label="想怎么写（选填）" extra="可以直接使用当前资料生成；也可以选下面的示例，再按需要修改。"><Input.TextArea aria-label="AI写作要求" rows={3} maxLength={2000} showCount value={options.instruction} placeholder="不确定怎么写可以留空，AI会根据当前任务和已选资料准备建议。" onChange={event => change({ instruction: event.target.value })} /></Form.Item>
            <Space className="ai-writing-examples" wrap size={[8, 8]}>{taskExamples[options.task].map((example, index) => <Button key={example} size="small" onClick={() => change({ instruction: example })}>{options.task === 'rewrite' || options.task === 'summary' ? index === 0 ? '使用示例：更简洁' : '使用示例：采购表达' : index === 0 ? '使用示例：经销采购' : '使用示例：工程采购'}</Button>)}</Space>
            <Card size="small" title="本次会发送的资料" className="ai-writing-source-summary">
              <Paragraph>当前参考文字与所选字段原文{selectedSources.length ? `、${selectedSources.length}项产品参数` : ''}{options.factIds.length ? `、${options.factIds.length}项已勾选企业资料` : ''}。</Paragraph>
              <Paragraph type="secondary">将准备：{outputLabels.join('、') || '尚未选择内容'} · {languageMap.get(options.language)?.label || options.language}。额外参数和企业资料由你选择后才会加入。</Paragraph>
              <Collapse items={[{ key: 'sources', label: '核对本次参考资料', children: <><Form.Item label="参考资料（会发送给自己的AI）"><Input.TextArea aria-label="AI写作参考资料" rows={6} maxLength={12000} showCount value={options.sourceText} onChange={event => change({ sourceText: event.target.value })} /></Form.Item>{sourceChoices.length > 0 && <Form.Item label="本次选用的产品参数（选填）"><Checkbox.Group value={options.sourceKeys || []} onChange={keys => change({ sourceKeys: keys as string[] })} className="ai-writing-facts">{sourceChoices.map(choice => <Checkbox key={choice.id} value={choice.id}>{choice.label}：{choice.text}</Checkbox>)}</Checkbox.Group></Form.Item>}</> }, { key: 'facts', label: `选用已确认的企业资料（${options.factIds.length}项）`, children: eligibleFacts.length ? <Checkbox.Group value={options.factIds} onChange={ids => change({ factIds: ids as string[] })} className="ai-writing-facts">{eligibleFacts.map(fact => <Checkbox key={fact.id} value={fact.id}><Space orientation="vertical" size={2}><Text strong>{fact.label}</Text><Text>{fact.text}</Text><Text type="secondary">来源：{fact.source || '人工填写'} · {fact.scope === 'company' ? '公司资料' : target.kind === 'product' ? '当前产品资料' : '所选产品资料'}</Text></Space></Checkbox>)}</Checkbox.Group> : <Text type="secondary">当前没有适用的已确认资料，可以先使用当前表单文字。共用资料可在站点设置的AI服务中维护。</Text> }]} />
              <Paragraph type="secondary" className="ai-writing-source-note">不发送图片文件、询盘或服务密钥；缺少的认证、价格和交期等事实不会作为已知资料。</Paragraph>
            </Card>
            {/* 常用任务可直接开始；高级项折叠但仍保留精确字段和发送范围控制。 */}
            <Collapse className="ai-writing-more-options" items={[{ key: 'more', label: '更多要求（字段、语言和表达）', children: <>
              <Form.Item label="准备哪些内容" extra={target.kind === 'product' ? fields.length===1&&fields[0].key==='detailContent'?'本次只准备产品图文详情，短介绍、参数和其它资料保持。':'默认只写产品介绍。额外文字字段勾选后才允许改写，与参考参数分别选择。' : '标题、正文、摘要和搜索文案可分别选择；未勾选的字段保持。'}><Checkbox.Group value={options.outputKeys} onChange={keys => change({ outputKeys: keys as string[] })} options={snapshot.map(field => ({ value: field.key, label: field.key.startsWith('customFields:') && target.kind === 'product' ? `${field.label}（允许改写）` : field.label }))} /></Form.Item>
              <Form.Item label="输出语言"><Select aria-label="AI写作语言" value={options.language} options={languageOptions} onChange={language => change({ language })} /></Form.Item>
              <div className="ai-writing-input-grid"><Form.Item label="主要读者（选填）"><Input aria-label="AI写作读者" maxLength={500} value={options.audience} placeholder="例如：经销商、工程采购" onChange={event => change({ audience: event.target.value })} /></Form.Item><Form.Item label="写作语气（选填）"><Input aria-label="AI写作语气" maxLength={500} value={options.tone} placeholder="例如：简洁、专业、采购导向" onChange={event => change({ tone: event.target.value })} /></Form.Item></div>
            </> }]} />
          </Form>
          <Text type="secondary">点击下方“生成内容建议”才请求自己的模型额度，失败不会自动重试。</Text>
        </Space> },
        { key: 'compare', label: '预览与采用', children: proposal ? <Space orientation="vertical" size={20} style={{ width: '100%' }}>
          <Alert type={stale ? 'warning' : 'info'} showIcon title={stale ? '依据已变化或建议已过期，请重新核对并生成' : proposal.savedRevision !== null ? '已保存，可在“查看建议与修改”中核对或撤销' : '建议已生成，选择要填入的内容'} description={`有效至${new Date(proposal.expiresAt).toLocaleString()}。${proposal.savedRevision !== null ? '网站发布仍需另行确认。' : '填入后仍需原编辑页保存；未选择的字段保持。'}`} />
          {proposal.warnings.map((warning, index) => <Alert key={`warning-${index}`} type="warning" showIcon title={warning} />)}
          {proposal.missingFacts.length > 0 && <Card size="small" title="需要你补充或核对"><List size="small" dataSource={proposal.missingFacts} renderItem={item => <List.Item>{item}</List.Item>} /></Card>}
          <Text strong>本次准备了{proposal.fields.length}项内容，已选择{selected.length}项填入。</Text>
          {proposal.fields.map(field => { const difference = differences.get(field.key); return <Card size="small" key={field.key} title={<Checkbox checked={selected.includes(field.key)} disabled={!!busy || stale || proposal.savedRevision !== null} onChange={event => setSelected(current => event.target.checked ? [...current, field.key] : current.filter(key => key !== field.key))}>{field.label}</Checkbox>}>
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Flex gap={12} wrap><Text strong>文字改动</Text><Text className="ai-writing-added-label">新增文字</Text><Text className="ai-writing-removed-label">删除文字</Text></Flex>
              {difference?.changed ? <div className="ai-writing-difference" tabIndex={0} aria-label={`${field.label}文字增删对照`}>{difference.parts.map((part, index) => part.kind === 'added' ? <ins key={index}>{part.text}</ins> : part.kind === 'removed' ? <del key={index}>{part.text}</del> : <span key={index}>{part.text}</span>)}</div> : <Text type="secondary">文字保持原样；排版请展开下方预览核对。</Text>}
              {difference?.simplified && <Text type="secondary">长文按连续变化范围标记，双方全部文字仍保留。</Text>}
              <Collapse items={[{ key: 'full', label: '查看原文与建议排版', children: <div className="ai-writing-compare-grid"><div><Text type="secondary">生成时的内容</Text>{renderValue(field.before)}</div><div><Text strong>AI建议</Text>{renderValue(field.after)}</div></div> }]} />
            </Space>
          </Card>; })}
          {proposal.evidence.length > 0 && <Collapse items={[{ key: 'evidence', label: `本次选用的${proposal.evidence.length}项资料`, children: <List size="small" dataSource={proposal.evidence} renderItem={fact => <List.Item><List.Item.Meta title={fact.label} description={`${fact.text} · 来源：${fact.source || '人工填写'}`} /></List.Item>} /> }]} />}
          {proposal.task === 'outline' && <Card size="small" title="核对大纲后继续"><Form layout="vertical"><Form.Item label="大纲（可修改）"><Input.TextArea aria-label="已核对文章大纲" value={outline} rows={7} maxLength={10000} disabled={!!busy} onChange={event => { setOutline(event.target.value); setDirty(true); }} /></Form.Item><Button icon={<ThunderboltOutlined />} loading={busy === '生成内容建议'} disabled={!!busy || stale || !outline.trim()} onClick={() => void generate('article', outline)}>按此大纲生成正文（调用AI）</Button></Form></Card>}
          <Button type="primary" disabled={!!busy || stale || !selected.length || proposal.savedRevision !== null} loading={busy === '填入编辑区'} onClick={() => void run('填入编辑区', async () => { const fresh = await request<AiWritingProposal>(`/api/ai/writing/proposals/${encodeURIComponent(proposal.id)}`); if (fresh.stale || Date.parse(fresh.expiresAt) <= Date.now()) throw new Error('写作依据或建议期限已变化，请重新核对后生成。'); await onApply(fresh, selected); setDirty(false); guard.clear(); onClose(); })}>填入编辑区</Button>
        </Space> : <Empty description="先准备内容并生成建议，或从已有记录继续查看。" /> },
        { key: 'history', label: '查看建议与修改', children: <Space orientation="vertical" size={20} style={{ width: '100%' }}>
          <Text type="secondary">查看记录不调用AI。尚未保存的内容在原编辑页撤回，已保存的修改在下方撤销。</Text>
          <List header={<Text strong>我的内容建议</Text>} dataSource={proposals} locale={{ emptyText: '暂无有效建议' }} renderItem={item => <List.Item actions={[<Button key="read" disabled={!!busy} onClick={() => void run('读取建议', async () => { const next = await request<AiWritingProposal>(`/api/ai/writing/proposals/${encodeURIComponent(item.id)}`); showProposal(next); })}>查看建议</Button>]}><List.Item.Meta title={<Space wrap>{taskNames[item.task]}<Tag color={item.savedRevision !== null ? 'green' : undefined}>{item.savedRevision !== null ? '已保存' : '建议已生成'}</Tag>{item.stale && <Tag color="gold">依据已变化</Tag>}</Space>} description={`创建于${new Date(item.createdAt).toLocaleString()} · 有效至${new Date(item.expiresAt).toLocaleString()}`} /></List.Item>} />
          <List header={<Text strong>已保存的修改</Text>} dataSource={receipts} locale={{ emptyText: '暂无可撤销的已保存修改' }} renderItem={item => <List.Item actions={onUndoSaved ? [<Button key="undo" disabled={!!busy || item.undoneRevision !== null} onClick={() => void run('撤销已保存修改', async () => { await onUndoSaved(item); await loadState(); message.success('这次已保存的修改已撤销，网站发布状态保持。'); })}>{item.undoneRevision !== null ? '已撤销' : '撤销这次修改'}</Button>] : undefined}><List.Item.Meta title={<Space wrap>{item.fields.length}项内容<Tag color={item.undoneRevision !== null ? undefined : 'green'}>{item.undoneRevision !== null ? '已撤销' : '已保存，可撤销'}</Tag></Space>} description={`保存于${new Date(item.createdAt).toLocaleString()} · 可撤销至${new Date(item.expiresAt).toLocaleString()}`} /></List.Item>} />
        </Space> },
      ]} />
    </Space>}
  </Drawer></>;
}
