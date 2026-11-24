'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Flex, Grid, Segmented, Space, Tag, Typography } from 'antd';
import { DesktopOutlined, MobileOutlined, ReloadOutlined, TabletOutlined } from '@ant-design/icons';
import { normalizeAiPreviewFeedback, type AiPreviewFeedback, type AiPreviewIssue } from '@/lib/ai-preview-inspection';
import type { AiVisualIssue, AiVisualTarget } from '@/lib/ai-visual-types';
import AiVisualReview from './AiVisualReview';
import './ai-design-preview.css';

const devices = { desktop: { label: '电脑', width: 1280 }, tablet: { label: '平板', width: 768 }, mobile: { label: '手机', width: 390 } } as const;
type Device = keyof typeof devices;
type Props = { beforeUrl: string; afterUrl: string; editId: string; afterLabel?: string; onFeedback?: (feedback: AiPreviewFeedback[]) => void; onNavigate?: (url: string, side: 'before' | 'after') => void; visualTarget?: AiVisualTarget; visualDisabled?: boolean; onVisualInstruction?: (instruction: string) => void; onVisualBusyChange?: (busy: boolean) => void };
function issueText(issue: AiPreviewIssue, report: AiPreviewFeedback) {
  const labels = {
    'horizontal-overflow': '页面出现横向溢出', 'broken-image': `${issue.count} 张图片未正常显示`,
    'pending-image': `${issue.count} 张图片仍在加载或等待滚动加载`, 'small-text': `${issue.count} 处文字小于 12 px`,
    'small-target': `${issue.count} 处操作区域偏小`, 'heading-count': `当前有 ${report.headingCount} 个一级标题，请核对`,
    'inspection-limit': '内容较多，仅检查前 1500 个相关元素',
  };
  return labels[issue.code];
}

/** 保持iframe的真实CSS视口，只缩放展示外壳；手机媒体查询仍按390px执行。 */
function PreviewFrame({ url, title, width, frameRef, onNavigate }: { url: string; title: string; width: number; frameRef?: React.RefObject<HTMLIFrameElement | null>; onNavigate?: (url: string) => void }) {
  const stage = useRef<HTMLDivElement>(null), [bounds, setBounds] = useState({ width: 600, height: 600 });
  const localFrame = useRef<HTMLIFrameElement>(null), actualFrame = frameRef || localFrame;
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => setBounds({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) }));
    observer.observe(stage.current); return () => observer.disconnect();
  }, []);
  const scale = Math.min(1, bounds.width / width);
  function loaded() {
    if (!onNavigate) return;
    try {
      const href = actualFrame.current?.contentWindow?.location.href;
      // 页签负责验证候选命名空间；首次装载不触发，真实站内导航后才同步对比对象。
      if (href && href !== 'about:blank' && href !== new URL(url, location.href).href) onNavigate(href);
    } catch { /* 跨源目的地不能读取；不把它作为本站页面或检查结果。 */ }
  }
  return <div className="ai-design-preview-card"><Flex justify="space-between" gap={12} className="ai-design-preview-heading"><Typography.Text strong>{title}</Typography.Text><Typography.Text type="secondary">{width} px</Typography.Text></Flex><div className="ai-design-preview-stage" ref={stage}><iframe ref={actualFrame} title={title} src={url} onLoad={loaded} style={{ width, height: bounds.height / scale, transform: `scale(${scale})`, left: Math.max(0, (bounds.width - width * scale) / 2) }} /></div></div>;
}

