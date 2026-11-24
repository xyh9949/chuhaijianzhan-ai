'use client';
import LocalRecoveryPanel from '@/components/LocalRecoveryPanel';
import McpOAuthConsent from '@/components/McpOAuthConsent';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Alert, App, Avatar, Badge, Breadcrumb, Button, Checkbox, ConfigProvider, Drawer, Dropdown, Empty, Flex, Input, Menu, Modal, Space, Spin, Tooltip } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {
  ArrowRightOutlined, BellOutlined, CloudUploadOutlined,
  DownOutlined, EditOutlined, EyeOutlined, FileTextOutlined,
  HomeOutlined, LayoutOutlined,
  MenuOutlined, MessageOutlined, PictureOutlined, PlusOutlined,
  QuestionCircleOutlined, SearchOutlined, SettingOutlined,
  ShoppingOutlined, SlidersOutlined, UserOutlined,
} from '@ant-design/icons';
import { request, RequestError, StudioContext, useStudioStore, type ClientActor, type StudioEnvelope } from '@/lib/studio-client';
import PublishDialog from '@/components/PublishDialog';
import ServerReleases from '@/components/ServerReleases';
import { AccountSecurity } from '@/components/MemberManager';
import { adminTheme, sidebarTheme } from '@/lib/admin-theme';
import { consumeEditorEntryTarget, readEditorPreviewOrigin, readEditorTarget, type EditorPreviewOrigin, type EditorTarget } from '@/lib/editor-preview';
import { forgetEditorCanvasHistory } from '@/lib/editor-canvas-history';
import type { Screen, ScreenProps, StudioState } from '@/lib/types';
import ContentModelsScreen from '@/components/ContentModelsScreen';
import GlobalDesignScreen from '@/components/GlobalDesignScreen';
import ExternalContentReview from '@/components/ExternalContentReview';
import OverviewScreen from '@/components/OverviewScreen';
import SeoWorkspace from '@/components/SeoWorkspace';
import { AiSettingsProvider } from '@/components/AiProviderSettings';
import { DesignGuidanceProvider } from '@/components/DesignGuidanceProvider';
import SiteJourney, { SiteJourneyReturn } from '@/components/SiteJourney';
import { SITE_JOURNEY_STEPS, loadSiteJourney, saveSiteJourney, deriveSiteJourneyFacts, type SiteJourneySession, type SiteJourneyIntent, type SiteJourneyStep, type SiteJourneyBridge } from '@/lib/site-journey';
import PagesScreen from '@/components/PagesScreen';
import { ProductsScreen, MediaScreen, InquiriesScreen } from '@/components/ContentScreens';
import { TemplatesScreen, ThemeScreen, SettingsScreen } from '@/components/SystemScreens';
import { LoginScreen, SetupScreen } from '@/components/AccessScreens';
import AccountRecovery, { consumeAccountRecoveryLocation, type AccountRecoveryEntry } from '@/components/AccountRecovery';
import '@/components/shell.css';

const EditorScreen = dynamic(() => import('@/components/EditorScreen').then((module) => module.EditorScreen), { ssr: false, loading: () => <div className="shell-loading"><Spin /><span>正在准备创作画布…</span></div> });
const PreviewScreen = dynamic(() => import('@/components/EditorScreen').then((module) => module.PreviewScreen), { ssr: false, loading: () => <div className="shell-loading"><Spin /><span>正在生成页面预览…</span></div> });
const HISTORY_KEY = '__formStudioNavigation';
const screenNames: Record<Screen, string> = { overview: '工作台', 'site-journey': '建站流程', pages: '网站页面', products: '产品管理', media: '素材中心', inquiries: '客户询盘', templates: '模板与区块', theme: '全站样式', 'global-design': '全站设计', 'content-models': '内容管理', 'ai-content-review': 'AI内容审核', releases: '发布管理', seo: '搜索优化', settings: '站点设置', editor: '页面编辑器', preview: '网站预览', login: '登录界面', setup: '手工创建草稿' };
type HistoryEntry = { session: string; index: number; url: string; screen: Screen; editorTarget?: { ownerId: string; target: EditorTarget }; editorPreview?: { ownerId: string; origin: EditorPreviewOrigin } };
type HistoryTraversal = { source: HistoryEntry; target: HistoryEntry; phase: 'restoring' | 'waiting' | 'replaying'; approved: boolean; attempt: number };

function readHistoryEntry(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = (value as Record<string, unknown>)[HISTORY_KEY] as Partial<HistoryEntry> | undefined;
  if (!entry || typeof entry.session !== 'string' || !Number.isSafeInteger(entry.index) || typeof entry.url !== 'string' || typeof entry.screen !== 'string' || !Object.hasOwn(screenNames, entry.screen)) return null;
  const origin = entry.screen === 'preview' && readEditorPreviewOrigin(entry.editorPreview?.origin);
  const target = entry.screen === 'editor' && readEditorTarget(entry.editorTarget?.target);
  return { session: entry.session, index: entry.index!, url: entry.url, screen: entry.screen, ...(origin && typeof entry.editorPreview?.ownerId === 'string' ? { editorPreview: { ownerId: entry.editorPreview.ownerId, origin } } : {}), ...(target && typeof entry.editorTarget?.ownerId === 'string' ? { editorTarget: { ownerId: entry.editorTarget.ownerId, target } } : {}) };
}

