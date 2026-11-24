'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, App, Button, Drawer, Flex, Space, Spin, Tag, Typography } from 'antd';
import type { AiDesignGuidance, AiDesignGuidanceStamp } from '@/lib/ai-design-guidance-types';
import { AI_DESIGN_GUIDANCE_LIMITS as limits } from '@/lib/ai-design-guidance-types';
import { localRecoveries } from '@/lib/local-recovery';
import { request, useStudioRuntime } from '@/lib/studio-client';
import DesignGuidanceForm, { DESIGN_GUIDANCE_RECOVERY_SCOPE } from './AiDesignGuidance';

type Controls = { open: (rememberText?: string) => void; changeVersion: number };
const Context = createContext<Controls | null>(null);

/** 全后台只有一份设计约定表单；打开它不卸载正在编辑的要求、候选或Puck画布。 */
export function DesignGuidanceProvider({ children }: { children: ReactNode }) {
  const { actor } = useStudioRuntime(), { modal, message } = App.useApp();
  const [opened, setOpened] = useState(() => actor.role === 'admin' && localRecoveries(actor.id).some(item => item.scope === DESIGN_GUIDANCE_RECOVERY_SCOPE));
  const [busy, setBusy] = useState(false), [rememberText, setRememberText] = useState<string>(), [changeVersion, setChangeVersion] = useState(0);
  const openedRef = useRef(opened); openedRef.current = opened;
  const closeHandler = useRef<(() => void) | undefined>(undefined);
  const registerClose = useCallback((handler: (() => void) | undefined) => { closeHandler.current = handler; }, []);
  const close = useCallback(() => { if (closeHandler.current) closeHandler.current(); else setOpened(false); }, []);
  const didSave = useCallback(() => { setChangeVersion(value => value + 1); window.dispatchEvent(new Event('form-studio:ai-design-guidance-saved')); }, []);
  const open = useCallback((value?: string) => {
    if (actor.role !== 'admin') { message.info('AI设计约定由管理员维护'); return; }
    const text = value?.trim();
    const show = (next?: string) => { if (openedRef.current) return; setRememberText(next); setOpened(true); };
    if (text && text.length > limits.feedbackText) {
      modal.confirm({ title: '这次要求较长，先带入前600字？', content: `每条长期意见最多600字，当前有${text.length}字。确认后只把前600字带入待确认表单，原来的设计要求仍完整保留；你可以编辑后再保存。`, okText: '带入前600字再核对', cancelText: '先不记住', zIndex: 1400, onOk: () => show(text.slice(0, limits.feedbackText)) });
    } else show(text || undefined);
  }, [actor.role, message, modal]);
  useEffect(() => {
    const restore = (event: Event) => { if (actor.role === 'admin' && (event as CustomEvent<{ scope?: string }>).detail?.scope === DESIGN_GUIDANCE_RECOVERY_SCOPE) { setRememberText(undefined); setOpened(true); } };
    // 等同一次导航事件的所有guard完成，再判断是否关闭；被取消的导航不能卸载未保存表单。
    const navigating = (event: Event) => { queueMicrotask(() => { if (!event.defaultPrevented && openedRef.current) setOpened(false); }); };
    window.addEventListener('form-studio:recover-local', restore); window.addEventListener('form-studio:before-navigate', navigating);
    return () => { window.removeEventListener('form-studio:recover-local', restore); window.removeEventListener('form-studio:before-navigate', navigating); };
  }, [actor.role]);
  const controls = useMemo(() => ({ open, changeVersion }), [open, changeVersion]);
  return <Context.Provider value={controls}>{children}<Drawer title="AI设计约定" open={opened} onClose={close} zIndex={1250} size="min(740px, 100vw)" destroyOnHidden closable={!busy} keyboard={!busy} mask={{ closable: !busy }} styles={{ body: { padding: 24 } }}>{opened && <DesignGuidanceForm rememberText={rememberText} onClose={() => setOpened(false)} onSaved={didSave} registerClose={registerClose} onBusyChange={setBusy} />}</Drawer></Context.Provider>;
}
export function useDesignGuidance(): Controls { const value = useContext(Context); if (!value) throw new Error('设计约定入口尚未加载'); return value; }

/** 摘要只在管理员打开当前AI弹层时读取；独立显示，不写请求选项或制造未保存状态。 */
export function DesignGuidanceSummary({ visible, instruction, stamp }: { visible: boolean; instruction?: string; stamp?: AiDesignGuidanceStamp }) {
  const { actor } = useStudioRuntime(), controls = useDesignGuidance(), admin = actor.role === 'admin';
  const [saved, setSaved] = useState<AiDesignGuidance>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!visible || !admin) return;
    let live = true; setLoading(true); setError('');
    void request<AiDesignGuidance>('/api/ai/design-guidance').then(value => { if (live) setSaved(value); }).catch(() => { if (live) { setSaved(undefined); setError('暂未读到设计约定，可打开设置核对。'); } }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [visible, admin, actor.id, controls.changeVersion]);
  if (!visible || !admin) return null;
  const count = saved ? [saved.preferredStyle, saved.preserveNotes, saved.avoidStyles].filter(value => value.trim()).length + saved.feedback.length : 0;
  const stale = !!stamp && (!!stamp.stale || !!saved && stamp.revision !== saved.revision);
  return <Alert type="info" showIcon title={<Space wrap><span>AI设计约定</span>{saved && <Tag>{!saved.enabled ? '已停用' : count ? `已保存${count}项参考` : '尚未填写'}</Tag>}</Space>} description={<Space orientation="vertical" size={8} style={{ width: '100%' }}>
    {loading ? <Space><Spin size="small" /><Typography.Text type="secondary">正在读取已保存约定…</Typography.Text></Space> : <Typography.Text>{error || (!saved ? '正在核对已保存的设计约定。' : !saved.enabled ? '当前已停用；内容仍保留，不作为下一次生成参考。' : count ? '下一次生成会读取这些参考。本次明确要求、组件锁定与保留文字仍按原规则执行。' : '可以先写下希望的风格和尽量避免的做法，以后不用反复说明。')}</Typography.Text>}
    {stamp && <Typography.Text type="secondary">{stamp.active ? `这份方案生成时参考了版本${stamp.revision}。` : '这份方案生成时没有参考有效设计约定。'}{stale ? '约定后来已有更新，旧方案保持原样；请看真实预览，继续调整会使用最新已保存内容。' : ''}</Typography.Text>}
    <Flex gap={8} wrap><Button size="small" onClick={() => controls.open()}>查看或修改设计约定</Button><Button size="small" disabled={!instruction?.trim()} onClick={() => controls.open(instruction)}>记住这次要求</Button></Flex>
  </Space>} style={{ marginBottom: 16 }} />;
}
