'use client';

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, App, Button, Card, Checkbox, Collapse, Drawer, Flex, Form, Grid, Input, Space, Spin, Tag, Typography } from 'antd';
import { request, useStudioRuntime } from '@/lib/studio-client';

const { Paragraph, Text } = Typography;
export type AiProvider = { revision: number; enabled: boolean; baseUrl: string; model: string; visionModel?: string; hasApiKey: boolean; allowLocal: boolean };
export type Provider = AiProvider;
type Draft = Pick<AiProvider, 'enabled' | 'baseUrl' | 'model' | 'allowLocal'> & { visionModel: string; apiKey: string; clearApiKey: boolean };
type Controls = { open: () => void; changeVersion: number };
type Guard = { needed: () => boolean; ask: (next: () => void) => void };
type Context = Controls & { saved: () => void; registerGuard: (guard: Guard) => () => void };
const AiSettingsContext = createContext<Context | null>(null);
const emptyDraft: Draft = { enabled: false, baseUrl: '', model: '', visionModel: '', allowLocal: false, apiKey: '', clearApiKey: false };
const asDraft = (value: AiProvider): Draft => ({ enabled: value.enabled, baseUrl: value.baseUrl, model: value.model, visionModel: value.visionModel || '', allowLocal: value.allowLocal, apiKey: '', clearApiKey: false });

/** 配置归站点设置统一管理；业务入口使用同一抽屉，下面的资料、方案与画布始终保持挂载。 */
export function AiSettingsProvider({ children }: { children: ReactNode }) {
  const { actor } = useStudioRuntime(), { message } = App.useApp();
  const [opened, setOpened] = useState(false), [drawerBusy, setDrawerBusy] = useState(false), [changeVersion, setChangeVersion] = useState(0);
  const guards = useRef(new Map<symbol, Guard>()), openedRef = useRef(opened); openedRef.current = opened;
  const registerGuard = useCallback((guard: Guard) => { const id = Symbol(); guards.current.set(id, guard); return () => { guards.current.delete(id); }; }, []);
  const saved = useCallback(() => setChangeVersion(value => value + 1), []);
  const open = useCallback(() => { if (actor.role !== 'admin') { message.warning('AI服务配置需要管理员权限'); return; } setOpened(true); }, [actor.role, message]);
  function close() {
    const guard = [...guards.current.values()].at(-1);
    if (guard) guard.ask(() => setOpened(false)); else setOpened(false);
  }
  useLayoutEffect(() => {
    // 在业务模块的普通effect之前登记：先确认上层密钥输入，再把原导航交回原有业务保护。
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: string; proceed?: () => void }>).detail;
      if (event.defaultPrevented || !detail?.proceed) return;
      const guard = [...guards.current.values()].reverse().find(item => item.needed());
      if (!guard) { if (openedRef.current) setOpened(false); return; }
      event.preventDefault(); event.stopImmediatePropagation();
      guard.ask(() => {
        if (openedRef.current) setOpened(false);
        const retry = new CustomEvent('form-studio:before-navigate', { cancelable: true, detail });
        if (window.dispatchEvent(retry)) detail.proceed!();
      });
    };
    window.addEventListener('form-studio:before-navigate', navigate, true);
    return () => window.removeEventListener('form-studio:before-navigate', navigate, true);
  }, []);
  const context = useMemo(() => ({ open, changeVersion, saved, registerGuard }), [open, changeVersion, saved, registerGuard]);
  return <AiSettingsContext.Provider value={context}>{children}<Drawer title="站点设置 · AI服务" open={opened} onClose={close} zIndex={1200} size="min(680px, 100vw)" closable={!drawerBusy} keyboard={!drawerBusy} mask={{ closable: !drawerBusy }} destroyOnHidden styles={{ body: { padding: 20 } }}>{opened && <AiProviderSettings inDrawer onBusyChange={setDrawerBusy} onClose={close} />}</Drawer></AiSettingsContext.Provider>;
}

export function useAiSettings(): Controls {
  const value = useContext(AiSettingsContext);
  if (!value) throw new Error('AI服务设置尚未加载');
  return value;
}