export default function Home() {
  // Ant 主题沿 React 上下文传入 body 浮层；后台根类不添加到客户网站所在的 body。
  // 抽屉通过Ant原生配置统一标题与正文的对齐线；窄屏跟随后台留白变量。
  return <ConfigProvider locale={zhCN} theme={adminTheme} drawer={{className:'admin-app',styles:{header:{padding:'16px var(--admin-panel-space,24px)'},body:{padding:'var(--admin-panel-space,24px)'},footer:{padding:'12px var(--admin-panel-space,24px)'}}}}><App className="admin-app"><AuthenticatedStudio /></App></ConfigProvider>;
}

function AuthenticatedStudio() {
  const [session, setSession] = useState<ClientActor | null>(null);
  const [initial, setInitial] = useState<StudioEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<AccountRecoveryEntry>();
  const [recoveryReady, setRecoveryReady] = useState(false);
  const loadEpoch = useRef(0);
  const recoveryLocation = useRef<{ entry: AccountRecoveryEntry | undefined } | null>(null);
  const load = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    setLoading(true); setError('');
    try {
      const result = await request<{user: ClientActor} | null>('/api/auth/get-session');
      if (epoch !== loadEpoch.current) return;
      if (!result?.user) { setSession(null); setInitial(null); return; }
      const data = await request<StudioEnvelope>('/api/studio');
      if (epoch !== loadEpoch.current) return;
      setSession(result.user); setInitial(data);
    } catch (error) { if (epoch === loadEpoch.current) { if (error instanceof RequestError && error.status === 401) setSession(null); else setError((error as Error).message); } }
    finally { if (epoch === loadEpoch.current) setLoading(false); }
  }, []);
  useEffect(() => {
    // 邮件链接优先于会话读取，已登录成员也能重置；令牌不进入普通工作区或后续请求的referrer。
    // 开发模式可能重复挂载effect；敏感地址已清除后仍沿用第一次读取，不能误进已登录后台。
    if (!recoveryLocation.current) recoveryLocation.current = { entry: consumeAccountRecoveryLocation() };
    const entry = recoveryLocation.current.entry; setRecovery(entry); setRecoveryReady(true);
    if (!entry) void load();
    const receive = () => {
      const next = consumeAccountRecoveryLocation(); if (!next) return;
      const proceed = () => { loadEpoch.current++; setRecovery(next); };
      const event = new CustomEvent('form-studio:before-navigate', { cancelable: true, detail: { target: 'account-recovery', proceed } });
      if (window.dispatchEvent(event)) proceed();
    };
    window.addEventListener('popstate', receive); window.addEventListener('hashchange', receive);
    return () => { window.removeEventListener('popstate', receive); window.removeEventListener('hashchange', receive); };
  }, [load]);
  useEffect(() => {
    const expired = () => { setSession(null); setInitial(null); };
    window.addEventListener('form-studio:session-expired', expired);
    return () => window.removeEventListener('form-studio:session-expired', expired);
  }, []);
  if (!recoveryReady) return <div className="shell-loading"><Spin /><span>正在准备登录入口…</span></div>;
  if (recovery) return <AccountRecovery key={recovery.mode === 'reset' ? recovery.token || 'invalid-reset' : 'forgot'} entry={recovery} onForgot={() => setRecovery({ mode: 'forgot' })} onBack={() => { loadEpoch.current++; setRecovery(undefined); setSession(null); setInitial(null); setLoading(false); setError(''); }} />;
  if (loading) return <div className="shell-loading"><Spin /><span>正在验证登录状态…</span></div>;
  if (error) return <div className="shell-loading"><Alert type="error" title="无法打开工作区" description={error} /><Button onClick={load}>重试</Button></div>;
  if (!session || !initial) return <LoginScreen onLoggedIn={load} onForgotPassword={() => setRecovery({ mode: 'forgot' })} />;
  return <Studio key={session.id} actor={session} initial={initial} onLoggedOut={() => { setSession(null); setInitial(null); }} />;
}