export default function AiDesignPreview({ beforeUrl, afterUrl, editId, afterLabel = 'AI建议', onFeedback, onNavigate, visualTarget, visualDisabled, onVisualInstruction, onVisualBusyChange }: Props) {
  const compact = Grid.useBreakpoint().md === false, afterFrame = useRef<HTMLIFrameElement>(null);
  const [device, setDevice] = useState<Device>('desktop'), [side, setSide] = useState('after');
  const identity = `${editId}:${afterUrl}`;
  const [state, setState] = useState<{ id: string; reports: Partial<Record<Device, AiPreviewFeedback>> }>({ id: identity, reports: {} });
  const [waiting, setWaiting] = useState(false), [timedOut, setTimedOut] = useState(false);
  const [locationNote, setLocationNote] = useState('');
  const locateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLocation = useRef<{ nodeId: string; device: Device } | null>(null);
  const readyPreview = useRef<{ frame: Window; device: Device } | null>(null);
  const reports = state.id === identity ? state.reports : {}, current = reports[device];
  const locateWhenReady = useCallback(() => {
    const pending = pendingLocation.current, ready = readyPreview.current, frame = afterFrame.current?.contentWindow;
    // 只有真实沙箱回报过当前宽度的排版，才发送定位；新挂载/设备切换不会靠固定等待猜测就绪。
    if (pending && frame && ready?.frame === frame && ready.device === pending.device) frame.postMessage({ source: 'form-studio-inspection', type: 'locate', nodeId: pending.nodeId }, location.origin);
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== afterFrame.current?.contentWindow || event.origin !== location.origin || event.data?.source !== 'form-studio-preview-inspection' || event.data.path !== new URL(afterUrl, location.href).pathname) return;
      if (event.data.type === 'node-location' && typeof event.data.found === 'boolean') {
        if (!pendingLocation.current) return;
        pendingLocation.current = null; if (locateTimer.current) clearTimeout(locateTimer.current);
        setLocationNote(event.data.found ? '已在AI建议预览中定位，标记稍后自动消失。' : '当前预览没有找到该节点，请核对截图对应的候选。'); return;
      }
      try {
        const [report] = normalizeAiPreviewFeedback([event.data.report]);
        if (report.width !== devices[device].width || report.viewport !== device) return;
        readyPreview.current = { frame: event.source as Window, device }; locateWhenReady();
        setState(previous => ({ id: identity, reports: { ...(previous.id === identity ? previous.reports : {}), [device]: report } }));
        setWaiting(false); setTimedOut(false);
      } catch { /* 只接收本次候选真实预览窗口的受限测量。 */ }
    };
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive);
  }, [identity, afterUrl, device, locateWhenReady]);
  useEffect(() => () => { if (locateTimer.current) clearTimeout(locateTimer.current); pendingLocation.current = null; readyPreview.current = null; }, [identity]);
  useEffect(() => { onFeedback?.(Object.values(state.id === identity ? state.reports : {})); }, [state, identity, onFeedback]);
  useEffect(() => {
    setTimedOut(false);
    const timeout = window.setTimeout(() => setTimedOut(true), 15000);
    return () => window.clearTimeout(timeout);
  }, [identity, device, side]);
  function inspect() {
    setWaiting(true); setTimedOut(false);
    afterFrame.current?.contentWindow?.postMessage({ source: 'form-studio-inspection', type: 'inspect' }, location.origin);
    // 预览不可用时停止等待；已有检查保留，不能显示成新的通过结果。
    window.setTimeout(() => setWaiting(false), 15000);
  }
  function locate(issue: AiVisualIssue) {
    if (!issue.nodeId) return;
    pendingLocation.current = { nodeId: issue.nodeId, device: issue.device };
    setDevice(issue.device); setSide('after'); setLocationNote('正在定位预览中的对应内容…');
    if (locateTimer.current) clearTimeout(locateTimer.current);
    if (device === issue.device && (!compact || side === 'after')) locateWhenReady();
    // 超时只结束等待并提示重试，不把未装载的预览标成定位成功。
    locateTimer.current = setTimeout(() => { if (pendingLocation.current) { pendingLocation.current = null; setLocationNote('预览尚未就绪，请等待页面显示后重新定位。'); } }, 15000);
  }
  const meaningful = current?.issues.filter(issue => !['pending-image', 'inspection-limit'].includes(issue.code)) || [];
  return <Space orientation="vertical" size={16} className="ai-design-preview">
    <Flex justify="space-between" gap={12} wrap align="center">
      <Segmented aria-label="预览屏幕" value={device} onChange={value => setDevice(value as Device)} options={[{ value: 'desktop', label: '电脑', icon: <DesktopOutlined /> }, { value: 'tablet', label: '平板', icon: <TabletOutlined /> }, { value: 'mobile', label: '手机', icon: <MobileOutlined /> }]} />
      <Space wrap><Button size="small" icon={<ReloadOutlined />} loading={waiting} disabled={compact && side === 'before'} onClick={inspect}>重新检查排版</Button><Button size="small" href={afterUrl} target="_blank" rel="noopener noreferrer">打开完整预览</Button></Space>
    </Flex>
    {compact && <Segmented block aria-label="修改前后" value={side} onChange={setSide} options={[{ value: 'before', label: '修改前' }, { value: 'after', label: afterLabel }]} />}
    <div className={compact ? undefined : 'ai-design-preview-grid'}>
      {(!compact || side === 'before') && <PreviewFrame key={`${editId}-before`} url={beforeUrl} title="修改前" width={devices[device].width} onNavigate={onNavigate ? href => onNavigate(href, 'before') : undefined} />}
      {(!compact || side === 'after') && <PreviewFrame key={`${editId}-after`} url={afterUrl} title={afterLabel} width={devices[device].width} frameRef={afterFrame} onNavigate={onNavigate ? href => onNavigate(href, 'after') : undefined} />}
    </div>
    <Alert type={meaningful.length ? 'warning' : 'info'} showIcon title={current ? `${devices[device].label}基础排版已检查${meaningful.length ? `，有 ${meaningful.length} 项需要核对` : '，未发现所检项目的问题'}` : timedOut ? '暂未取得排版检查结果' : '正在读取真实预览的排版结果'} description={<Space orientation="vertical" size={6}>
      {current?.issues.map(issue => <Typography.Text key={issue.code}>{issueText(issue, current)}</Typography.Text>)}
      <Typography.Text type="secondary">检查包含横向溢出、图片、过小文字、手机操作区域和一级标题。请滚动查看完整页面；图片未加载时可重查。设计观感与业务表达由你确认。</Typography.Text>
      <Space wrap>{(Object.keys(devices) as Device[]).map(key => <Tag key={key} color={reports[key] ? 'blue' : undefined}>{devices[key].label}{reports[key] ? '已检查' : '待切换查看'}</Tag>)}</Space>
    </Space>} />
    {locationNote && <Typography.Text type="secondary" role="status">{locationNote}</Typography.Text>}
    {visualTarget && <AiVisualReview target={visualTarget} disabled={visualDisabled} onInstruction={onVisualInstruction} onLocate={locate} onBusyChange={onVisualBusyChange} />}
  </Space>;
}
