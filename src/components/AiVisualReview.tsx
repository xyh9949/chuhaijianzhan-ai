'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Collapse, Empty, Flex, Image, Input, InputNumber, List, Pagination, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { CameraOutlined, EyeOutlined, ReloadOutlined, AimOutlined, DeleteOutlined } from '@ant-design/icons';
import { request, useStudioRuntime } from '@/lib/studio-client';
import type { AiVisualCapture, AiVisualCaptureHistory, AiVisualCaptureImage, AiVisualCaptureMode, AiVisualDevice, AiVisualIssue, AiVisualReview, AiVisualReviewHistory, AiVisualStatus, AiVisualTarget } from '@/lib/ai-visual-types';

const labels: Record<AiVisualDevice, string> = { desktop: '电脑', tablet: '平板', mobile: '手机' };
const devices: AiVisualDevice[] = ['desktop', 'tablet', 'mobile'];
const widthStyle = { width: '100%', minWidth: 0 };
const imageLabel = (image: AiVisualCaptureImage) => `${labels[image.device]}${image.section ? `第${image.section.number}段` : image.state ? `交互${image.id.split('-').at(-1)}` : ''}`;
type Props = { target: AiVisualTarget; disabled?: boolean; onInstruction?: (instruction: string) => void; onLocate?: (issue: AiVisualIssue) => void; onBusyChange?: (busy: boolean) => void };
type Loaded = { availability: AiVisualStatus; records: AiVisualReviewHistory; captures: AiVisualCaptureHistory };

