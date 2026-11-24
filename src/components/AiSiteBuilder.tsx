'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Card, Col, Collapse, Descriptions, Flex, Form, Input, List, Modal, Popconfirm, Radio, Row, Segmented, Select, Space, Steps, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, CheckCircleOutlined, DesktopOutlined, DownloadOutlined, EditOutlined, ExportOutlined, EyeOutlined, MobileOutlined, SaveOutlined, SettingOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';
import { request, RequestError, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { readFreshStudio } from '@/lib/refresh-studio';
import { clearLocalRecovery, localRecoveries, readLocalRecovery } from '@/lib/local-recovery';
import type { ScreenProps } from '@/lib/types';
import type { AiSiteBrief, AiSiteDirection, AiSitePagePlan, AiSitePlan, AiSiteSeoIssue, AiBuildLayoutInspection } from '@/lib/ai-builder-types';
import type { AiBuildPlanRun, AiBuildRun, AiBuildRunsResponse, AiBuildRunSummary, AiBuildSavedPlan, AiBuildUndoStatus } from '@/lib/ai-build-resume-types';
import type { AiBuildCheckLocation } from '@/lib/ai-build-site-check-types';
import { AI_SITE_LAYOUT_LABELS } from '@/lib/ai-builder-types';
import { canReplaceAiEmptyHome, compileAiSitePlan } from '@/lib/ai-site-generator';
import { aiLayoutDeviceForWidth, inspectAiBuildLayout, matchAiInspectionPage } from '@/lib/ai-build-layout-inspection';
import type { DraftContent } from '@/server/types';
import { AiBuildDirectionFacts, AiBuildPageFacts } from './AiBuildLayoutFacts';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import AiSourceImport from './AiSourceImport';
import AiBuildPlanEditor, { readPlanEditorRecovery } from './AiBuildPlanEditor';
import AiBuildSiteCheck from './AiBuildSiteCheck';
import AiWritingBriefReuse from './AiWritingBriefReuse';
import { useAiSettings, type AiProvider as Provider } from './AiProviderSettings';
import './ai-site-builder.css';

const { Title, Text, Paragraph } = Typography;
type Planned = { plan: AiSitePlan; baseRevision: number; planId: string; savedPlan?: AiBuildSavedPlan; superseded?: boolean };
type Preview = { inspection?:AiBuildLayoutInspection; previewId: string; baseRevision: number; pages: { id: string; title: string; slug: string }[]; warnings: string[]; seoIssues: AiSiteSeoIssue[]; expiresAt?: string; appliedRevision?: number | null; directionId?: string };
type BuildEnvelope = StudioEnvelope & { buildUndo: AiBuildUndoStatus & { previewId: string; expiresAt: string } };
type Recovery = { brief: AiSiteBrief; prefix: string; selectedProductIds?: string[] };

function initialPreviewPath(pages: Preview['pages'], prefix: string) {
  const homePath = prefix.trim() ? `/${prefix.trim().replace(/^\//, '')}` : '/';
  return pages.find(page => page.slug === homePath)?.slug || pages.find(page => !page.slug.includes(':'))?.slug || '';
}

function validRecovery(value: unknown): value is Recovery {
  if (!value || typeof value !== 'object') return false;
  const item = value as Recovery;
  return !!item.brief && typeof item.prefix === 'string' && item.prefix.length <= 64 && (item.selectedProductIds === undefined || Array.isArray(item.selectedProductIds) && item.selectedProductIds.length <= 20 && item.selectedProductIds.every(id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id))) &&
    (['companyName', 'description', 'industry', 'audience', 'market', 'language', 'styleNotes'] as const).every(key => typeof item.brief[key] === 'string' && item.brief[key].length <= 6000);
}

function DirectionCard({ direction,index,inspection,problem, selected, disabled, onSelect, onPreview }: { direction: AiSiteDirection;index:number;inspection?:AiBuildLayoutInspection;problem?:string; selected: boolean; disabled: boolean; onSelect: () => void; onPreview: () => void }) {
  const layoutName = AI_SITE_LAYOUT_LABELS[direction.layout];
  return <Card className={`ai-direction-card${selected ? ' is-selected' : ''}`} styles={{ body: { padding: 20 } }}>
    <Flex justify="space-between" gap={8} align="start"><Title level={5}>方向 {index+1}</Title><Radio name="ai-site-design-direction" checked={selected} disabled={disabled} onChange={onSelect} aria-label={`选择${direction.name}`} /></Flex>
    <Text type="secondary">提案名：{direction.name}</Text>
    <Text strong>将生成的原生布局</Text>
    {inspection?<AiBuildDirectionFacts inspection={inspection}/>:<Alert type="warning" showIcon title="当前资料或网址无法生成此方向" description={problem||'请检查页面地址后打开真实预览。'}/>}
    <Flex gap={8} align="center" className="ai-direction-palette"><span style={{ background: direction.primary }} /><span style={{ background: direction.background }} /><span style={{ background: direction.text }} /><Text type="secondary">{layoutName}</Text></Flex>
    <Collapse size="small" items={[{key:'idea',label:'AI设计想法（原文）',children:<Paragraph type="secondary">{direction.rationale}</Paragraph>}]}/>
    <Text type="secondary" className="ai-builder-help">上方核对来自当前资料的原生编译；实际换行、首屏位置与图片加载请打开页面检查。</Text>
    <Button block type={selected ? 'primary' : 'default'} icon={selected ? <CheckCircleOutlined /> : undefined} disabled={disabled} onClick={onSelect}>{selected ? '已选此方向' : '选择此方向'}</Button>
    <Button block type="text" icon={<EyeOutlined />} disabled={disabled} onClick={onPreview} aria-label={`预览${direction.name}`}>查看此方向真实预览</Button>
  </Card>;
}

/** 解读只展示服务端已校验的规划，按钮目标从真实普通页key解析，不补造业务承诺。 */
function PlanIntent({ plan }: { plan: AiSitePlan }) {
  const intent = plan.intent;
  const siteTypes = { 'product-catalog': '以产品与询盘为主', 'professional-services': '以服务与沟通为主', 'brand-showcase': '以品牌与系列展示为主' };
  const actions = [...new Map(plan.pages.flatMap(page => page.sections.flatMap(section => {
    const target = section.cta && plan.pages.find(item => item.key === section.cta!.pageKey && !item.path.includes(':'));
    return section.cta && target ? [[`${section.cta.label}:${target.key}`, { label: section.cta.label, title: target.title, path: target.path }] as const] : [];
  }))).values()];
  return <Card title="AI 对需求的理解" className="ai-builder-panel" styles={{ body: { padding: 24 } }}><Space orientation="vertical" size={16} style={{ width: '100%' }}>
    {intent ? <><Descriptions column={1} size="small" items={[{ key: 'type', label: '网站重点', children: siteTypes[intent.siteType] }, { key: 'goal', label: '希望客户完成', children: intent.primaryGoal }, { key: 'tasks', label: '先帮客户解决', children: <List size="small" dataSource={intent.audienceTasks} renderItem={item => <List.Item>{item}</List.Item>} /> }]} /><Collapse items={[{ key: 'constraints', label: `必须遵守与待补资料 · ${intent.constraints.length}项要求 / ${intent.missingFacts.length}项待补`, children: <Space orientation="vertical" size={12} style={{ width: '100%' }}><Text strong>必须遵守</Text>{intent.constraints.length ? <List size="small" dataSource={intent.constraints} renderItem={item => <List.Item>{item}</List.Item>} /> : <Text type="secondary">方案未列出额外要求，请核对是否遗漏。</Text>}<Text strong>待补资料</Text>{intent.missingFacts.length ? <List size="small" dataSource={intent.missingFacts} renderItem={item => <List.Item>{item}</List.Item>} /> : <Text type="secondary">方案未列出待补项，仍需核对业务事实。</Text>}</Space> }]} /></> : <Alert type="info" showIcon title="这份旧方案没有单独的需求解读" description="请结合内容规划与真实页面核对目标、约束和资料缺口；读取不会重新生成。" />}
    <div><Text strong>页面希望客户怎么行动</Text>{actions.length ? <List size="small" dataSource={actions} renderItem={item => <List.Item><Flex gap={12} wrap><Text>{item.label}</Text><Text type="secondary">前往 {item.title}</Text><Text code>{item.path}</Text></Flex></List.Item>} /> : <Paragraph type="secondary">方案未声明专门的行动按钮，请在真实预览中检查客户如何找到下一步。</Paragraph>}</div>
    <Text type="secondary">先核对理解是否正确。页面、文案和按钮可在本步骤直接修改；如需按新企业资料重新规划，再返回资料发起生成。</Text>
  </Space></Card>;
}