function Studio({ actor, initial, onLoggedOut }: { actor: ClientActor; initial: StudioEnvelope; onLoggedOut: () => void }) {
  const { state, update, runtime } = useStudioStore(initial, actor);
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<Screen>('overview');
  const screenRef = useRef<Screen>('overview');
  const navigationController = useRef<(next: Screen, onCommitted?: () => void, previewOrigin?: EditorPreviewOrigin, editorTarget?: EditorTarget) => void>(() => {});
  const updatePreviewContext = useRef<(changes: Partial<Pick<EditorPreviewOrigin, 'width' | 'referencePath'>>) => void>(() => {});
  const [editorTarget, setEditorTarget] = useState<EditorTarget>();
  const [editorPreview, setEditorPreview] = useState<EditorPreviewOrigin>();
  const editorDeviceWidth = useRef<number | undefined>(undefined);
  const [workspaceReloadVersion, setWorkspaceReloadVersion] = useState(0);
  const workspaceReload = useRef({ version: 0, pending: false });
  const getStudioState = useRef(runtime.getEnvelope);
  getStudioState.current = runtime.getEnvelope;
  const [journeySession, setJourneySession] = useState<SiteJourneySession>(() => loadSiteJourney(actor.id));
  const [journeyIntent, setJourneyIntent] = useState<SiteJourneyIntent>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const { message, modal } = App.useApp();
  useEffect(() => { saveSiteJourney(actor.id, journeySession); }, [actor.id, journeySession]);

  const commitScreen = useCallback((next: Screen) => {
    if ((actor.role !== 'admin' && ['settings', 'setup', 'seo', 'site-journey', 'ai-content-review'].includes(next)) || (actor.role === 'viewer' && next === 'editor')) next = 'overview';
    // 只在导航保护真正放行后记录位置，取消离开不会提前切换流程或打开目标弹层。
    const accepted = next;
    // 等待配置读取时也可能离开；未消费意图只属于目标页，不能在日后返回时意外重开。
    setJourneyIntent(value => value && accepted !== (value.action === 'ai-edit' ? 'editor' : 'templates') ? undefined : value);
    setJourneySession(value => value.active && accepted === 'editor' ? { ...value, step: 'edit' } : value.active && accepted === 'seo' ? { ...value, step: 'seo' } : value.active && accepted === 'releases' ? { ...value, step: 'publish' } : accepted === 'site-journey' ? { ...value, active: true } : value);
    screenRef.current = next;
    setScreen(next);
    setSidebarOpen(false);
    window.scrollTo({ top: 0 });
  }, [actor.role]);
  const navigate = useCallback((next: Screen) => {
    if (['settings', 'setup', 'seo', 'site-journey', 'ai-content-review'].includes(next) && actor.role !== 'admin') { message.warning('此功能需要管理员权限'); return; }
    if (next === 'editor' && actor.role === 'viewer') { message.info('当前账号只有查看权限，请使用草稿预览'); return; }
    navigationController.current(next);
  }, [actor.role, message]);
  async function logout() {
    // 代码和产品表单可能有尚未提交的本地输入，退出登录也使用统一离开保护。
    const proceed = async () => { try { await runtime.flush(); await request('/api/auth/sign-out', { method: 'POST', body: '{}' }); onLoggedOut(); } catch(error) { message.error((error as Error).message); } };
    const event = new CustomEvent('form-studio:before-navigate', { cancelable: true, detail: { target: 'login', proceed } });
    if (window.dispatchEvent(event)) await proceed();
  }
  async function previewSite() {
    // 顶部预览也先处理代码表单本地输入，不能只 flush 已进入保存队列的字段。
    const proceed = async () => {
      const target = window.open('about:blank', '_blank');
      if (target) target.opener = null;
      try { await runtime.flush(); if (target) target.location.href = '/preview'; else window.location.href = '/preview'; }
      catch (error) { target?.close(); message.error((error as Error).message); }
    };
    const event = new CustomEvent('form-studio:before-navigate', { cancelable: true, detail: { target: 'preview', proceed } });
    if (window.dispatchEvent(event)) await proceed();
  }
  function exportUnsaved() { const url = URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'})); const link=document.createElement('a'); link.href=url; link.download='form-studio-unsaved.json'; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
  const canSaveCanvas = useCallback(() => !workspaceReload.current.pending && workspaceReload.current.version === workspaceReloadVersion, [workspaceReloadVersion]);
  async function reloadWorkspace() {
    const reload = workspaceReload.current;
    if (reload.pending) return;
    // 以旧画布锁定→读取服务器→重挂编辑器的顺序处理。读取失败时保留原画布供导出。
    reload.pending = true;
    try {
      await runtime.refresh();
      if (editorTarget) forgetEditorCanvasHistory(actor.id, `${editorTarget.kind}:${editorTarget.id}`);
      reload.version += 1;
      setWorkspaceReloadVersion(reload.version);
    } finally {
      reload.pending = false;
    }
  }


  useEffect(() => {
    const initialScreen = location.hash.slice(1) as Screen;
    const requested = Object.hasOwn(screenNames, initialScreen) && initialScreen !== 'login' ? initialScreen : 'overview';
    const first = (actor.role !== 'admin' && ['settings','setup','seo','site-journey','ai-content-review'].includes(requested)) || (actor.role === 'viewer' && requested === 'editor') ? 'overview' : requested;
    screenRef.current = first;
    setScreen(first);
    if (first === 'site-journey') setJourneySession(value => ({ ...value, active: true }));
    setReady(true);
    let alive = true;
    let attempt = 0;
    let pending: HistoryTraversal | null = null;
    let queuedNavigation: (() => void) | null = null;
    const existing = readHistoryEntry(window.history.state);
    let current: HistoryEntry = existing?.url === location.href ? { ...existing, screen: first } : { session: crypto.randomUUID(), index: 0, url: location.href, screen: first };
    function attachEditorTarget(entry: HistoryEntry) {
      if (entry.screen !== 'editor' || actor.role === 'viewer' || entry.editorTarget?.ownerId === actor.id) return entry;
      return { ...entry, editorTarget: { ownerId: actor.id, target: consumeEditorEntryTarget(getStudioState.current().state, actor.id) } };
    }
    current = attachEditorTarget(current);
    setEditorTarget(current.editorTarget?.ownerId === actor.id ? current.editorTarget.target : undefined);
    setEditorPreview(current.editorPreview?.ownerId === actor.id ? current.editorPreview.origin : undefined);
    let stateSnapshot: Record<string, unknown> = {};
    const signature = (entry: HistoryEntry) => `${entry.session}:${entry.index}:${entry.url}`;
    let observed = signature(current);

    function writeEntry(entry: HistoryEntry, mode: 'push' | 'replace') {
      const liveState = window.history.state;
      // 只增加命名空间元数据；Next 的路由树、__NA 等已有键按原值保留。
      const merged = { ...stateSnapshot, ...(liveState && typeof liveState === 'object' ? liveState : {}), [HISTORY_KEY]: entry };
      if (mode === 'push') window.history.pushState(merged, '', entry.url);
      else window.history.replaceState(merged, '', entry.url);
      stateSnapshot = window.history.state;
    }
    writeEntry(current, 'replace');

    function accept(entry: HistoryEntry) {
      const previous = current;
      current = attachEditorTarget(entry);
      if (current !== entry) writeEntry(current, 'replace');
      observed = signature(entry);
      stateSnapshot = window.history.state;
      // 只给当前历史条目的编辑对象。其他标签保存的 activePageId 仅用作旧链接默认值。
      const target = current.editorTarget?.ownerId === actor.id ? current.editorTarget.target : undefined;
      setEditorTarget(target);
      setEditorPreview(entry.editorPreview?.ownerId === actor.id ? entry.editorPreview.origin : undefined);
      if (entry.screen === 'editor' && previous.screen === 'preview' && previous.editorPreview?.ownerId === actor.id) editorDeviceWidth.current = previous.editorPreview.origin.width;
      if (target?.kind === 'page' && getStudioState.current().state.pages.some(page => page.id === target.id)) void update({ activePageId: target.id });
      commitScreen(entry.screen);
    }
    function drainQueue() {
      const next = queuedNavigation;
      queuedNavigation = null;
      next?.();
    }
    function replay(traversal: HistoryTraversal) {
      if (!alive || pending !== traversal || traversal.phase !== 'waiting') return;
      traversal.phase = 'replaying';
      window.history.go(traversal.target.index - traversal.source.index);
    }
    function navigateTo(next: Screen, onCommitted?: () => void, previewOrigin?: EditorPreviewOrigin, target?: EditorTarget) {
      // history.go 是异步操作；补偿或重放未落定时，新的界面导航等待游标稳定。
      if (pending && pending.phase !== 'waiting') { queuedNavigation = () => navigateTo(next, onCommitted, previewOrigin, target); return; }
      pending = null;
      const token = ++attempt;
      let committed = false;
      const proceed = () => {
        if (!alive || token !== attempt || committed) return;
        committed = true;
        onCommitted?.();
        const url = new URL(window.location.href);
        url.hash = next;
        // 显式入口也消费旧目标，以免被取消的旧导航残留到下一次打开编辑器。
        const legacyTarget = next === 'editor' && actor.role !== 'viewer' ? consumeEditorEntryTarget(getStudioState.current().state, actor.id) : undefined;
        const editorTarget = legacyTarget ? { ownerId: actor.id, target: target || legacyTarget } : undefined;
        const editorPreview = next === 'preview' && previewOrigin ? { ownerId: actor.id, origin: previewOrigin } : undefined;
        // 即便 #editor 地址相同，切换页面仍是不同历史条目；后退可准确回到前一对象。
        if (url.href !== current.url || JSON.stringify(editorTarget) !== JSON.stringify(current.editorTarget) || JSON.stringify(editorPreview) !== JSON.stringify(current.editorPreview)) {
          const entry = { ...current, index: current.index + 1, url: url.href, screen: next, editorTarget, editorPreview };
          writeEntry(entry, 'push');
          accept(entry);
        } else commitScreen(next);
      };
      const event = new CustomEvent('form-studio:before-navigate', { cancelable: true, detail: { target: next, proceed } });
      if (window.dispatchEvent(event)) proceed();
    }
    navigationController.current = navigateTo;
    updatePreviewContext.current = changes => {
      if (current.screen !== 'preview' || current.editorPreview?.ownerId !== actor.id) return;
      const origin = readEditorPreviewOrigin({ ...current.editorPreview.origin, ...changes });
      if (!origin) return;
      // 设备与引用页同属当前预览条目，调整只更新该条目，不新增后退步骤或写入草稿。
      current = { ...current, editorPreview: { ownerId: actor.id, origin } };
      writeEntry(current, 'replace');
      setEditorPreview(origin);
    };

    function syncHistory() {
      if (!alive) return;
      const href = window.location.href;
      let target = readHistoryEntry(window.history.state);
      if (!target || target.session !== current.session || target.url !== href) {
        // 直接修改 hash 会新增浏览器条目；立即补索引，不依赖它是否也触发 popstate。
        const hash = location.hash.slice(1) as Screen;
        target = { ...current, index: current.index + 1, url: href, screen: Object.hasOwn(screenNames, hash) ? hash : !hash ? 'overview' : current.screen, editorTarget: undefined, editorPreview: undefined };
        writeEntry(target, 'replace');
      }
      const key = signature(target);
      // 同一次历史遍历通常先 popstate 后 hashchange；按条目去重，禁止二次确认。
      if (key === observed) return;
      observed = key;

      if (pending?.phase === 'restoring') {
        if (target.index !== pending.source.index) return;
        pending.phase = 'waiting';
        stateSnapshot = window.history.state;
        if (queuedNavigation) { pending = null; ++attempt; drainQueue(); }
        else if (pending.approved) replay(pending);
        return;
      }
      if (pending?.phase === 'replaying' && target.index === pending.target.index) {
        pending = null;
        accept(target);
        drainQueue();
        return;
      }
      pending = null;
      const token = ++attempt;
      if (target.screen === screenRef.current && JSON.stringify(target.editorTarget) === JSON.stringify(current.editorTarget) && JSON.stringify(target.editorPreview) === JSON.stringify(current.editorPreview)) { accept(target); return; }
      const traversal: HistoryTraversal = { source: current, target, phase: 'restoring', approved: false, attempt: token };
      let deciding = true;
      const proceed = () => {
        if (!alive || token !== attempt || traversal.approved) return;
        traversal.approved = true;
        // 用户先点批准也只排队；等补偿回原条目，再重放一次原始 delta。
        if (!deciding && pending === traversal && traversal.phase === 'waiting') replay(traversal);
      };
      const event = new CustomEvent('form-studio:before-navigate', { cancelable: true, detail: { target: target.screen, proceed } });
      const allowed = window.dispatchEvent(event);
      deciding = false;
      if (allowed || traversal.approved) { accept(target); return; }
      pending = traversal;
      // 取消只恢复真实历史游标，绝不改写被访问的目标条目；未批准就不提交页面切换。
      window.history.go(current.index - target.index);
    }
    window.addEventListener('popstate', syncHistory);
    window.addEventListener('hashchange', syncHistory);
    return () => {
      alive = false;
      navigationController.current = () => {};
      updatePreviewContext.current = () => {};
      window.removeEventListener('popstate', syncHistory);
      window.removeEventListener('hashchange', syncHistory);
    };
  }, [message, commitScreen, actor.id, actor.role, update]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen((open) => !open); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const journey: SiteJourneyBridge | undefined = actor.role === 'admin' ? {
    session: journeySession, intent: journeyIntent,
    consumeIntent: id => setJourneyIntent(value => value?.id === id ? undefined : value),
    onBuildRun: id => setJourneySession(value => ({ ...value, runId: id, ...(value.active ? { step: 'generate' as const } : {}) })),
    onApplied: ids => {
      const editable = deriveSiteJourneyFacts(runtime.getEnvelope().state).editablePages;
      const pageId = ids.find(id => editable.some(page => page.id === id));
      setJourneySession(value => ({ ...value, ...(value.active ? { step: 'edit' as const } : {}), ...(pageId ? { pageId } : {}) }));
    },
  } : undefined;
  const props: ScreenProps = { state, update, navigate, journey };
  const openEditor = (target: EditorTarget) => {
    if (actor.role === 'viewer') return;
    navigationController.current('editor', undefined, undefined, target);
  };
  function navigateJourney(next: Screen, step: SiteJourneyStep, action?: SiteJourneyIntent['action'], runId?: string) {
    if (actor.role !== 'admin') return;
    navigationController.current(next, () => {
      setJourneySession(value => ({ ...value, active: true, step }));
      setJourneyIntent(action ? { id: crypto.randomUUID(), action, ...(runId ? { runId } : {}) } : undefined);
    });
  }
  async function openJourneyPage(id: string, preview = false, ai = false) {
    if (!deriveSiteJourneyFacts(state).editablePages.some(page => page.id === id)) { message.warning('所选页面已变化，请重新选择'); return; }
    try {
      // 活动页面沿用原本机选择语义；清理上次同步区块/卡片入口，打开的是用户选择的真实页面。
      await update({ activePageId: id });
      const target: EditorTarget = { kind: 'page', id };
      navigationController.current(preview ? 'preview' : 'editor', () => {
        setJourneySession(value => ({ ...value, active: true, step: 'edit' }));
        setJourneyIntent(ai ? { id: crypto.randomUUID(), action: 'ai-edit' } : undefined);
      }, preview ? { ...target, width: window.matchMedia('(max-width: 767px)').matches ? 390 : 1280 } : undefined, target);
    } catch (error) { message.error(error instanceof Error ? error.message : '页面未打开，当前资料已保留'); }
  }
  const drafts = state.pages.filter((page) => page.status === 'draft');
  const newInquiries = state.inquiries.filter((inquiry) => inquiry.status === 'new').length;
  function openPublish() { if(actor.role !== 'admin') { message.warning('只有管理员可以发布网站'); return; } setPublishOpen(true); }

  const navigation = [
    { type: 'group' as const, label: '工作空间', children: [
      { key: 'overview', icon: <HomeOutlined />, label: '工作台' },
      ...(actor.role === 'admin' ? [{ key: 'site-journey', icon: <LayoutOutlined />, label: '建站流程' }] : []),
      { key: 'pages', icon: <FileTextOutlined />, label: '网站页面' },
      { key: 'products', icon: <ShoppingOutlined />, label: '产品管理' },
      { key: 'content-models', icon: <LayoutOutlined />, label: '内容管理' },
      { key: 'media', icon: <PictureOutlined />, label: '素材中心' },
      { key: 'inquiries', icon: <MessageOutlined />, label: <span className="shell-nav-label">客户询盘 {newInquiries > 0 && <Badge count={newInquiries} overflowCount={99} />}</span> },
    ] },
    { type: 'group' as const, label: '站点运营', children: [
      { key: 'templates', icon: <LayoutOutlined />, label: '模板与区块' },
      { key: 'theme', icon: <SlidersOutlined />, label: '全站样式' },
      { key: 'global-design', icon: <LayoutOutlined />, label: '全站设计' },
      { key: 'releases', icon: <CloudUploadOutlined />, label: '发布管理' },
      ...(actor.role === 'admin' ? [{ key: 'seo', icon: <SearchOutlined />, label: '搜索优化' }] : []),
      ...(actor.role === 'admin' ? [{ key: 'settings', icon: <SettingOutlined />, label: '站点设置' }] : []),
    ] },
  ];
  const workspaceMenu = {
    items: [
      ...(actor.role === 'admin' ? [{ key: 'settings', label: '站点设置', icon: <SettingOutlined /> }, { key: 'setup', label: '创建网站草稿', icon: <PlusOutlined /> }] : []),
      { key: 'account', label: '账号安全', icon: <UserOutlined /> },
      { key: 'logout', label: '退出登录' },
    ],
    onClick: ({ key }: { key: string }) => key === 'logout' ? void logout() : key === 'account' ? setAccountOpen(true) : navigate(key as Screen),
  };
  const sidebar = <ConfigProvider theme={sidebarTheme}><div className="shell-sidebar-content flex h-full min-h-0 flex-col">
    <Button type="text" className="shell-brand" onClick={() => navigate('overview')} aria-label="Form Studio 工作台"><span className="shell-brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span>Form Studio</span></Button>
    {/* 点击Wave会插入临时首节点；文字布局使用具名容器，不依赖子节点位置。 */}
    <Dropdown trigger={['click']} menu={workspaceMenu}><Button className="shell-current-site"><Flex component="span" vertical gap={5} className="shell-site-copy"><strong className="shell-site-name" title={state.settings.name || '未命名站点'}>{state.settings.name || '未命名站点'}</strong><span className="shell-site-domain" title={state.settings.domain || '尚未设置域名'}>{state.settings.domain || '尚未设置域名'}</span></Flex><DownOutlined className="shell-site-chevron" /></Button></Dropdown>
    <Menu className="shell-nav-menu" theme="dark" mode="inline" selectedKeys={[screen]} items={navigation} onClick={({ key }) => navigate(key as Screen)} />
    <div className="shell-sidebar-bottom mt-auto">
      <Button type="text" className="shell-help" icon={<QuestionCircleOutlined />} onClick={() => setHelpOpen(true)}>帮助与说明</Button>
      <Dropdown trigger={['click']} menu={workspaceMenu}><Button type="text" className="shell-user"><Avatar size={36} icon={<UserOutlined />} /><Flex component="span" vertical gap={3} className="shell-user-copy"><strong className="shell-user-name" title={actor.name}>{actor.name}</strong><span className="shell-user-role">{actor.role === 'admin' ? '管理员' : actor.role === 'editor' ? '内容编辑' : '只读成员'}</span></Flex><DownOutlined className="shell-user-chevron" /></Button></Dropdown>
    </div>
  </div></ConfigProvider>;

  const searchResults = [
    ...Object.entries(screenNames).filter(([key]) => !['editor', 'preview', 'login', 'ai-content-review', ...(actor.role !== 'admin' ? ['settings','setup','seo','site-journey'] : [])].includes(key)).map(([key, title]) => ({ title, description: '功能页面', action: () => navigate(key as Screen) })),
    ...state.pages.map((page) => ({ title: page.title, description: `网站页面 · ${page.slug}`, action: () => openEditor({ kind: 'page', id: page.id }) })),
  ].filter((item) => (item.title + item.description).toLowerCase().includes(query.toLowerCase()));
  const fullWorkspace = ['setup', 'editor', 'preview'].includes(screen);

  if (!ready) return <div className="shell-loading"><Spin /><span>正在打开工作空间…</span></div>;
  return <StudioContext.Provider value={runtime}><AiSettingsProvider><DesignGuidanceProvider><McpOAuthConsent/>
    {runtime.saveState === 'error' && <Alert className="shell-sync-error" classNames={{ section: 'shell-sync-copy', actions: 'shell-sync-actions' }} type="error" title="工作区同步未完成" description={runtime.error} action={<Space wrap><Button size="small" onClick={() => runtime.retry().catch(e => message.error(e.message))}>重试保存</Button><Button size="small" onClick={exportUnsaved}>导出当前草稿</Button><Button size="small" onClick={() => modal.confirm({ title: '重新加载服务器版本？', content: '当前未保存的修改会被替换，请先导出需要保留的草稿。', onOk: reloadWorkspace })}>重新加载</Button></Space>} />}
    {!fullWorkspace && <a className="shell-skip-link" href="#main-content" onClick={event => {
      // 后台 hash 用于当前页面路由。通过焦点进入主内容，不占用历史条目。
      event.preventDefault(); const main = document.getElementById('main-content');
      main?.focus({ preventScroll: true }); main?.scrollIntoView({ block: 'start' });
    }}>跳到主要内容</a>}
    {screen === 'setup' ? <SetupScreen {...props} /> : screen === 'editor' && editorTarget ? <EditorScreen {...props} key={workspaceReloadVersion} target={editorTarget} onTargetChange={openEditor} canSaveCanvas={canSaveCanvas} preferredPreviewWidth={editorDeviceWidth.current} onPreview={origin => navigationController.current('preview', () => { editorDeviceWidth.current = origin.width; }, origin)} /> : screen === 'preview' ? <PreviewScreen {...props} editorPreview={editorPreview} onWidthChange={width => updatePreviewContext.current({ width })} onReferenceChange={referencePath => updatePreviewContext.current({ referencePath })} onReturnToEditor={(target, width) => navigationController.current(actor.role === 'viewer' ? 'pages' : 'editor', () => { editorDeviceWidth.current = width; }, undefined, target)} /> : <div className="shell-layout min-h-dvh">
      <aside className="shell-sidebar fixed inset-y-0 left-0 z-40 hidden w-[232px] flex-col lg:flex" aria-label="主导航">{sidebar}</aside>
      <Drawer title="工作空间" rootClassName="admin-app shell-mobile-drawer" styles={{body:{padding:0}}} classNames={{ body: 'shell-mobile-body', section: 'shell-mobile-section', close: 'shell-mobile-close' }} placement="left" open={sidebarOpen} onClose={() => setSidebarOpen(false)} size={272}>{sidebar}</Drawer>
      <div className="shell-main min-h-dvh min-w-0 lg:ml-[232px]">
        <header className="shell-topbar sticky top-0 z-30 flex h-16 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3"><Button className="shell-mobile-menu lg:hidden!" aria-label="打开主导航" type="text" icon={<MenuOutlined />} onClick={() => setSidebarOpen(true)} /><Breadcrumb items={[{ title: '工作空间' }, { title: screenNames[screen] }]} /></div>
          <div className="shell-topbar-actions flex items-center gap-3"><span className="shell-save-status" role="status">{runtime.saveState === 'saved' ? '已保存' : runtime.saveState === 'error' ? '保存失败' : '保存中…'}</span><Button aria-label="草稿预览" icon={<EyeOutlined />} onClick={() => { void previewSite(); }}><span className="shell-preview-text">草稿预览</span></Button>
            <Button className="shell-search-trigger" aria-label="搜索工作空间" onClick={() => setSearchOpen(true)}><SearchOutlined /><span>搜索工作空间</span><kbd>Ctrl K</kbd></Button>
            <Tooltip title="工作区待办"><Badge dot={drafts.length > 0 || newInquiries > 0}><Button aria-label="查看工作区待办" type="text" icon={<BellOutlined />} onClick={() => setNoticeOpen(true)} /></Badge></Tooltip>
            <Tooltip title="帮助与说明"><Button aria-label="帮助与说明" type="text" icon={<QuestionCircleOutlined />} onClick={() => setHelpOpen(true)} /></Tooltip>
            <Dropdown trigger={['click']} menu={workspaceMenu}><Button type="text" className="shell-topbar-account" aria-label="打开工作区菜单"><Avatar size={30} icon={<UserOutlined />} /><DownOutlined /></Button></Dropdown>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} style={{ scrollMarginTop: 64 }} className="shell-page mx-auto w-full max-w-[1720px]">
          <LocalRecoveryPanel actorId={actor.id} onResume={(scope,target)=>{if(scope==='publish-scope'){setPublishOpen(true);}else navigate(target);requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent('form-studio:recover-local',{detail:{scope}})));}} />
          {journeySession.active && actor.role === 'admin' && ['templates','pages','products','media','content-models','settings','seo','releases','theme','global-design'].includes(screen) && <SiteJourneyReturn step={journeySession.step} onReturn={() => navigateJourney('site-journey', journeySession.step)} onNext={() => navigateJourney('site-journey', SITE_JOURNEY_STEPS[Math.min(4, SITE_JOURNEY_STEPS.findIndex(item => item.key === journeySession.step) + 1)].key)} />}
          <ConfigProvider componentDisabled={actor.role === 'viewer'}>{screen === 'overview' && <OverviewScreen {...props} onPublish={openPublish} onShowNotices={() => setNoticeOpen(true)} />}
          {screen === 'site-journey' && actor.role === 'admin' && <SiteJourney {...props} onStep={step => setJourneySession(value => ({ ...value, active: true, step }))} onTask={(action, runId) => navigateJourney('templates', journeySession.step === 'materials' && action !== 'resume' && action !== 'examples' ? 'materials' : 'generate', action, runId)} onScreen={(target, step) => navigateJourney(target, step || journeySession.step)} onSelectPage={pageId => setJourneySession(value => ({ ...value, pageId }))} onEdit={(id, ai) => void openJourneyPage(id, false, ai)} onPreview={id => void openJourneyPage(id, true)} onPublish={openPublish} onPause={() => navigationController.current('overview', () => { setJourneySession(value => ({ ...value, active: false })); setJourneyIntent(undefined); })} />}
          {screen === 'pages' && <PagesScreen {...props} onEdit={id => openEditor({ kind: 'page', id })} />}
          {screen === 'products' && <ProductsScreen {...props} />}
          {screen === 'content-models' && <ContentModelsScreen {...props} />}
          {screen === 'media' && <MediaScreen {...props} />}
          {screen === 'inquiries' && <InquiriesScreen {...props} />}
          {screen === 'templates' && <TemplatesScreen {...props} />}
          {screen === 'theme' && <ThemeScreen {...props} />}
          {screen === 'global-design' && <GlobalDesignScreen {...props} />}
          {screen === 'ai-content-review' && <ExternalContentReview {...props} />}
          {screen === 'seo' && actor.role === 'admin' && <SeoWorkspace {...props} />}
          {screen === 'releases' && <ServerReleases onPublish={openPublish} />}
          {screen === 'settings' && actor.role === 'admin' && <SettingsScreen {...props} />}</ConfigProvider>
          <footer className="shell-footer flex flex-wrap items-center justify-between gap-2"><span>Form Studio</span><span>修改先保存，发布后客户才能看到</span></footer>
        </main>
      </div>
    </div>}

    <Modal rootClassName="admin-app shell-modal" open={searchOpen} footer={null} title="搜索工作空间" onCancel={() => setSearchOpen(false)} destroyOnHidden>
      <Input autoFocus size="large" prefix={<SearchOutlined />} placeholder="搜索功能或页面名称…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="工作空间搜索" />
      <div className="shell-command-list">{searchResults.length ? searchResults.map((result, index) => <Button type="text" key={index} onClick={() => { result.action(); setSearchOpen(false); setQuery(''); }}><FileTextOutlined /><span><strong>{result.title}</strong><span>{result.description}</span></span><ArrowRightOutlined /></Button>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的页面" />}</div>
    </Modal>
    <Modal rootClassName="admin-app shell-modal" open={helpOpen} title="使用 Form Studio" onCancel={() => setHelpOpen(false)} footer={<Button type="primary" onClick={() => setHelpOpen(false)}>知道了</Button>}>
      <div className="shell-help-content"><p>在这里编辑页面、管理产品与素材。内容保存在本实例数据库中，登录权限由服务器验证。</p>
        <div className="shell-help-step"><span>01</span><div><strong>编辑页面内容</strong><p>进入网站页面，打开已有页面或新建空白页，在画布中调整内容。</p></div></div>
        <div className="shell-help-step"><span>02</span><div><strong>管理设计与资料</strong><p>产品和素材集中维护。全站样式只控制客户网站，模板与区块当前创建独立草稿。</p></div></div>
        <div className="shell-help-step"><span>03</span><div><strong>检查并发布网站</strong><p>选择页面、产品及样式，检查范围后发布到本实例的公开网站。外部域名和邮件发送需要另行配置。</p></div></div>
        <p className="shell-help-caption">快捷搜索：Ctrl / ⌘ + K。演示图片来自 Unsplash，品牌与业务数据为示例。</p>
      </div>
    </Modal>
    <Drawer rootClassName="admin-app shell-notice-drawer" title="工作区待办" open={noticeOpen} onClose={() => setNoticeOpen(false)}>
      <div className="shell-notification-item"><span className="shell-notice-icon"><EditOutlined /></span><div><strong>{drafts.length} 个页面有未发布更改</strong><p>查看当前草稿，再选择需要生成版本的页面。</p><Button type="link" onClick={() => { navigate('pages'); setNoticeOpen(false); }}>查看页面 <ArrowRightOutlined /></Button></div></div>
      <div className="shell-notification-item"><span className="shell-notice-icon"><MessageOutlined /></span><div><strong>{newInquiries} 条询盘待处理</strong><p>集中查看客户需求及感兴趣的产品。</p><Button type="link" onClick={() => { navigate('inquiries'); setNoticeOpen(false); }}>查看询盘 <ArrowRightOutlined /></Button></div></div>
      <p className="shell-notice-caption">数量来自本实例数据库。当前未接入自动邮件通知。</p>
    </Drawer>
    {publishOpen && <PublishDialog onClose={() => setPublishOpen(false)} onPublished={() => navigate('releases')} onRepair={(target,pageId)=>{setPublishOpen(false);if(pageId)openEditor({kind:'page',id:pageId});else navigate(target);}} />}
    <Modal title="账号安全" open={accountOpen} footer={null} onCancel={() => setAccountOpen(false)} destroyOnHidden><AccountSecurity /></Modal>
  </DesignGuidanceProvider></AiSettingsProvider></StudioContext.Provider>;
}