/** 密钥只在本表单内存短暂保留；离开时明确放弃，不登记任何本地恢复或浏览器存储。 */
export default function AiProviderSettings({ inDrawer = false, onBusyChange, onClose }: { inDrawer?: boolean; onBusyChange?: (busy: boolean) => void; onClose?: () => void } = {}) {
  const { actor } = useStudioRuntime(), { message, modal } = App.useApp(), settings = useContext(AiSettingsContext), screens = Grid.useBreakpoint(), id = useId();
  const [value, setValue] = useState<AiProvider>(), [draft, setDraft] = useState<Draft>(emptyDraft), [revision, setRevision] = useState<number>();
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | 'reload' | ''>('load'), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const lock = useRef(false), mounted = useRef(false), sequence = useRef(0), confirm = useRef<{ destroy: () => void } | undefined>(undefined);
  const changed = !!value && (draft.enabled !== value.enabled || draft.baseUrl !== value.baseUrl || draft.model !== value.model || draft.visionModel !== (value.visionModel || '') || draft.allowLocal !== value.allowLocal || !!draft.apiKey || draft.clearApiKey);
  const latest = useRef({ changed, busy: !!busy, value }); latest.current = { changed, busy: !!busy, value };
  function discard() { latest.current.changed = false; setDraft(latest.current.value ? asDraft(latest.current.value) : emptyDraft); setError(''); setSuccess(''); }
  function ask(next: () => void) {
    if (lock.current || latest.current.busy) { message.info('正在等待AI配置操作结果，请稍后再离开'); return; }
    if (!latest.current.changed) { next(); return; }
    if (confirm.current) return;
    confirm.current = modal.confirm({ title: '放弃尚未保存的AI配置？', content: '当前输入尚未保存。离开会清除本次填写的密钥和配置输入，不影响已经保存的AI服务。', zIndex: 1400, okText: '放弃修改并离开', cancelText: '继续编辑', okButtonProps: { danger: true }, onOk: () => { discard(); confirm.current = undefined; next(); }, afterClose: () => { confirm.current = undefined; } });
  }
  const askRef = useRef(ask); askRef.current = ask;
  useLayoutEffect(() => {
    if (actor.role !== 'admin' || !settings) return;
    return settings.registerGuard({ needed: () => latest.current.changed || lock.current || latest.current.busy, ask: next => askRef.current(next) });
  }, [actor.role, settings?.registerGuard]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (latest.current.changed || lock.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  useEffect(() => { onBusyChange?.(!!busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    if (actor.role === 'admin') void run('load'); else setBusy('');
    return () => { mounted.current = false; sequence.current++; lock.current = false; confirm.current?.destroy(); };
    // 初次读取只在挂载时发生；别处保存的通知不能覆盖本表单尚未确认的输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor.id, actor.role]);

  async function run(kind: 'load' | 'save' | 'test' | 'reload') {
    if (lock.current || actor.role !== 'admin') return;
    if (kind === 'save' && (!value || revision === undefined)) { setError('请先成功读取已保存的配置，再保存修改。'); return; }
    if (kind === 'save' && draft.enabled && (!draft.baseUrl.trim() || !draft.model.trim())) { setError('请填写服务地址和模型名称。'); return; }
    lock.current = true; setBusy(kind); setError(''); setSuccess(''); const operation = ++sequence.current;
    const live = () => mounted.current && operation === sequence.current;
    try {
      if (kind === 'save') {
        const next = await request<AiProvider>('/api/ai/provider', { method: 'PATCH', body: JSON.stringify({ expectedRevision: revision, enabled: draft.enabled, baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), visionModel: draft.visionModel.trim(), allowLocal: draft.allowLocal, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}), ...(draft.clearApiKey ? { clearApiKey: true } : {}) }) });
        if (!live()) return;
        setValue(next); setRevision(next.revision); setDraft(asDraft(next)); latest.current.changed = false; settings?.saved();
        setSuccess('AI服务已保存，全站AI功能共用此配置。保存不会自动调用模型。');
      } else if (kind === 'test') {
        await request('/api/ai/provider/test', { method: 'POST', body: '{}' });
        if (live()) setSuccess('连接测试通过。实际生成仍取决于模型能力和可用额度。');
      } else {
        const next = await request<AiProvider>('/api/ai/provider');
        if (!live()) return;
        setValue(next); setRevision(next.revision);
        if (kind === 'load' || !latest.current.changed) setDraft(asDraft(next));
        if (kind === 'reload') setSuccess('已读取最新配置版本，当前输入仍保留。请核对已保存信息后再保存。');
      }
    } catch (cause) { if (live()) setError(cause instanceof Error ? cause.message : '操作未完成，当前输入仍保留。'); }
    finally { if (live()) { lock.current = false; setBusy(''); } }
  }
  function change(patch: Partial<Draft>) { setDraft(current => ({ ...current, ...patch })); setSuccess(''); }
  if (actor.role !== 'admin') return <Alert type="info" showIcon title="AI服务由管理员统一配置" description="页面和产品仍可按现有权限手工维护。" />;
  const content = <Space orientation="vertical" size={20} style={{ width: '100%', minWidth: 0 }}>
    <Alert type="info" showIcon title="配置一次，全站共用" description="AI快速建站、资料整理、页面局部修改和SEO建议使用同一服务。后续增加的文章、产品文案等AI能力也将复用这里的配置。" />
    <Paragraph type="secondary" style={{ margin: 0 }}>由你选择服务商、模型和额度，支持兼容 Chat Completions 的接口。密钥仅供服务器请求，不进入公开网站、建站方案或浏览器恢复。连接测试会向已保存的服务发送一次请求。</Paragraph>
    {busy === 'load' && <Flex gap={12} align="center"><Spin size="small" /><Text type="secondary">正在读取已保存的AI配置…</Text></Flex>}
    {value && <Flex gap={8} wrap align="center"><Tag color={value.enabled ? 'green' : 'default'}>{value.enabled ? '已启用' : '未启用'}</Tag><Text type="secondary" style={{ overflowWrap: 'anywhere' }}>已保存模型：{value.model || '尚未填写'}{value.baseUrl ? ` · ${value.baseUrl}` : ''}</Text></Flex>}
    <Form layout="vertical" disabled={!!busy || !value}>
      <Form.Item><Checkbox checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })}>启用AI功能</Checkbox></Form.Item>
      <Form.Item label="服务地址" htmlFor={`${id}-base-url`} required extra="填写服务商提供的API基础地址，例如以 /v1 结尾的地址。"><Input id={`${id}-base-url`} aria-label="AI服务地址" value={draft.baseUrl} maxLength={500} placeholder="https://你的服务地址/v1" autoComplete="off" onChange={event => change({ baseUrl: event.target.value })} /></Form.Item>
      <Form.Item label="模型名称" htmlFor={`${id}-model`} required extra="按服务商提供的名称填写，需要支持文本对话和JSON输出。"><Input id={`${id}-model`} aria-label="AI模型名称" value={draft.model} maxLength={120} placeholder="填写可用的模型名称" autoComplete="off" onChange={event => change({ model: event.target.value })} /></Form.Item>
      <Form.Item label="看图检查使用的模型（选填）" htmlFor={`${id}-vision-model`} extra="留空使用上面的模型。视觉检查需要模型和服务接口支持图片输入；只有在检查页面明确发送截图时才会调用。"><Input id={`${id}-vision-model`} aria-label="AI视觉模型名称" value={draft.visionModel} maxLength={150} placeholder="留空共用当前模型，或填写同一服务的视觉模型" autoComplete="off" onChange={event => change({ visionModel: event.target.value })} /></Form.Item>
      <Form.Item label="API密钥" htmlFor={`${id}-api-key`} extra={value?.hasApiKey ? '已保存密钥；同一服务来源下留空保留。更换域名、协议或端口时，需填写对应密钥或明确移除旧密钥。' : '填写自己的密钥；明确允许的本机无密钥服务可留空。'}><Input.Password id={`${id}-api-key`} aria-label="AI API密钥" value={draft.apiKey} maxLength={4096} autoComplete="new-password" placeholder={value?.hasApiKey ? '已保存 · 同一服务留空保持' : '填写你的API密钥'} disabled={!!busy || !value || draft.clearApiKey} onChange={event => change({ apiKey: event.target.value })} /></Form.Item>
      {value?.hasApiKey && <Form.Item><Checkbox checked={draft.clearApiKey} onChange={event => change({ clearApiKey: event.target.checked, apiKey: '' })}>保存时移除现有密钥</Checkbox></Form.Item>}
      <Collapse items={[{ key: 'local', label: '本机或内网模型（高级）', children: <Space orientation="vertical" size={8}><Checkbox checked={draft.allowLocal} disabled={!!busy || !value} onChange={event => change({ allowLocal: event.target.checked })}>允许连接本机或内网服务</Checkbox><Text type="secondary">仅连接你了解并信任的服务。“本机”指运行网站服务器的机器。</Text></Space> }]} />
    </Form>
    {error && <Alert type="error" showIcon title={error} action={<Button size="small" disabled={!!busy} loading={busy === 'reload'} onClick={() => void run('reload')}>读取最新配置</Button>} />}
    {success && <Alert type="success" showIcon title={success} />}
    <Flex justify="space-between" gap={12} wrap><Button disabled={!!busy || changed || !value?.baseUrl || !value.model} loading={busy === 'test'} onClick={() => void run('test')}>测试已保存连接</Button><Space wrap>{onClose && <Button disabled={!!busy} onClick={onClose}>返回继续操作</Button>}<Button type="primary" loading={busy === 'save'} disabled={!!busy || !value || !changed} onClick={() => void run('save')}>保存AI配置</Button></Space></Flex>
    <Text type="secondary">启用不等于测试通过。只有主动点击生成或建议时才使用模型额度，保存配置不会替你生成、采用或发布内容。</Text>
  </Space>;
  return inDrawer ? content : <Card title="AI服务" styles={{ body: { padding: screens.md ? 24 : 16 } }} style={{ maxWidth: 840, minWidth: 0 }}>{content}</Card>;
}