/** AI只准备私有方案；用户检查后才按当前revision新增草稿，生成过程不发布网站。 */
export default function AiSiteBuilder({ state, update, navigate, journey, recoverPlanInput, onRecoveryHandled }: ScreenProps & { recoverPlanInput?: boolean; onRecoveryHandled?: () => void }) {
  const aiSettings = useAiSettings();
  const runtime = useStudioRuntime(), { message } = App.useApp(), admin = runtime.actor.role === 'admin';
  const [recovered] = useState(() => readLocalRecovery<Recovery>(runtime.actor.id, 'ai-site-builder', validRecovery));
  const initialBrief = useRef<AiSiteBrief>({ companyName: canReplaceAiEmptyHome(state) && state.settings.name === 'My website' ? '' : state.settings.name || '', description: state.settings.description || '', industry: '', audience: '', market: '', language: state.settings.language || 'en', styleNotes: '' });
  // 原始空首页直接作为新站首页；已有网站使用独立目录，恢复的明确选择优先。
  const initialPrefix = useRef(canReplaceAiEmptyHome(state) ? '' : '/ai-site');
  const [brief, setBrief] = useState<AiSiteBrief>(recovered ? { ...recovered.snapshot.brief, language: state.settings.language || 'en' } : initialBrief.current);
  const [prefix, setPrefix] = useState(recovered?.snapshot.prefix ?? initialPrefix.current);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>(recovered?.snapshot.selectedProductIds || []);
  const [provider, setProvider] = useState<Provider>();
  const [providerLoading, setProviderLoading] = useState(true);
  const [writingReuseOpen, setWritingReuseOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false), [importBusy, setImportBusy] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [planned, setPlanned] = useState<Planned>();
  const [planEditorOpen, setPlanEditorOpen] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [expiredPreviewId, setExpiredPreviewId] = useState('');
  const [directionId, setDirectionId] = useState('');
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<'plan' | 'revise' | 'retention' | 'preview' | 'apply' | 'undo' | 'refresh' | 'runs' | 'restore' | ''>('');
  const [error, setError] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPath, setPreviewPath] = useState('');
  const [device, setDevice] = useState('desktop');
  const previewFrame=useRef<HTMLIFrameElement>(null);
  const previewObserver=useRef<ResizeObserver|null>(null);
  const [loadedPreview,setLoadedPreview]=useState<{id:string;path:string;width:number}>();
  const [focusedPreview, setFocusedPreview] = useState<AiBuildCheckLocation & { previewId: string }>();
  const [dirty, setDirty] = useState(!!recovered);
  const [runsOpen, setRunsOpen] = useState(false), [runs, setRuns] = useState<AiBuildRunSummary[]>([]), [restoredRun, setRestoredRun] = useState<AiBuildRun>();
  const [runNotice, setRunNotice] = useState('');
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false), [undoConfirmOpen, setUndoConfirmOpen] = useState(false);
  const [form] = Form.useForm();
  const lock = useRef(false);
  const providerRead = useRef(0);
  const handledIntent = useRef('');
  const directionInspections=useMemo(()=>{
    if(!planned||step!==1)return [];
    return planned.plan.directions.map(direction=>{
      try{
        // 与服务端使用同一原生编译函数；仅内存核对，不生成记录、不联网、不修改草稿。
        const source={...state,settings:{...state.settings,name:brief.companyName}} as DraftContent;
        const compiled=compileAiSitePlan(planned.plan,direction.id,source,prefix),candidate={...source,...compiled.patch};
        const templateIds=(compiled.patch.pageTemplates||[]).filter(template=>!source.pageTemplates?.some(old=>old.id===template.id)).map(template=>template.id);
        return {id:direction.id,inspection:inspectAiBuildLayout(candidate,compiled.pageIds,templateIds)};
      }catch(cause){return{id:direction.id,problem:cause instanceof Error?cause.message:'无法核对当前原生编排'};}
    });
  },[planned,step,state,prefix,brief.companyName]);
  useEffect(()=>{if(!previewOpen){setLoadedPreview(undefined);previewObserver.current?.disconnect();}else setLoadedPreview(current=>current?.id===preview?.previewId?current:undefined);},[preview?.previewId,previewOpen]);
  useEffect(()=>()=>previewObserver.current?.disconnect(),[]);
  // 定时刷新操作状态，并在浏览器从后台恢复时重算，点击确认也会再次核对真实时间。
  useEffect(() => {
    if (!preview?.expiresAt) return;
    const deadline = Date.parse(preview.expiresAt);
    const check = () => { if (Date.now() >= deadline) setExpiredPreviewId(preview.previewId); };
    const timer = window.setTimeout(check, Math.max(0, deadline - Date.now()));
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [preview?.previewId, preview?.expiresAt]);
  function previewLoaded(){
    const frame=previewFrame.current;if(!frame||!preview)return;
    previewObserver.current?.disconnect();
    try{
      const url=frame.contentWindow?.location,base=`/preview/~ai/${preview.previewId}`;
      if(!url||url.origin!==location.origin||url.pathname!==base&&!url.pathname.startsWith(base+'/')){setLoadedPreview(undefined);return;}
      // 只同步核对面板，不重写iframe.src；预览内导航不能因父层同步而重载/取消图片。
      setLoadedPreview({id:preview.previewId,path:url.pathname.slice(base.length)||'/',width:frame.clientWidth});
      previewObserver.current=new ResizeObserver(()=>setLoadedPreview(current=>current?.id===preview.previewId?{...current,width:frame.clientWidth}:current));previewObserver.current.observe(frame);
    }catch{setLoadedPreview(undefined);}
  }
  useEffect(() => { form.setFieldsValue(brief); }, [brief, form]);
  // 全站服务保存后只重读连接状态，保持当前企业资料、设计方案和预览。
  useEffect(() => {
    if (!admin) return;
    void readProvider();
    return () => { providerRead.current++; };
  }, [admin, aiSettings.changeVersion]);
  async function readProvider() {
    const read=++providerRead.current;setProviderLoading(true);setProviderError('');
    try{const value=await request<Provider>('/api/ai/provider');if(read===providerRead.current)setProvider(value);}catch(cause){if(read===providerRead.current)setProviderError(cause instanceof Error?cause.message:'AI配置读取失败，请重新读取后再配置。');}finally{if(read===providerRead.current)setProviderLoading(false);}
  }
  useEffect(() => {
    const resume = (event: Event) => {
      const scope = (event as CustomEvent).detail?.scope;
      if (scope !== 'ai-site-builder') return;
      const item = readLocalRecovery<Recovery>(runtime.actor.id, 'ai-site-builder', validRecovery);
      if (item) { setBrief({ ...item.snapshot.brief, language: state.settings.language || 'en' }); setPrefix(item.snapshot.prefix); setSelectedProductIds(item.snapshot.selectedProductIds || []); setDirty(true); setPlanned(undefined); setPreview(undefined); setStep(0); }
    };
    window.addEventListener('form-studio:recover-local', resume);
    return () => window.removeEventListener('form-studio:recover-local', resume);
  }, [runtime.actor.id, state.settings.language]);
  function changeBrief(patch: Partial<AiSiteBrief>) { setBrief(current => ({ ...current, ...patch })); setDirty(true); setPlanned(undefined); setPreview(undefined); setRestoredRun(undefined); setRunNotice(''); setError(''); }
  function reset() { setBrief(initialBrief.current); setPrefix(initialPrefix.current); setSelectedProductIds([]); setPlanned(undefined); setPreview(undefined); setRestoredRun(undefined); setRunNotice(''); setDirectionId(''); setStep(0); setDirty(false); setError(''); }
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope: 'ai-site-builder', screen: 'templates', title: 'AI建站资料', dirty: admin && dirty, busy: !!busy || importBusy, snapshot: { brief, prefix, selectedProductIds }, discard: reset });
  // 恢复按钮可能先切换资源页签再挂载向导；请求在外层保留，挂载后再按本人记录读取。
  useEffect(() => {
    if (!admin || !recoverPlanInput || busy || importBusy) return;
    onRecoveryHandled?.();
    const recovery = readPlanEditorRecovery(runtime.actor.id);
    if (recovery) void restoreRun(recovery.planId, true);
  }, [admin, recoverPlanInput, onRecoveryHandled, runtime.actor.id, busy, importBusy]);
  // 导入选项可能是唯一恢复项；AI页签挂载后打开原窗口，让子组件按原权限读取来源。
  useEffect(() => { if (!journey?.intent && localRecoveries(runtime.actor.id).some(item => item.scope === 'ai-source-import')) setSourceOpen(true); }, []);
  // 一次导航意图只打开输入或读取记录；全站AI配置由站点设置单独管理。
  useEffect(() => {
    const intent=journey?.intent;if(!admin||!intent||handledIntent.current===intent.id||busy||importBusy)return;
    if(!['brief','import','resume'].includes(intent.action))return;
    handledIntent.current=intent.id;journey.consumeIntent(intent.id);
    if(intent.action==='import')setSourceOpen(true);else if(intent.action==='brief')setStep(0);else if(intent.runId)guard.ask(()=>void restoreRun(intent.runId!));else void readRuns();
  },[journey,admin,busy,importBusy]);
  async function readRuns() {
    if(lock.current)return;lock.current=true;setBusy('runs');setError('');setRunsOpen(true);
    try{setRuns((await request<AiBuildRunsResponse>('/api/ai/build/runs')).items.filter(item=>item.operation!=='shared-chrome'));}catch(cause){setError(cause instanceof Error?cause.message:'建站记录读取失败，当前输入仍保留。');}finally{lock.current=false;setBusy('');}
  }
  /** 继续只读取本人的有效记录，保留原revision与期限；不偷偷生成、采用或重设基准。 */
  async function restoreRun(id:string, openEditor = false) {
    if(lock.current)return;lock.current=true;setBusy('restore');setError('');
    try{
      const value=await request<AiBuildRun>(`/api/ai/build/runs/${encodeURIComponent(id)}`);
      const plan=value.kind==='plan'?value:value.plan;
      if(plan){setBrief(plan.brief);setSelectedProductIds(plan.selectedProductIds||[]);setPlanned(plan.superseded ? undefined : plan);}
      else setPlanned(undefined);
      setRestoredRun(value);setPreviewOpen(false);setRunsOpen(false);setDirty(!(value.kind==='plan'&&value.savedPlan));journey?.onBuildRun(value.kind==='plan'?value.planId:value.previewId);
      if(value.kind==='plan'){
        setPreview(undefined);
        if(value.superseded){setStep(0);setRunNotice('这份方案已有新版本，请从长期方案列表继续。');return;}
        setDirectionId(value.savedPlan?.directionId || value.plan.directions[0]?.id || '');
        if (value.savedPlan) { setPrefix(value.savedPlan.prefix); guard.clear(); }
        setStep(1);
        if (openEditor) setPlanEditorOpen(true);
      }
      else{setPrefix(value.prefix);setDirectionId(value.directionId);if(value.appliedRevision===null){setPreview(value);setPreviewPath(initialPreviewPath(value.pages,value.prefix));setStep(2);}else{setPreview(undefined);setStep(0);setDirty(false);}}
      setRunNotice(value.kind==='plan'&&value.savedPlan?'已恢复长期方案。你可以继续修改，或用最新草稿重新生成预览。':value.kind==='preview'&&value.undoneRevision!=null?'本次建站已撤销，原回执保留；不会再次采用。':value.kind==='preview'&&value.appliedRevision!==null?'这份预览已保存过，可以打开实际页面或查看安全撤销状态；不会再次采用。':value.baseRevision!==value.currentRevision?'记录读取成功，但工作区已有更新。请核对资料后重新生成页面预览，无需再次调用AI。':value.kind==='preview'&&value.plan?.superseded?'已恢复这份冻结预览。原方案已有新版本，可从长期方案列表继续。':value.kind==='preview'&&!value.plan?'已恢复页面预览，原内容方案已过期。仍可检查这份预览；如需更换设计，请返回资料明确生成新方案。':'已读取原建站记录。请继续核对设计与内容，确认后才保存为草稿；读取不调用AI。');
    }catch(cause){setError(cause instanceof Error?cause.message:'记录读取失败，当前资料仍保留。');}finally{lock.current=false;setBusy('');}
  }
  async function editAppliedRun() {
    if(restoredRun?.kind!=='preview'||restoredRun.appliedRevision===null)return;
    const pages=runtime.getEnvelope().state.pages,ids=restoredRun.pages.map(page=>page.id).filter(id=>pages.some(page=>page.id===id));
    if(!ids.length){setError('这份记录中的页面已不存在，请在网站页面中选择其他页面。');return;}
    const pageId=ids.find(id=>!pages.find(page=>page.id===id)!.slug.includes(':'));
    if(!pageId){setError('当前只剩动态详情模板，请先在网站页面选择可预览的普通页面。');return;}
    try{await update({activePageId:pageId});journey?.onApplied(ids);navigate('editor');}catch(cause){setError(cause instanceof Error?cause.message:'页面打开失败，请读取最新工作区再选择页面。');}
  }
  /** 撤销只提交本人回执与队列中的最新版本；是否仍安全由服务端按真实字段和引用判断。 */
  async function undoBuild() {
    if (!admin || lock.current || restoredRun?.kind !== 'preview' || !restoredRun.canUndo) return;
    const previewId = restoredRun.previewId;
    lock.current = true; setBusy('undo'); setError('');
    try {
      let status: AiBuildUndoStatus | undefined;
      await runtime.mutate(async current => {
        const result = await request<BuildEnvelope>('/api/ai/build/undo', { method: 'POST', body: JSON.stringify({ previewId, expectedRevision: current.revision }) });
        status = result.buildUndo;
        return result;
      });
      setRestoredRun(current => current?.kind === 'preview' && current.previewId === previewId ? { ...current, ...status, currentRevision: runtime.getEnvelope().revision } : current);
      setUndoConfirmOpen(false); setDirty(false); guard.resolve(); setRunNotice('本次建站已撤销。其他内容和公开版本继续保持当前状态。');
      message.success('已撤销本次建站草稿');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '撤销未确认，请读取本次记录核对状态。'); }
    finally { lock.current = false; setBusy(''); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ brief, prefix, selectedProductIds, ...(planned ? { plan: planned.plan } : {}) }, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'ai-website-brief.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // 长期保存记录当前设计选项。恢复后先用最新草稿重新编译，仍须确认才会写入网站。
  async function changePlanRetention(planId: string, keep: boolean) {
    if (lock.current) return;
    lock.current = true; setBusy('retention'); setError('');
    try {
      const result = await request<AiBuildPlanRun>('/api/ai/build/plan/retention', {
        method: 'POST', body: JSON.stringify({ planId, keep, ...(keep ? { directionId, prefix } : {}) }),
      });
      if (planned?.planId === planId) setPlanned(result);
      if (keep) {
        guard.clear();
        setDirty(false);
        message.success('方案已长期保存，可在“继续之前的建站”中继续');
      } else {
        if (planned?.planId === planId) setDirty(true);
        setRuns(current => current.map(item => item.id === planId ? { ...item, expiresAt: result.expiresAt, savedPlan: undefined, companyName: undefined } : item));
        message.success('已移出长期保存');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '方案保存状态未确认，请稍后重试');
    } finally {
      lock.current = false; setBusy('');
    }
  }
  async function createPlan() {
    if (!admin || lock.current) return;
    try { await form.validateFields(); } catch { return; }
    if (!provider?.enabled) { aiSettings.open(); return; }
    lock.current = true; setBusy('plan'); setError('');
    try {
      await runtime.flush();
      const envelope = runtime.getEnvelope(), selected = selectedProductIds.filter(id => envelope.state.products.some(product => product.id === id));
      // 已删除的优先产品需要用户重新核对，避免无提示切回旧产品范围。
      if (selected.length !== selectedProductIds.length) throw new Error('本批优先产品已有删除或变化，请先恢复默认产品范围，或重新导入并核对后再生成。');
      const result = await request<Planned>('/api/ai/build/plan', { method: 'POST', body: JSON.stringify({ brief, expectedRevision: envelope.revision, ...(selected.length ? { selectedProductIds: selected } : {}) }) });
      setPlanned(result); setDirectionId(result.plan.directions[0]?.id || ''); setPreview(undefined); setRestoredRun(undefined); setRunNotice(''); setStep(1); setDirty(true); journey?.onBuildRun(result.planId);
      message.success('整站方案已生成，请核对内容并选择设计方向');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '生成未完成，资料输入仍保留。'); }
    finally { lock.current = false; setBusy(''); }
  }
  async function savePlanRevision(pages: AiSitePagePlan[]) {
    if (!planned || lock.current) return;
    lock.current = true;
    setBusy('revise');
    setError('');
    try {
      const result = await request<AiBuildPlanRun>('/api/ai/build/plan/revise', {
        method: 'POST', body: JSON.stringify({ planId: planned.planId, pages }),
      });
      setPlanEditorOpen(false);
      if (result.planId === planned.planId) return;
      // 采用仍只读已核对的冻结预览。手改完成后，当前界面须重新生成此版本的真实预览。
      setPlanned(result);
      setPreview(undefined);
      setPreviewOpen(false);
      setRestoredRun(undefined);
      setRunNotice(result.savedPlan ? '长期方案已更新。重新生成预览后继续检查。' : '方案修改已保存。请选择方向并重新生成页面预览。');
      setStep(1);
      const unsavedOptions = result.savedPlan?.directionId !== directionId || result.savedPlan?.prefix !== prefix;
      if (!unsavedOptions) guard.clear();
      setDirty(unsavedOptions);
      journey?.onBuildRun(result.planId);
    } finally {
      lock.current = false;
      setBusy('');
    }
  }
  async function createPreview(selectedDirectionId = directionId, openPreview = false) {
    if (!admin || lock.current || !planned || !selectedDirectionId) return;
    // 过期重建也从已有方案开始；请求失败时继续显示原方案和修改入口。
    lock.current = true; setBusy('preview'); setError(''); setPreview(undefined); setDirectionId(selectedDirectionId); setStep(1);
    if (planned.savedPlan && planned.savedPlan.directionId !== selectedDirectionId) setDirty(true);
    try {
      await runtime.flush();
      const result = await request<Preview>('/api/ai/build/preview', { method: 'POST', body: JSON.stringify({ planId: planned.planId, directionId: selectedDirectionId, prefix }) });
      setPreview({ ...result, directionId: selectedDirectionId }); setPreviewPath(initialPreviewPath(result.pages,prefix)); setRestoredRun(undefined); setRunNotice(''); setStep(2); journey?.onBuildRun(result.previewId);
      if (openPreview) { setDevice('desktop'); setPreviewOpen(true); }
      message.success('页面已生成并完成基础检查，尚未写入网站草稿');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '预览未完成，方案仍保留。'); }
    finally { lock.current = false; setBusy(''); }
  }
  async function apply() {
    if (!admin || lock.current || !preview || previewOutdated) return;
    if (preview.expiresAt && Date.parse(preview.expiresAt) <= Date.now()) { setExpiredPreviewId(preview.previewId); return; }
    lock.current = true; setBusy('apply'); setError('');
    try {
      await runtime.mutate(() => request<StudioEnvelope>('/api/ai/build/apply', { method: 'POST', body: JSON.stringify({ previewId: preview.previewId, expectedRevision: preview.baseRevision }) }));
      setApplyConfirmOpen(false);
      clearLocalRecovery(runtime.actor.id, 'ai-site-builder'); setDirty(false); guard.resolve();
      const ids=preview.pages.map(page=>page.id).filter(id=>runtime.getEnvelope().state.pages.some(page=>page.id===id));
      // 模型可任意排序页面；首次编辑优先真实普通页，不把动态模板当成完成网站。
      const pageId = preview.pages.find(page=>ids.includes(page.id)&&!page.slug.includes(':'))?.id;
      if(!pageId){message.info('保存回执已确认，但本次普通页面已不存在，请检查最新网站页面。');navigate(journey?.session.active?'site-journey':'pages');return;}
      journey?.onApplied(ids);await update({ activePageId: pageId });
      message.success('已保存为可拖拽编辑的草稿，请核对后再发布'); navigate('editor');
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 410) { setExpiredPreviewId(preview.previewId); setApplyConfirmOpen(false); }
      else setError(cause instanceof Error ? cause.message : '保存结果尚未确认，请保留方案并读取最新工作区。');
    }
    finally { lock.current = false; setBusy(''); }
  }
  async function refresh() {
    if (lock.current) return;
    lock.current = true; setBusy('refresh');
    try { await readFreshStudio(runtime); setPreview(undefined); setStep(planned ? 1 : 0); setError(''); message.info('已读取最新工作区，资料和方案保留，请重新检查页面。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '工作区读取失败'); }
    finally { lock.current = false; setBusy(''); }
  }
  const previewUrl = preview && previewPath ? `/preview/~ai/${preview.previewId}${previewPath === '/' ? '' : previewPath}` : '';
  const previewFocus = focusedPreview && focusedPreview.previewId === preview?.previewId && focusedPreview.path === previewPath ? focusedPreview : undefined;
  const iframeUrl = previewFocus ? `${previewUrl}#locate=${encodeURIComponent(previewFocus.nodeId)}` : previewUrl;
  function openCheckedPage(path: string, issue?: AiBuildCheckLocation) {
    // 候选只在隔离预览标记节点；进入真实画布仍要明确保存建站草稿。
    setFocusedPreview(preview && issue ? { ...issue, previewId: preview.previewId } : undefined);
    setLoadedPreview(undefined); setPreviewPath(path); setDevice('mobile'); setPreviewOpen(true);
  }
  const previewDirection = planned?.plan.directions.find(direction => direction.id === preview?.directionId);
  const loadedCurrent=loadedPreview&&preview&&loadedPreview.id===preview.previewId?loadedPreview:undefined;
  const loadedPage=loadedCurrent&&preview?.inspection?matchAiInspectionPage(preview.inspection,loadedCurrent.path):undefined;
  const nativePreviewLabel=loadedCurrent&&loadedCurrent.width>0?`${loadedPage?.title||loadedCurrent.path} · ${loadedCurrent.width}px`:'等待当前页面';
  const appliedRun = restoredRun?.kind === 'preview' && restoredRun.appliedRevision !== null ? restoredRun : undefined;
  const previewExpired=!!preview&&(expiredPreviewId===preview.previewId||!!preview.expiresAt&&Date.parse(preview.expiresAt)<=Date.now());
  const previewOutdated=!!preview&&(previewExpired||preview.baseRevision!==runtime.envelope.revision||restoredRun?.kind==='preview'&&restoredRun.previewId===preview.previewId&&restoredRun.baseRevision!==restoredRun.currentRevision);
  if (!admin) return <Alert type="info" showIcon title="请管理员配置和使用 AI 快速建站" description="整站生成涉及模型服务、网站结构和 SEO 设置。管理员保存草稿后，你仍可按现有权限查看或编辑页面。" />;
  const savedOptions = planned?.savedPlan;
  const currentOptionsSaved = !!savedOptions && savedOptions.directionId === directionId && savedOptions.prefix === prefix;
  const retainPlanButton = planned && <Button icon={currentOptionsSaved ? <CheckCircleOutlined /> : <SaveOutlined />} loading={busy === 'retention'} disabled={!!busy || !directionId || currentOptionsSaved} onClick={() => void changePlanRetention(planned.planId, true)}>{currentOptionsSaved ? '方案已长期保存' : savedOptions ? '保存本次设计选项' : '长期保存方案'}</Button>;
  return <div className="ai-site-builder">{guard.dialog}
    <Card className="ai-builder-intro" styles={{ body: { padding: 24 } }}><Flex justify="space-between" gap={20} align="center" wrap><div><Tag color="blue">企业资料 → 设计与 SEO → 可编辑网站</Tag><Title level={4}>把你的企业资料，变成自己的外贸网站</Title><Paragraph type="secondary">可以先导入公司PDF和产品Excel，也可以直接填写业务资料。选择设计方向、检查并保存为草稿后，布局、文字、图片和手机端样式仍可自由拖拽修改。</Paragraph></div><Space wrap><Button disabled={!!busy || importBusy} onClick={() => setSourceOpen(true)}>导入PDF / Excel</Button><Button disabled={!!busy || importBusy} onClick={() => setWritingReuseOpen(true)}>使用共用企业资料</Button><Button icon={<DownloadOutlined />} disabled={!!busy || importBusy} onClick={download}>保留资料与方案</Button><Button disabled={!!busy || importBusy} onClick={() => void readRuns()}>继续之前的建站</Button></Space></Flex></Card>
    <Card className="ai-builder-connection" styles={{ body: { padding: 20 } }}><Flex justify="space-between" align="center" gap={16} wrap><div><Space wrap><Text strong>全站 AI 服务</Text><Tag color={provider?.enabled ? 'green' : 'default'}>{providerLoading ? '正在读取' : !provider ? '读取失败' : provider.enabled ? '已启用' : '未启用'}</Tag></Space><Text type="secondary" className="ai-builder-help">{providerLoading ? '正在读取已保存的AI配置，不会测试连接或调用模型。' : !provider ? '配置读取失败，当前无法判断是否已配置。请先重新读取。' : provider.enabled ? `模型：${provider.model} · ${provider.baseUrl}` : '在站点设置中统一配置服务，建站、资料整理、局部修改和SEO共用。'}</Text></div><Button icon={<SettingOutlined />} disabled={!!busy || importBusy} onClick={aiSettings.open}>AI服务设置</Button></Flex>{providerError && <Alert type="error" showIcon title={providerError} action={<Button disabled={!!busy || providerLoading} onClick={() => void readProvider()}>重新读取AI配置</Button>} />}</Card>
    <Steps className="ai-builder-steps" current={step} responsive items={[{ title: '填写企业资料' }, { title: '确认整站方案' }, { title: '检查并保存' }]} />
    {runNotice && <Alert type={restoredRun && restoredRun.baseRevision !== restoredRun.currentRevision && !(restoredRun.kind === 'preview' && restoredRun.appliedRevision !== null) ? 'warning' : 'info'} showIcon title={runNotice}  />}
    {previewOutdated && <Alert type="warning" showIcon title={previewExpired ? '这份网站预览已过期' : '这份预览已不能直接采用'} description={previewExpired ? planned ? '可从同一份有效方案重新生成预览，无需调用 AI。' : '请从「继续之前的建站」读取有效的长期方案，再生成页面预览。' : '工作区已有修改。读取最新工作区后请重新生成页面预览。'} action={previewExpired ? <Button disabled={!!busy} onClick={() => planned ? void createPreview() : void readRuns()}>{planned ? '重新生成页面预览' : '继续之前的建站'}</Button> : <Button disabled={!!busy} loading={busy === 'refresh'} onClick={refresh}>读取最新工作区</Button>} />}
    {recovered && !restoredRun && step === 0 && <Alert type="info" showIcon title="已恢复建站资料" description="恢复只保留输入。需要重新生成方案、检查页面，再明确保存为草稿。" />}
    {error && <Alert type="error" showIcon title={error} description="当前资料和已生成的方案仍保留。请求不会自动重试。" action={<Button size="small" disabled={!!busy} loading={busy === 'refresh'} onClick={refresh}>读取最新工作区</Button>} />}
    {appliedRun && <Card title="本次建站记录" className="ai-builder-panel" styles={{ body: { padding: 24 } }}><Space orientation="vertical" size={16} style={{ width: '100%' }}><Flex gap={8} wrap><Tag color={appliedRun.undoneRevision != null ? 'default' : 'green'}>{appliedRun.undoneRevision != null ? '已撤销' : '已保存为草稿'}</Tag><Text type="secondary">回执保留至{new Date(appliedRun.expiresAt).toLocaleString()}</Text></Flex><Paragraph>本次包含{appliedRun.pages.length}个页面。保存后仍可用原编辑器修改；撤销会检查本次内容及其引用，后续手改冲突时会停止并说明原因。</Paragraph>{!appliedRun.canUndo && <Alert type="info" showIcon title={appliedRun.undoReason || '当前记录不可直接撤销，请重新读取后核对。'} />}<Flex gap={12} wrap>{appliedRun.undoneRevision == null && <Button icon={<EditOutlined />} disabled={!!busy} onClick={() => void editAppliedRun()}>编辑已保存页面</Button>}<Button danger icon={<UndoOutlined />} disabled={!!busy || !appliedRun.canUndo} onClick={() => { setError(''); setUndoConfirmOpen(true); }}>撤销本次建站</Button><Button disabled={!!busy} onClick={() => void restoreRun(appliedRun.previewId)}>重新读取撤销状态</Button><Button disabled={!!busy} onClick={reset}>填写另一套资料</Button></Flex></Space></Card>}
    {step === 0 && !appliedRun && <Card title="先介绍你的企业" className="ai-builder-panel" styles={{ body: { padding: 24 } }}><Form form={form} layout="vertical" disabled={!!busy} initialValues={brief}>
      <Row gutter={[24, 0]}><Col xs={24} md={12}><Form.Item name="companyName" label="公司或品牌名称" rules={[{ required: true, whitespace: true, min: 2, max: 120, message: '请填写2～120字的公司或品牌名称' }]}><Input aria-label="AI建站公司名称" value={brief.companyName} maxLength={120} onChange={event => changeBrief({ companyName: event.target.value })} /></Form.Item></Col><Col xs={24} md={12}><Form.Item name="industry" label="所属行业与主要业务" rules={[{ required: true, whitespace: true, max: 300, message: '请填写所属行业和主要业务' }]}><Input aria-label="AI建站所属行业" value={brief.industry} maxLength={300} placeholder="例如：工业零件制造、企业咨询、家居品牌" onChange={event => changeBrief({ industry: event.target.value })} /></Form.Item></Col></Row>
      <Form.Item name="description" label="业务说明与建站目标" rules={[{ required: true, whitespace: true, min: 10, max: 6000, message: '请填写10～6000字的真实业务说明' }]} extra="说明你提供的产品或服务、希望客户看完后做什么、必须保留和不能编造的内容。服务公司可以没有产品，缺少的事实请注明待核对。"><Input.TextArea aria-label="AI建站业务说明" value={brief.description} maxLength={6000} showCount rows={6} placeholder="例如：提供三项咨询服务，希望客户预约沟通；不放商品目录，也没有已授权的客户案例。" onChange={event => changeBrief({ description: event.target.value })} /></Form.Item>
      <Row gutter={[24, 0]}><Col xs={24} md={12}><Form.Item name="audience" label="主要面向哪些客户" rules={[{ required: true, whitespace: true, max: 300, message: '请填写主要客户群体' }]}><Input aria-label="AI建站目标买家" value={brief.audience} maxLength={300} placeholder="例如：海外经销商、工程采购商" onChange={event => changeBrief({ audience: event.target.value })} /></Form.Item></Col><Col xs={24} md={12}><Form.Item name="market" label="重点市场" rules={[{ required: true, whitespace: true, max: 300, message: '请填写重点国家或地区' }]}><Input aria-label="AI建站重点市场" value={brief.market} maxLength={300} placeholder="例如：英国、德国；或全球市场" onChange={event => changeBrief({ market: event.target.value })} /></Form.Item></Col></Row>
      <Row gutter={[24, 0]}><Col xs={24} md={8}><Form.Item name="language" label="网站语言" extra="首版使用本站默认语言；其他语言请先到现有语言管理中设置。"><Input aria-label="AI建站语言" value={brief.language} readOnly /></Form.Item></Col><Col xs={24} md={16}><Form.Item name="styleNotes" label="设计偏好（选填）" extra="可以描述想要的感觉、信息重点、喜欢的颜色，以及希望避开的设计。"><Input aria-label="AI建站设计偏好" value={brief.styleNotes} maxLength={2000} placeholder="例如：克制、专业，多展示实拍，避免大面积深色" onChange={event => changeBrief({ styleNotes: event.target.value })} /></Form.Item></Col></Row>
      <Alert type="info" showIcon title="生成时会发送哪些资料？" description={`发送以上已确认的资料，以及最多20个现有产品的标识、名称、型号、说明、分类和材质，及最多12张图片的标识、说明和尺寸，供所配置的 AI 服务规划网站。当前工作区有 ${state.products.length} 个产品、${state.media.filter(item => item.kind === 'image').length} 张图片。导入文件原文不会随整站生成自动发送；PDF整理只在导入窗口明确点击后发送所选页文字。不发送图片文件、产品扩展字段、询盘、成员账号或密码；API 密钥只作为连接凭据，不进入建站提示词。`} />
      {!!selectedProductIds.length && <Alert type="info" showIcon title={`优先使用本批导入的${selectedProductIds.filter(id => state.products.some(product => product.id === id)).length}个产品参与规划`} description="最多20个产品参与模型规划；完整产品目录仍使用实际产品记录。只在浏览器恢复中保留这些产品标识，不保存文件原文。" action={<Button size="small" onClick={() => { setSelectedProductIds([]); setPlanned(undefined); setPreview(undefined); setDirty(true); }}>恢复默认产品范围</Button>} />}
      <Flex className="ai-builder-actions" justify="space-between" align="center" gap={16} wrap><Text type="secondary">生成使用你配置的模型额度；耗时取决于服务响应。</Text><Button type="primary" icon={<ThunderboltOutlined />} loading={busy === 'plan'} disabled={!!busy || !provider?.enabled} onClick={createPlan}>生成整站方案 <ArrowRightOutlined /></Button></Flex>
    </Form></Card>}
    {step === 1 && planned && <>
      <Alert type="info" showIcon title={planned.savedPlan ? '这份方案已长期保存' : '临时方案在40分钟内有效'} description={planned.savedPlan ? '下次打开“继续之前的建站”，可用同一方案编辑或重新预览。每次页面预览仍在40分钟内有效。' : '需要稍后继续，可长期保存当前方案。修改方案和重新生成预览无需再次调用 AI。'} />
      <PlanIntent plan={planned.plan} />
      <Card title="整站内容与 SEO 规划" className="ai-builder-panel" styles={{ body: { padding: 24 } }}>
        <Flex gap={8} wrap style={{ marginBottom: 16 }}><Button disabled={!!busy} icon={<EditOutlined />} onClick={() => setPlanEditorOpen(true)}>修改页面、文案和按钮</Button><Button type="text" disabled={!!busy} onClick={() => setStep(0)}>修改资料</Button></Flex>
        <Paragraph>{planned.plan.summary}</Paragraph><Collapse items={planned.plan.pages.map(page => ({ key: page.key, label: <Flex justify="space-between" gap={12} wrap><Text strong>{page.title}</Text><Text code>{page.path}</Text></Flex>, children: <Descriptions column={1} size="small" items={[{ key: 'purpose', label: '页面作用', children: page.purpose }, { key: 'seoTitle', label: '搜索标题', children: page.seoTitle }, { key: 'seoDescription', label: '搜索说明', children: page.seoDescription }, { key: 'sections', label: '内容分区', children: page.sections.map(section => section.heading).join(' / ') }]} /> }))} /><Text type="secondary" className="ai-builder-help">这是基于所提供资料的内容建议，不包含实测搜索量或搜索排名承诺。保存前请核对每项业务描述。</Text>
      </Card>
      <div><Flex className="ai-builder-section-heading" justify="space-between" gap={12} align="center" wrap><Title level={4}>选择一个设计方向</Title><Text type="secondary">先核对将生成的真实结构，再打开页面比较；切换方向与预览不调用模型。</Text></Flex><Row gutter={[24, 24]}>{planned.plan.directions.map((direction,index) => <Col xs={24} lg={8} key={direction.id}><DirectionCard direction={direction} index={index} inspection={directionInspections.find(item=>item.id===direction.id)?.inspection} problem={directionInspections.find(item=>item.id===direction.id)?.problem} selected={directionId === direction.id} disabled={!!busy} onSelect={() => { setDirectionId(direction.id); setDirty(!savedOptions || savedOptions.directionId !== direction.id || savedOptions.prefix !== prefix); setPreview(undefined); }} onPreview={() => void createPreview(direction.id, true)} /></Col>)}</Row></div>
      <Card className="ai-builder-panel" title="生成到哪里" styles={{ body: { padding: 24 } }}><Form layout="vertical"><Form.Item label="新页面的网址前缀" htmlFor="ai-site-path-prefix" extra="首次安装的原始空首页默认使用根目录，留空即可；已有网站默认 /ai-site，例如 /ai-site/about。与已维护页面冲突时会停止并提示。"><Input id="ai-site-path-prefix" aria-label="AI建站网址前缀" value={prefix} maxLength={64} disabled={!!busy} placeholder="留空使用根目录，或填写 /ai-site" onChange={event => { setPrefix(event.target.value); setDirty(!savedOptions || savedOptions.directionId !== directionId || savedOptions.prefix !== event.target.value); setPreview(undefined); }} /></Form.Item></Form><Text type="secondary">保留当前产品、素材和已有内容；首次空站可复用原始Home。需要补充的站点名称等变更会在检查结果中说明，确认后才保存。</Text><Flex className="ai-builder-actions" justify="space-between" gap={12} wrap><Button icon={<ArrowLeftOutlined />} disabled={!!busy} onClick={() => setStep(0)}>返回资料</Button><Flex gap={8} wrap>{retainPlanButton}<Button type="primary" disabled={!!busy || !directionId} loading={busy === 'preview'} onClick={() => void createPreview()}>生成页面并检查 <ArrowRightOutlined /></Button></Flex></Flex></Card>
    </>}
    {step === 2 && preview && <Card className="ai-builder-panel" title="检查生成结果" styles={{ body: { padding: 24 } }} extra={<Tag color="blue">尚未保存为草稿</Tag>}>
      <Space orientation="vertical" size={20} style={{ width: '100%' }}>
        <Alert type="success" showIcon title={`已准备 ${preview.pages.length} 个可编辑页面`} description="此处展示生成后的页面与基础检查结果。业务事实、外语表达、图片适用性仍需核对；预览在40分钟内有效。保存草稿后可继续拖拽调整，公开网站需另外发布。" />
        <div className="ai-builder-pages">{preview.pages.map(page => <Flex key={page.id} justify="space-between" gap={12} wrap><Text strong>{page.title}</Text><Text code>{page.slug}</Text></Flex>)}</div>
        <Flex gap={12} wrap><Button icon={<EyeOutlined />} disabled={!previewUrl} onClick={() => { setFocusedPreview(undefined); setDevice('desktop'); setPreviewOpen(true); }}>预览生成网站</Button>{planned && <Button disabled={!!busy} icon={<EditOutlined />} onClick={() => setPlanEditorOpen(true)}>继续修改方案</Button>}{retainPlanButton}<Button icon={<DownloadOutlined />} onClick={download}>下载资料与方案</Button></Flex>
        <AiBuildSiteCheck key={preview.previewId} previewId={preview.previewId} pages={preview.pages} disabled={!!busy} onOpenPage={path => openCheckedPage(path)} onLocate={issue => openCheckedPage(issue.path, issue)} />
        {preview.warnings.map((warning, index) => <Alert key={`warning-${index}`} type="warning" showIcon title={warning} />)}
        <Collapse items={[{ key: 'seo', label: `SEO 基础检查 · ${preview.seoIssues.length ? `${preview.seoIssues.length} 项待核对` : '未发现所检查项目中的问题'}`, children: preview.seoIssues.length ? <Space orientation="vertical" style={{ width: '100%' }}>{preview.seoIssues.map((issue, index) => <Alert key={`${issue.code}-${index}`} type="warning" showIcon title={issue.message} description={issue.path} />)}</Space> : <Paragraph type="secondary">未发现当前规则可识别的问题。此结果不代表搜索引擎已收录、排名提升或完整的性能验收。</Paragraph> }]} />
        <Flex justify="space-between" gap={12} wrap><Button disabled={!!busy || !planned} icon={<ArrowLeftOutlined />} onClick={() => { setPreview(undefined); setStep(1); }}>返回调整方向</Button><Button type="primary" icon={<EditOutlined />} disabled={!!busy || previewOutdated} onClick={() => { setError(''); setApplyConfirmOpen(true); }}>保存为草稿并拖拽编辑</Button></Flex>
      </Space>
    </Card>}
    {!!busy && <Alert type="info" showIcon title={busy === 'plan' ? '正在等待你的 AI 服务生成整站方案…' : busy === 'revise' || busy === 'retention' ? '正在保存方案…' : busy === 'preview' ? '正在生成页面并进行基础检查…' : busy === 'apply' ? '正在保存草稿…' : busy === 'undo' ? '正在检查并撤销本次建站…' : '正在读取工作区…'} description="请等待本次结果；系统不会自动重试模型请求。" />}
    {planned && planEditorOpen && <AiBuildPlanEditor key={planned.planId} planId={planned.planId} actorId={runtime.actor.id} plan={planned.plan} brief={brief} imageIds={new Set(state.media.filter(item => item.kind === 'image').map(item => item.id))} saving={busy === 'revise'} onSave={savePlanRevision} onClose={() => setPlanEditorOpen(false)} />}
    <Modal open={applyConfirmOpen && !!preview} title="确认保存本次建站草稿？" onCancel={() => { if (!busy) setApplyConfirmOpen(false); }} closable={!busy} maskClosable={!busy} footer={<Space wrap><Button disabled={!!busy} onClick={() => setApplyConfirmOpen(false)}>返回检查</Button><Button type="primary" loading={busy === 'apply'} disabled={!!busy || previewOutdated} onClick={() => void apply()}>确认保存建站草稿</Button></Space>}><Space orientation="vertical" size={16} style={{ width: '100%' }}><Paragraph>将保存这份预览中的{preview?.pages.length || 0}个页面及检查结果中列明的站点资料，随后进入原拖拽编辑器。</Paragraph><List size="small" dataSource={preview?.pages || []} renderItem={page => <List.Item><Flex gap={12} wrap><Text>{page.title}</Text><Text code>{page.slug}</Text></Flex></List.Item>} /><Alert type="info" showIcon title="保存后仍需单独确认发布" description="采用后7天内，可在“继续之前的建站”读取本次记录并申请撤销。若本次内容被后续修改或产生新引用，系统会停止危险撤销并说明原因。" />{error && <Alert type="error" showIcon title={error} />}</Space></Modal>
    <Modal open={undoConfirmOpen && !!appliedRun} title="撤销本次建站草稿？" onCancel={() => { if (!busy) setUndoConfirmOpen(false); }} closable={!busy} maskClosable={!busy} footer={<Space wrap><Button disabled={!!busy} onClick={() => setUndoConfirmOpen(false)}>保留当前草稿</Button><Button danger loading={busy === 'undo'} disabled={!!busy || !appliedRun?.canUndo} onClick={() => void undoBuild()}>确认撤销本次建站</Button></Space>}><Space orientation="vertical" size={16} style={{ width: '100%' }}><Paragraph>撤回本次创建或修改的页面与站点资料。系统会重新检查当前内容和引用；其他页面、产品及公开版本保持当前状态。</Paragraph><List size="small" dataSource={appliedRun?.pages || []} renderItem={page => <List.Item><Flex gap={12} wrap><Text>{page.title}</Text><Text code>{page.slug}</Text></Flex></List.Item>} /><Alert type="warning" showIcon title="后续手改冲突时会停止撤销" description="若页面或资源已被继续编辑或被新增内容引用，请先核对，系统不会用旧整站覆盖当前网站。" />{error && <Alert type="error" showIcon title={error} />}</Space></Modal>
    <AiSourceImport open={sourceOpen} onClose={() => setSourceOpen(false)} onRequestOpen={() => setSourceOpen(true)} brief={brief} onApplyBrief={value => { changeBrief(value); setStep(0); }} onProductsImported={ids => { setSelectedProductIds(ids.slice(0, 20)); setPlanned(undefined); setPreview(undefined); setRestoredRun(undefined); setRunNotice(''); setStep(0); setDirty(true); }} providerEnabled={!!provider?.enabled} onConfigureAi={aiSettings.open} onBusyChange={setImportBusy} />
    <AiWritingBriefReuse open={writingReuseOpen} onClose={() => setWritingReuseOpen(false)} brief={brief} onApply={value => { changeBrief(value); setStep(0); message.success('共用资料已填入本次表单，请核对后继续；尚未调用AI。'); }} />
    <Modal open={runsOpen} title="继续之前的建站" width={720} style={{ maxWidth: 'calc(100vw - 24px)' }} onCancel={() => { if (!busy) setRunsOpen(false); }} closable={!busy} maskClosable={!busy} footer={<Button disabled={!!busy} onClick={() => setRunsOpen(false)}>返回建站</Button>}>
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        <Alert type="info" showIcon title="读取不会调用AI，也不会采用或发布" description="长期方案可继续修改。页面预览按各自的有效期和草稿版本核对。" />
        {error && <Alert type="error" showIcon title={error} />}
        <List loading={busy === 'runs' || busy === 'restore'} dataSource={runs} locale={{ emptyText: '暂无本人有效记录。可以先填写资料并生成方案。' }} renderItem={item => (
          <List.Item>
            <Flex justify="space-between" align="start" gap={12} wrap style={{ width: '100%', minWidth: 0 }}>
              <Space orientation="vertical" size={3} style={{ minWidth: 0 }}>
                <Space wrap>
                  <Text strong style={{ overflowWrap: 'anywhere' }}>{item.companyName || (item.kind === 'plan' ? item.manuallyEdited ? '修改后的建站方案' : '网站内容与设计方案' : '网站页面预览')}</Text>
                  {item.savedPlan && <Tag color="blue">长期方案</Tag>}
                  {item.appliedRevision !== null && <Tag color={item.undoneRevision != null ? 'default' : 'green'}>{item.undoneRevision != null ? '已撤销' : '已保存过'}</Tag>}
                </Space>
                <Text type="secondary">{item.savedPlan ? `上次保存 ${new Date(item.savedPlan.savedAt).toLocaleString()}` : `有效至${new Date(item.expiresAt).toLocaleString()}`}{item.pages ? ` · ${item.pages.length}个页面` : ''}</Text>
                {item.baseRevision !== runtime.envelope.revision && <Text type="secondary">{item.savedPlan ? '重新生成预览会使用最新草稿。' : '工作区可能已有新修改，读取后需要重新核对。'}</Text>}
              </Space>
              <Space wrap>
                <Button disabled={!!busy} onClick={() => guard.ask(() => void restoreRun(item.id))}>{item.kind === 'plan' ? '读取方案' : item.appliedRevision !== null ? '查看已保存记录' : '读取预览'}</Button>
                {item.savedPlan && <Popconfirm title="从长期方案中移出？" description="方案接下来还能读取40分钟。" okText="移出长期保存" cancelText="取消" onConfirm={() => changePlanRetention(item.id, false)}><Button type="text" disabled={!!busy}>移出长期保存</Button></Popconfirm>}
              </Space>
            </Flex>
          </List.Item>
        )} />
      </Space>
    </Modal>
    <Modal className="ai-builder-preview-modal" open={previewOpen && !!preview} width="calc(100vw - 48px)" style={{ top: 24, maxWidth: 1600 }} title="生成网站的私有预览" onCancel={() => setPreviewOpen(false)} destroyOnHidden footer={<Flex justify="space-between" gap={12} wrap><Text type="secondary">预览不会保存或发布。产品详情使用真实产品；已有详情设计保持，新增模板需明确应用。</Text><Button onClick={() => setPreviewOpen(false)}>关闭预览</Button></Flex>}>
      {previewDirection && <Paragraph type="secondary">正在查看：{previewDirection.name} · {AI_SITE_LAYOUT_LABELS[previewDirection.layout]}。这是本次方向编译后的真实原生页面，保存后仍可自由编辑。</Paragraph>}
      <Flex className="ai-builder-preview-toolbar" justify="space-between" gap={12} wrap><Select aria-label="AI网站预览页面" value={loadedCurrent&&preview?.pages.some(page=>page.slug===loadedCurrent.path)?loadedCurrent.path:previewPath} onChange={value=>{setFocusedPreview(undefined);setLoadedPreview(undefined);setPreviewPath(value);}} style={{ width: 260, maxWidth: '100%' }} options={preview?.pages.filter(page => !page.slug.includes(':')).map(page => ({ label: page.title, value: page.slug }))} /><Segmented aria-label="AI网站预览尺寸" value={device} onChange={value => setDevice(String(value))} options={[{ value: 'desktop', label: '桌面', icon: <DesktopOutlined /> }, { value: 'mobile', label: '手机', icon: <MobileOutlined /> }]} /><Button href={iframeUrl} target="_blank" rel="noopener noreferrer" icon={<ExportOutlined />}>单独打开</Button></Flex>
      <Collapse size="small" items={[{key:"native-layout",label:`原生布局核对 · ${nativePreviewLabel}`,children:loadedCurrent&&loadedCurrent.width>0?<AiBuildPageFacts inspection={preview?.inspection} path={loadedCurrent.path} device={aiLayoutDeviceForWidth(loadedCurrent.width)}/>:<Text type="secondary">页面加载后，按当前页面和实际视口宽度显示对应核对信息。</Text>}]} /><div className="ai-builder-preview-stage">{previewUrl && <iframe key={previewFocus?.nodeId || "main"} ref={previewFrame} onLoad={previewLoaded} title="AI生成网站预览" src={iframeUrl} referrerPolicy="no-referrer" style={{ width: device === 'mobile' ? previewFocus?.viewportWidth || 390 : '100%', maxWidth: '100%' }} />}</div>
    </Modal>
  </div>;
}
