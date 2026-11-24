'use client';
import { useRef, useState } from 'react';
import { Alert, App, Button, Divider, Drawer, Form, Image, Input, Popconfirm, Select, Tag } from 'antd';
import { DeleteOutlined, FileTextOutlined } from '@ant-design/icons';
import type { MediaItem } from '@/lib/types';
import { localRecoveries, readLocalRecovery } from '@/lib/local-recovery';
import { productImages } from '@/lib/product-images';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import { MediaReferencePanel } from './MediaOperations';

type Metadata = Pick<MediaItem, 'name' | 'alt' | 'folder'>;
type MediaDetailsDraft = { id: string; fields: Metadata; baseline: Metadata };
const scopeOf = (id: string) => `media-details:${id}`;
const metadataOf = (item: Metadata): Metadata => ({ name: item.name, alt: item.alt, folder: item.folder });
const metadataKey = (item: Metadata) => JSON.stringify(metadataOf(item));
const validMetadata = (item: unknown) => !!item && typeof item === 'object' && ['name', 'alt', 'folder'].every(key => typeof (item as Record<string, unknown>)[key] === 'string' && ((item as Record<string, string>)[key]).length <= 10000);

/** 每份素材独立保留本账号输入；读取时同时核对scope和快照ID，不自动写入数据库。 */
export function readMediaDetailsRecovery(actorId: string, id?: string, scope?: string) {
  const candidates = scope ? [scope] : id ? [scopeOf(id)] : localRecoveries(actorId).map(entry => entry.scope);
  for (const candidate of candidates) {
    if (!candidate.startsWith('media-details:')) continue;
    const saved = readLocalRecovery<MediaDetailsDraft>(actorId, candidate, value => {
      const draft = value as MediaDetailsDraft;
      return !!draft && typeof draft.id === 'string' && draft.id.length > 0 && draft.id.length <= 100 && candidate === scopeOf(draft.id) && (!id || draft.id === id) && validMetadata(draft.fields) && validMetadata(draft.baseline);
    });
    if (saved) return saved;
  }
}

/** 独立挂载详情，沿用全站未保存保护；关闭、切页、会话过期和恢复使用同一份草稿。 */
export default function MediaDetailsDrawer({ item, folders, onClose }: { item: MediaItem; folders: string[]; onClose: () => void }) {
  const runtime = useStudioRuntime(), { message } = App.useApp(), [form] = Form.useForm<Metadata>();
  const editable = runtime.actor.role !== 'viewer', scope = scopeOf(item.id);
  const [recovered] = useState(() => editable ? readMediaDetailsRecovery(runtime.actor.id, item.id)?.snapshot : undefined);
  const [baseline] = useState(() => recovered?.baseline || metadataOf(item));
  const [draft, setDraft] = useState(() => recovered?.fields || metadataOf(item));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const busyRef = useRef(false);
  const dirty = editable && metadataKey(draft) !== metadataKey(baseline);
  const usedBy = runtime.envelope.state.products.filter(product => productImages(product).includes(item.url));

  async function save() {
    if (!editable || busyRef.current) return false;
    let fields: Metadata;
    try { fields = await form.validateFields(); } catch { return false; }
    busyRef.current = true; setBusy(true); setError('');
    try {
      // 上传或其他素材的更新可能已推进版本：只合并目标的三个字段，保留最新数组和文件信息。
      await runtime.mutate(env => {
        const current = env.state.media.find(media => media.id === item.id);
        if (!current) throw new Error('这份素材已移出素材库，当前输入已保留。');
        if (metadataKey(current) !== metadataKey(baseline)) throw new Error('这份素材的信息已在别处修改，当前输入已保留，请先核对最新资料。');
        return request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { media: env.state.media.map(media => media.id === item.id ? { ...media, ...fields, name: fields.name.trim() } : media) } }) });
      });
      guard.resolve(); message.success('素材信息已保存到数据库'); onClose(); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存未完成，输入已保留，请重试。'); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function remove() {
    if (!editable || busyRef.current) return;
    if (runtime.getEnvelope().state.products.some(product => productImages(product).includes(item.url))) { message.warning('这张图片仍被产品使用，请先替换产品图片后再移除'); return; }
    busyRef.current = true; setBusy(true); setError('');
    try {
      await runtime.mutate(env => request<StudioEnvelope>(`/api/media/${encodeURIComponent(item.id)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: env.revision }) }));
      guard.resolve(); message.success('素材已移出草稿库；历史版本引用的文件继续保留'); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '移除未完成，当前输入已保留。'); }
    finally { busyRef.current = false; setBusy(false); }
  }

  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope, screen: 'media', title: `素材信息 · ${item.name}`, dirty, busy, snapshot: { id: item.id, fields: draft, baseline } satisfies MediaDetailsDraft, save: editable ? save : undefined, discard: () => { setDraft(metadataOf(item)); form.setFieldsValue(metadataOf(item)); } });
  return <>{guard.dialog}<Drawer open title="素材详情" onClose={() => guard.ask(onClose)} size={480} className="cs-drawer" footer={<div className="cs-drawer-footer"><Popconfirm title="从草稿素材库移除？" description={usedBy.length ? '这张图片被产品引用，需要先替换产品图片。' : '已发布版本引用的文件会继续保留，草稿引用会先检查。'} okText="移除" cancelText="取消" onConfirm={remove}><Button danger type="text" disabled={!editable || busy} icon={<DeleteOutlined />}>移除</Button></Popconfirm><Button type="primary" loading={busy} disabled={!editable} onClick={() => void save()}>保存修改</Button></div>}>
    {recovered && <Alert type="warning" showIcon title="已恢复本账号未保存的素材信息；保存前会核对原资料。" style={{ marginBottom: 16 }} />}
    {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
    <div className="cs-detail-image">{item.kind === 'image' ? <Image src={item.url} alt={item.alt || item.name} /> : item.kind === 'video' ? <video controls preload="metadata" src={item.url} aria-label={item.name} style={{ width: '100%' }} /> : <Button href={item.url} icon={<FileTextOutlined />}>下载PDF目录</Button>}</div>
    <div className="cs-detail-fileinfo"><Tag>{item.kind === 'image' ? '图片' : item.kind === 'video' ? '视频' : '文档'}</Tag><span>{item.size}</span><span>{item.url.startsWith('/api/media/') ? '服务器上传' : '示例素材'}</span></div>
    <p>{item.width && item.height ? `${item.width} × ${item.height}px · ${item.variants?.length || 0}种衍生尺寸` : item.pages ? `${item.pages}页PDF目录` : '旧素材未记录固有尺寸'}</p>
    <Form form={form} initialValues={draft} layout="vertical" disabled={!editable || busy} onValuesChange={(_, values) => setDraft(metadataOf(values))}>
      <Form.Item name="name" label="文件名称" rules={[{ required: true, whitespace: true, message: '请填写文件名称' }]}><Input /></Form.Item>
      <Form.Item name="folder" label="所在文件夹"><Select options={[...new Set([...folders, draft.folder])].filter(Boolean).map(value => ({ value, label: value }))} /></Form.Item>
      <Form.Item name="alt" label="图片内容说明" extra="简洁描述图片内容，帮助使用读屏工具的访客理解。"><Input.TextArea rows={3} placeholder="例如：浅色橡木单椅摆放在自然采光的客厅中" maxLength={240} showCount /></Form.Item>
    </Form>
    <Divider /><MediaReferencePanel id={item.id} />
  </Drawer></>;
}