/** 本地采图、原生交互观察与模型发送分开；分段不会自动变成多次收费请求。 */
export default function AiVisualReview({ target, disabled = false, onInstruction, onLocate, onBusyChange }: Props) {
  const runtime = useStudioRuntime(), identity = JSON.stringify([target.kind, target.id, target.pageId || '']);
  const recoveryKey = `form-studio:visual-requirement:${runtime.actor.id}:${identity}`;
  const [open, setOpen] = useState(false), [status, setStatus] = useState<AiVisualStatus>();
  const [capture, setCapture] = useState<AiVisualCapture>(), [review, setReview] = useState<AiVisualReview>();
  const [captures, setCaptures] = useState<AiVisualCapture[]>([]), [history, setHistory] = useState<AiVisualReview[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [captureDevices, setCaptureDevices] = useState<AiVisualDevice[]>([...devices]), [mode, setMode] = useState<AiVisualCaptureMode>('viewport');
  const [startSection, setStartSection] = useState(1), [maxSections, setMaxSections] = useState(4), [interactions, setInteractions] = useState(false);
  const [imagePage, setImagePage] = useState(1), [deviceFilter, setDeviceFilter] = useState<AiVisualDevice | 'all'>('all');
  const [instruction, setInstruction] = useState(''), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const currentIdentity = useRef(identity), inFlight = useRef<AbortController | null>(null), busyRef = useRef(false), busyChanged = useRef(onBusyChange);
  currentIdentity.current = identity; busyChanged.current = onBusyChange;

  useEffect(() => {
    setCapture(undefined); setCaptures([]); setReview(undefined); setHistory([]); setSelected([]); setConsent(false); setError(''); setNotice(''); setImagePage(1); setDeviceFilter('all');
    try { const saved = sessionStorage.getItem(recoveryKey) || ''; setInstruction(saved.length <= 2000 ? saved : ''); } catch { setInstruction(''); }
    return () => { inFlight.current?.abort(); if (busyRef.current) busyChanged.current?.(false); busyRef.current = false; };
  }, [identity, recoveryKey]);
  const loadStatus = useCallback(async (signal?: AbortSignal): Promise<Loaded> => {
    const query = new URLSearchParams({ targetKind: target.kind, targetId: target.id, ...(target.pageId ? { pageId: target.pageId } : {}) });
    const [availability, records, captures] = await Promise.all([
      request<AiVisualStatus>('/api/ai/visual/status', { signal }),
      request<AiVisualReviewHistory>(`/api/ai/visual/reviews?${query}`, { signal }),
      request<AiVisualCaptureHistory>(`/api/ai/visual/captures?${query}`, { signal }),
    ]); return { availability, records, captures };
  }, [target.kind, target.id, target.pageId]);
  function showCapture(value: AiVisualCapture | undefined, existingReview?: AiVisualReview) {
    setCapture(value); setReview(existingReview); setConsent(false); setImagePage(1); setDeviceFilter('all');
    const ids = existingReview?.imageIds?.filter(id => value?.images.some(image => image.id === id));
    setSelected(ids?.length ? ids : value?.images.slice(0, 3).map(image => image.id) || []);
  }
  function showLoaded(value: Loaded) {
    setStatus(value.availability); setHistory(value.records.items); setCaptures(value.captures.items);
    const savedReview = value.records.items[0], savedCapture = value.captures.items.find(item => item.id === savedReview?.captureId) || value.captures.items[0];
    showCapture(savedCapture, savedCapture?.id === savedReview?.captureId ? savedReview : undefined);
  }
  useEffect(() => {
    if (!open || busyRef.current) return;
    const controller = new AbortController(), token = identity;
    loadStatus(controller.signal).then(value => { if (currentIdentity.current === token && !controller.signal.aborted) showLoaded(value); })
      .catch(cause => { if (!controller.signal.aborted && currentIdentity.current === token) setError(cause instanceof Error ? cause.message : '视觉检查状态暂时无法读取'); });
    return () => controller.abort();
  // 父层重绘不能重复读取或调用模型；每次打开只恢复本人的有效记录。
  }, [identity, open, loadStatus]);
  async function run(label: string, action: (signal: AbortSignal, alive: () => boolean) => Promise<void>) {
    if (busyRef.current || disabled) return;
    const token = identity, controller = new AbortController(); inFlight.current = controller; busyRef.current = true;
    setBusy(label); setError(''); setNotice(''); busyChanged.current?.(true);
    const alive = () => currentIdentity.current === token && !controller.signal.aborted;
    try { await action(controller.signal, alive); }
    catch (cause) { if (alive()) setError(cause instanceof Error ? cause.message : '视觉检查未完成，已有方案保持'); }
    finally { if (inFlight.current === controller) { inFlight.current = null; busyRef.current = false; setBusy(''); busyChanged.current?.(false); } }
  }
  function captureImages(next?: { device: AiVisualDevice; startSection: number }) {
    const selectedDevices = next ? [next.device] : captureDevices, selectedMode = next ? 'page' : mode, selectedStart = next?.startSection || startSection;
    if (next) { setCaptureDevices(selectedDevices); setMode('page'); setStartSection(selectedStart); }
    void run('正在生成真实截图', async (signal, alive) => {
      const value = await request<AiVisualCapture>('/api/ai/visual/captures', { method: 'POST', body: JSON.stringify({ target, devices: selectedDevices, ...(selectedMode === 'page' ? { mode: selectedMode, startSection: selectedStart, maxSections } : {}), ...(interactions ? { inspectInteractions: true } : {}) }), signal });
      if (!alive()) return;
      setCaptures(current => [value, ...current.filter(item => item.id !== value.id)].slice(0, 10)); showCapture(value);
      setNotice('真实截图和本地检查已准备好。最多勾选3张后明确发送；尚未调用模型。');
    });
  }
  function inspectImages() {
    if (!capture || !selected.length || selected.length > 3 || !consent) return;
    void run('AI正在查看所选截图', async (signal, alive) => {
      const value = await request<AiVisualReview>('/api/ai/visual/reviews', { method: 'POST', body: JSON.stringify({ captureId: capture.id, imageIds: selected, instruction: instruction.trim() }), signal });
      if (!alive()) return;
      setReview(value); setHistory(current => [value, ...current.filter(item => item.id !== value.id)].slice(0, 30)); setConsent(false);
      setNotice('视觉建议已就绪，只对应本次发送的图片。先定位核对，再带入继续调整；网站没有改变。');
      try { sessionStorage.removeItem(recoveryKey); } catch { /* 私有结果已经保存，本地存储失败不重放模型。 */ }
    });
  }
  function removeCapture() {
    if (!capture) return; const id = capture.id;
    return run('移除截图记录', async (signal, alive) => {
      await request(`/api/ai/visual/captures/${encodeURIComponent(id)}`, { method: 'DELETE', signal }); if (!alive()) return;
      setNotice('此组截图和对应评审已移除，设计方案及网站保持。');
      const latest = await loadStatus(signal); if (alive()) showLoaded(latest);
    });
  }
  const expired = !!capture && Date.parse(capture.expiresAt) <= Date.now(), selectedImages = capture?.images.filter(image => selected.includes(image.id)) || [];
  const warnings = [...new Set([...(capture?.warnings || []), ...(review?.warnings || [])])], controlsDisabled = disabled || !!busy;
  const filteredImages = capture?.images.filter(image => deviceFilter === 'all' || image.device === deviceFilter) || [], visibleImages = filteredImages.slice((imagePage - 1) * 6, imagePage * 6);
  return <Collapse size="small" activeKey={open ? ['visual'] : []} onChange={keys => setOpen(keys.includes('visual'))} items={[{ key: 'visual', label: <Space wrap><EyeOutlined aria-hidden="true"/><span>让AI看看实际页面（可选）</span>{review && <Tag>已有视觉建议</Tag>}</Space>, children: <Space orientation="vertical" size={16} style={widthStyle} styles={{ item: { minWidth: 0, maxWidth: '100%' } }}>
    <Typography.Paragraph type="secondary" style={{ margin: 0 }}>先生成真实截图，再由你决定是否发送给自配AI。可按页段继续检查长页面，原生交互仅在本地安全观察；建议不会自动保存或发布。</Typography.Paragraph>
    {error && <Alert type="error" showIcon title={error}/>}{notice && <Alert type="info" showIcon title={notice}/>}
    {status && !status.available && <Alert type="info" showIcon title="当前不能自动生成截图" description={status.reason || '服务器尚未准备截图浏览器，人工预览和拖拽编辑仍可使用。'} action={<Button size="small" disabled={controlsDisabled} onClick={() => void run('读取截图状态', async (signal, alive) => { const value = await loadStatus(signal); if (alive()) showLoaded(value); })}><ReloadOutlined aria-hidden="true"/>重新检查</Button>}/>}
    {status && !status.providerReady && <Alert type="info" showIcon title="视觉检查使用你自己配置的AI" description="请在站点设置 → AI服务配置支持图片输入的模型。只有明确发送所选截图才会调用模型。"/>}
    <Flex gap={12} wrap align="center"><Select mode="multiple" aria-label="视觉截图设备" value={captureDevices} options={devices.map(value => ({ value, label: labels[value] }))} onChange={setCaptureDevices} disabled={controlsDisabled} style={{ minWidth: 220, maxWidth: '100%' }}/><Button icon={<CameraOutlined aria-hidden="true"/>} loading={busy === '正在生成真实截图'} disabled={controlsDisabled || !status?.available || !captureDevices.length} onClick={() => captureImages()}>{capture ? '重新生成截图' : '生成真实截图'}</Button></Flex>
    <Collapse size="small" items={[{ key: 'range', label: '检查更多页面内容', children: <Space orientation="vertical" size={12} style={widthStyle}>
      <Select aria-label="视觉检查范围" value={mode} options={[{ value: 'viewport', label: '只看当前首屏' }, { value: 'page', label: '滚动检查整页（分段）' }]} onChange={value => { setMode(value); setStartSection(1); }} disabled={controlsDisabled} style={widthStyle}/>
      {mode === 'page' && <Flex wrap gap={12} align="center"><Space><Typography.Text>从第几段开始</Typography.Text><InputNumber aria-label="截图起始页段" min={1} max={200} precision={0} value={startSection} onChange={value => setStartSection(Number(value) || 1)} disabled={controlsDisabled}/></Space><Space><Typography.Text>本次最多几段</Typography.Text><InputNumber aria-label="每设备截图页段数" min={1} max={6} precision={0} value={maxSections} onChange={value => setMaxSections(Number(value) || 1)} disabled={controlsDisabled}/></Space></Flex>}
      <Checkbox checked={interactions} disabled={controlsDisabled} onChange={event => setInteractions(event.target.checked)}>同时检查菜单、标签页等原生交互</Checkbox>
      <Typography.Text type="secondary">本地检查只展开原生菜单和折叠内容、切换部分标签和轮播，读取锚点与表单标注；不访问新页面、外链，不填表或提交。长页达到本次范围会明确显示未覆盖部分。</Typography.Text>
    </Space> }]}/>
    {captures.length > 1 && <Select aria-label="查看已生成截图组" value={capture?.id} onChange={id => { const value = captures.find(item => item.id === id); showCapture(value, history.find(item => item.captureId === id)); }} options={captures.map(item => ({ value: item.id, label: `${new Date(item.createdAt).toLocaleString()} · ${item.images.length}张真实截图` }))} disabled={controlsDisabled} style={widthStyle}/>}
    {capture && <>
      <Flex gap={12} wrap align="center" justify="space-between"><Typography.Text type="secondary">生成于 {new Date(capture.createdAt).toLocaleString()}。{expired ? '截图已到期，请重新生成。' : '切换或继续调整候选后需要重新截图。'}</Typography.Text><Popconfirm title="移除此组截图？" description="对应的视觉评审也会移除，设计候选和网站保持。" okText="移除截图和评审" cancelText="保留" onConfirm={removeCapture} disabled={controlsDisabled}><Button size="small" icon={<DeleteOutlined aria-hidden="true"/>} disabled={controlsDisabled}>移除此组截图</Button></Popconfirm></Flex>
      {!!capture.pageCoverage?.length && <Collapse size="small" items={[{ key: 'coverage', label: `截图覆盖与本地检查 · ${capture.images.length}张图片`, children: <Space orientation="vertical" size={12} style={widthStyle}>
        <List size="small" dataSource={capture.pageCoverage} renderItem={item => <List.Item><Space orientation="vertical" size={6} style={widthStyle}><Space wrap><Typography.Text strong>{labels[item.device]}</Typography.Text><Tag color={item.complete ? 'green' : 'default'}>{item.complete ? '本组已覆盖滚动高度' : item.mode === 'viewport' ? '仅首屏' : '部分页段'}</Tag><Typography.Text>{item.intervals.length ? `实际第${item.startSection}—${item.endSection}段，共约${item.totalSections}段` : item.pageHeight ? '所选范围没有取得截图' : '尚未截图，页面高度未知'}</Typography.Text></Space>{item.reason && <Typography.Text type="secondary">{item.reason}</Typography.Text>}{item.nextStartSection && item.mode === 'page' && <Button size="small" disabled={controlsDisabled || !status?.available} onClick={() => captureImages({ device: item.device, startSection: item.nextStartSection! })}>继续检查{labels[item.device]}后续页段</Button>}</Space></List.Item>}/>
        {!!capture.observations?.length && <List size="small" header="原生交互的实际观察" dataSource={capture.observations} renderItem={item => <List.Item><Space orientation="vertical" size={4} style={widthStyle}><Space wrap><Tag>{labels[item.device]}</Tag><Tag color={item.status === 'warning' ? 'orange' : undefined}>{item.status === 'checked' ? '已观察' : item.status === 'warning' ? '需核对' : '未检查'}</Tag><Typography.Text strong>{item.title}</Typography.Text></Space><Typography.Text type="secondary">{item.detail}</Typography.Text></Space></List.Item>}/>}
        <Typography.Text type="secondary">滚动范围覆盖不等于设计或业务验收；AI只看到你本次勾选发送的图片。</Typography.Text>
      </Space> }]}/>}
      <Flex gap={12} wrap align="center" justify="space-between"><Typography.Text strong>已选 {selectedImages.length}／3 张</Typography.Text>{capture.images.length > 6 && <Select aria-label="按设备查看截图" value={deviceFilter} onChange={value => { setDeviceFilter(value); setImagePage(1); }} options={[{ value: 'all', label: '全部设备' }, ...devices.map(value => ({ value, label: labels[value] }))]} disabled={controlsDisabled} style={{ minWidth: 140 }}/>}</Flex>
      <Flex gap={12} wrap align="stretch">{visibleImages.map(image => <Card key={image.id} size="small" style={{ flex: '1 1 180px', minWidth: 0 }} styles={{ body: { padding: 12, minWidth: 0 } }} title={<Checkbox aria-label={`发送${imageLabel(image)}截图`} checked={selected.includes(image.id)} disabled={controlsDisabled || expired || !selected.includes(image.id) && selected.length >= 3} onChange={event => { setSelected(current => event.target.checked ? [...current, image.id] : current.filter(id => id !== image.id)); setConsent(false); }}>{imageLabel(image)}</Checkbox>}>
        <Image src={image.url} alt={`${imageLabel(image)}真实候选截图`} width="100%" styles={{ image: { maxHeight: 230, objectFit: 'contain', background: '#f5f7fa' } }}/>
        <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>{image.width} × {image.height} · {image.section ? `页面第${image.section.from}—${image.section.to}像素` : image.state ? image.state.label : '首屏可见范围'}</Typography.Paragraph>
        {image.warnings.map((warning, i) => <Typography.Paragraph key={i} type="secondary" style={{ margin: '4px 0 0' }}>{warning}</Typography.Paragraph>)}
      </Card>)}</Flex>
      {filteredImages.length > 6 && <Pagination size="small" current={imagePage} pageSize={6} total={filteredImages.length} onChange={setImagePage} showSizeChanger={false} disabled={controlsDisabled}/>}
      <Input.TextArea aria-label="视觉检查重点" value={instruction} onChange={event => { const value = event.target.value; setInstruction(value); setConsent(false); try { sessionStorage.setItem(recoveryKey, value); } catch { /* 本地存储不可用不影响当前明确请求。 */ } }} rows={2} maxLength={2000} showCount disabled={controlsDisabled} placeholder="例如：重点看手机标题、页面中下段层级、展开后的菜单和产品信息。"/>
      <Checkbox checked={consent} disabled={controlsDisabled || expired || !selected.length || selected.length > 3} onChange={event => setConsent(event.target.checked)}>我已核对，允许将勾选截图和本次要求发送给自配AI</Checkbox>
      <Flex gap={12} wrap align="center"><Button type="primary" icon={<EyeOutlined aria-hidden="true"/>} loading={busy === 'AI正在查看所选截图'} disabled={controlsDisabled || !status?.providerReady || expired || !consent || !selectedImages.length || selectedImages.length > 3} onClick={inspectImages}>发送所选截图检查</Button><Typography.Text type="secondary">{selectedImages.length} 张截图{status?.visionModel ? ` · ${status.visionModel}` : ''}；可能消耗你的模型接口额度。更多图片需你再次明确发送。</Typography.Text></Flex>
    </>}
    {!!warnings.length && <Alert type="warning" showIcon title="检查范围说明" description={<List size="small" split={false} dataSource={warnings} renderItem={value => <List.Item style={{ paddingBlock: 2 }}>{value}</List.Item>}/>}/>}
    {review ? <Card size="small" title="视觉建议" extra={review.model && <Tag style={{ maxWidth: 180, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{review.model}</Tag>} styles={{ body: { minWidth: 0, overflowWrap: 'anywhere' } }}>
      <Typography.Paragraph>{review.summary}</Typography.Paragraph>
      <List size="small" dataSource={review.issues} locale={{ emptyText: 'AI没有提出具体问题；不代表整个网站已通过完整视觉验收。' }} renderItem={issue => <List.Item style={{ alignItems: 'flex-start' }}><Space orientation="vertical" size={6} style={widthStyle}><Space wrap><Tag color={issue.severity === 'warning' ? 'orange' : 'blue'}>{labels[issue.device]}</Tag><Typography.Text strong>{issue.title}</Typography.Text></Space><Typography.Text>{issue.description}</Typography.Text><Typography.Text type="secondary">建议：{issue.suggestion}</Typography.Text>{issue.nodeId && onLocate && <Button size="small" icon={<AimOutlined aria-hidden="true"/>} onClick={() => onLocate(issue)}>在预览定位</Button>}</Space></List.Item>}/>
      {onInstruction && review.suggestedInstruction && <Button disabled={controlsDisabled} onClick={() => { onInstruction(review.suggestedInstruction); setNotice('建议已带入继续调整要求。核对后再点击原来的生成按钮；当前网站没有改变。'); }}>带入继续调整</Button>}
    </Card> : !capture && status?.available ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有截图。生成截图不会调用AI。"/> : null}
    {!!history.length && <Select aria-label="查看视觉检查记录" value={review?.id} onChange={id => { const value = history.find(item => item.id === id); showCapture(captures.find(item => item.id === value?.captureId), value); }} options={history.map(item => ({ value: item.id, label: `${new Date(item.createdAt).toLocaleString()} · ${item.summary.slice(0, 60)}` }))} disabled={controlsDisabled} style={widthStyle}/>}
  </Space> }]} />;
}
