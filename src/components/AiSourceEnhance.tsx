'use client';
import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Collapse, Flex, Image, List, Pagination, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { FileImageOutlined, ScanOutlined } from '@ant-design/icons';
import type { AiExtractedSource, AiSourceImage, AiSourceEnhanceRequest } from '@/lib/ai-source-types';
import type { MediaItem } from '@/lib/types';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';

export type EnhanceSourceRecord = { id: string; source: AiExtractedSource; expiresAt: string; createdAt?: string };
type Props = { record: EnhanceSourceRecord; disabled: boolean; onRecord: (value: EnhanceSourceRecord) => void; onBusyChange: (value: string) => void };
export const sourceImageUrl = (sourceId: string, imageId: string) => `/api/ai/sources/${encodeURIComponent(sourceId)}/images/${encodeURIComponent(imageId)}`;
export function sourceImageLocation(image: AiSourceImage) { const source = image.source; return source.kind === 'pdf' ? `PDF第${source.pageNumber}页 · 位图${source.objectIndex + 1}` : `${source.sheetName} · 第${source.row}行${source.column}列${source.endRow && source.endRow !== source.row ? `至第${source.endRow}行` : ''}`; }

/** OCR与抽图完全离线且由人选范围；原件和缩略图私有，单张明确入库才成为网站素材。 */
export default function AiSourceEnhance({ record, disabled, onRecord, onBusyChange }: Props) {
  const runtime = useStudioRuntime(), { message } = App.useApp();
  const [pageNumbers, setPageNumbers] = useState<number[]>([]), [ocr, setOcr] = useState(true), [images, setImages] = useState(true), [language, setLanguage] = useState<AiSourceEnhanceRequest['language']>('eng+chi_sim');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [imagePage, setImagePage] = useState(1);
  const controller = useRef<AbortController | undefined>(undefined), active = useRef(true), lock = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { setPageNumbers((record.source.pages || []).filter(page => page.needsOcr).slice(0, 5).map(page => page.pageNumber)); setOcr(true); setImages(true); setImagePage(1); setError(''); setNotice(''); }, [record.id]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(''); }, [busy, onBusyChange]);
  async function enhance() {
    if (disabled || lock.current) return;
    lock.current = true; setBusy('离线识别与提取'); setError(''); setNotice(''); const abort = new AbortController(); controller.current = abort;
    try { const result = await request<EnhanceSourceRecord>(`/api/ai/sources/${record.id}/enhance`, { method: 'POST', signal: abort.signal, body: JSON.stringify({ ...(record.source.kind === 'pdf' ? { pageNumbers } : {}), ocr: record.source.kind === 'pdf' && ocr, images, language }) }); if (active.current) { onRecord(result); setNotice('离线处理完成，文字和图片仍需核对；网站内容尚未改动。'); } }
    catch (cause) { if (!active.current) return; if (abort.signal.aborted) setNotice('已停止等待本次处理。重新读取资料可核对服务器是否已完成，旧资料不会被不完整结果覆盖。'); else setError(cause instanceof Error ? cause.message : '资料处理未完成'); }
    finally { controller.current = undefined; lock.current = false; if (active.current) setBusy(''); }
  }
  async function adopt(image: AiSourceImage) {
    if (disabled || lock.current) return; lock.current = true; setBusy('保存选定图片'); setError('');
    try { await runtime.flush(); await runtime.mutate(async env => { const result = await request<StudioEnvelope & { media: MediaItem; source: EnhanceSourceRecord }>(`/api/ai/sources/${record.id}/images/adopt`, { method: 'POST', body: JSON.stringify({ imageId: image.id, expectedRevision: env.revision }) }); onRecord(result.source); return result; }); setNotice('选定图片已加入素材中心，尚未自动匹配产品或发布。'); message.success('图片已保存到素材中心'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '图片未确认保存，请读取最新资料后核对'); }
    finally { lock.current = false; if (active.current) setBusy(''); }
  }
  const pdf = record.source.kind === 'pdf', sourceImages = record.source.images || [], blocked = disabled || !!busy;
  return <Collapse items={[{ key: 'enhance', label: '识别扫描文字与提取文件图片', children: <Space orientation="vertical" size={16} style={{ display: 'flex', minWidth: 0 }}>
    <Alert type="info" showIcon title="在本机处理，不发送资料给AI" description="支持中英文扫描文字和文件实际嵌入的图片。识别稿可能误读数字、单位和名称，请与原件核对；图片必须明确选入素材，不能凭图片位置自动判断产品。"/>
    {record.source.enhancementAvailable && <Button href={`/api/ai/sources/${record.id}/file`} download>下载原文件核对（私有资料）</Button>}
    {!record.source.enhancementAvailable && <Alert type="warning" title="这份旧资料没有保留私有原件" description="请重新上传，再使用扫描识别与抽图；现有已提取文字和产品映射仍可使用。"/>}
    {error && <Alert type="error" showIcon title={error}/>} {notice && <Alert type="info" showIcon title={notice}/>}
    {pdf && <><Typography.Text strong>本次处理哪些页（最多5页）</Typography.Text><Checkbox.Group value={pageNumbers} disabled={blocked} onChange={value => setPageNumbers(value as number[])}><Space wrap>{record.source.pages?.map(page => <Checkbox key={page.pageNumber} value={page.pageNumber}>第{page.pageNumber}页{page.needsOcr ? ' · 建议识别' : page.ocr ? ' · 已有识别稿' : ' · 有文字层'}</Checkbox>)}</Space></Checkbox.Group><Flex gap={16} wrap><Checkbox checked={ocr} disabled={blocked} onChange={event => setOcr(event.target.checked)}>识别扫描文字</Checkbox><Checkbox checked={images} disabled={blocked} onChange={event => setImages(event.target.checked)}>提取页面实际图片</Checkbox><Select aria-label="扫描文字语言" value={language} disabled={blocked || !ocr} options={[{ value: 'eng+chi_sim', label: '中文与英文' }, { value: 'eng', label: '英文' }, { value: 'chi_sim', label: '简体中文' }]} style={{ width: 180 }} onChange={setLanguage}/></Flex></>}
    <Flex gap={12} wrap><Button icon={pdf && ocr ? <ScanOutlined/> : <FileImageOutlined/>} loading={busy === '离线识别与提取'} disabled={blocked || !record.source.enhancementAvailable || pdf && (!pageNumbers.length || pageNumbers.length > 5 || !ocr && !images) || !pdf && !images} onClick={() => void enhance()}>{pdf ? '开始本机识别与提取' : '提取工作簿图片'}</Button>{busy === '离线识别与提取' && <Button onClick={() => controller.current?.abort()}>停止本次处理</Button>}</Flex>
    {busy && <Alert type="info" showIcon title={busy} description="文件在本机处理，完成前不会生成公开图片地址；可停止等待后重新读取资料核对。"/>}
    {!!record.source.enhancementWarnings?.length && <List size="small" dataSource={record.source.enhancementWarnings} renderItem={warning => <List.Item><Typography.Text type="secondary">{warning}</Typography.Text></List.Item>}/>}
    {sourceImages.length > 0 && <><Typography.Text strong>核对实际图片 · {sourceImages.length}张</Typography.Text><Flex gap={16} wrap>{sourceImages.slice((imagePage - 1) * 8, imagePage * 8).map(image => { const source = image.source, saved = !!image.adoptedMediaId && runtime.getEnvelope().state.media.some(item => item.id === image.adoptedMediaId); return <Card key={image.id} size="small" style={{ flex: '1 1 220px', maxWidth: 320, minWidth: 0 }} styles={{ body: { padding: 16 } }}><Space orientation="vertical" size={10} style={{ display: 'flex', width: '100%' }}><Image src={sourceImageUrl(record.id, image.id)} alt={sourceImageLocation(image)} style={{ width: '100%', height: 150, objectFit: 'contain', background: '#f5f7fa' }} preview={{ mask: '放大核对' }}/><Typography.Text style={{ overflowWrap: 'anywhere' }}>{sourceImageLocation(image)}</Typography.Text><Typography.Text type="secondary">{image.width} × {image.height}px · {Math.ceil(image.bytes / 1024)}KB</Typography.Text>{source.kind === 'pdf' && source.possiblePageScan && <Tag color="orange">可能是整页扫描，需核对用途</Tag>}{source.kind === 'xlsx' && source.hidden && <Tag color="orange">来自隐藏行列，请核对</Tag>}<Popconfirm title="将这张图片保存到素材中心？" description="仅保存选定图片，不自动匹配产品或发布。" onConfirm={() => adopt(image)} disabled={blocked || saved}><Button block disabled={blocked || saved}>{saved ? '已在素材中心' : '选入素材中心'}</Button></Popconfirm></Space></Card>; })}</Flex><Pagination current={imagePage} pageSize={8} total={sourceImages.length} showSizeChanger={false} onChange={setImagePage}/></>}
  </Space> }]}/>;
}
