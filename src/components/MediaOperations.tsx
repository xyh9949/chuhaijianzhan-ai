'use client';
import { useEffect, useState } from 'react';
import { Alert, App, Button, Descriptions, Flex, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { request, RequestError, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import type { MediaItem } from '@/lib/types';

const bytesText = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
type Inventory = { draftCount: number; physicalFiles: number; physicalBytes: number; originalBytes: number; derivativeBytes: number; diskAvailableBytes: number; missingAlt: number; candidateCount?: number; candidateBytes?: number; candidates?: { filename: string; bytes: number }[]; note?: string };
/** 容量按实际磁盘去重统计；清理清单只读，不给历史资源增加删除入口。 */
export function MediaInventoryPanel() {
  const runtime = useStudioRuntime(), [data, setData] = useState<Inventory>(), [error, setError] = useState(''), [reload, setReload] = useState(0), [plan, setPlan] = useState<Inventory>();
  useEffect(() => { let active = true; void request<Inventory>('/api/media').then(r => { if (active) { setData(r); setError(''); } }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [runtime.envelope.state.media, reload]);
  async function inspect() { try { setPlan(await request<Inventory>('/api/media/cleanup-plan')); } catch (e) { setError((e as Error).message); } }
  return <Space orientation="vertical" style={{ width: '100%', marginBottom: 16 }}>{error && <Alert type="error" title={error} action={<Button onClick={() => setReload(n => n + 1)}>重试</Button>} />}
    {data && <Alert type="info" showIcon title={`实际文件 ${bytesText(data.physicalBytes)} · 原资源 ${bytesText(data.originalBytes)} · 衍生图 ${bytesText(data.derivativeBytes)}`} description={<Space wrap><span>统计上传目录；内置演示图不计入。{data.draftCount}份草稿素材 / {data.physicalFiles}个物理文件 · 所在磁盘可用{bytesText(data.diskAvailableBytes)}</span>{!!data.missingAlt && <Tag color="orange">{data.missingAlt}张图片未填Alt</Tag>}<Button size="small" onClick={() => setReload(n => n + 1)}>刷新容量</Button>{runtime.actor.role === 'admin' && <Button size="small" onClick={inspect}>查看可清理清单</Button>}</Space>} />}
    {/* 只读预检的状态、清单和说明分组显示，避免互相贴合。 */}
    <Modal title="文件清理只读预检" open={!!plan} onCancel={() => setPlan(undefined)} footer={<Button onClick={() => setPlan(undefined)}>关闭</Button>} width={800}><Space orientation="vertical" size={16} style={{ width: '100%' }}><Alert type="info" title={`候选${plan?.candidateCount || 0}个，共${bytesText(plan?.candidateBytes || 0)}`} description={plan?.note} /><Table size="small" rowKey="filename" dataSource={plan?.candidates} scroll={{ x: 650, y: 320 }} columns={[{ title: '文件哈希名', dataIndex: 'filename', ellipsis: true }, { title: '大小', dataIndex: 'bytes', render: bytesText }]} pagination={{ pageSize: 10 }} /><Typography.Text type="secondary">仅展示前2000个候选；本阶段不提供物理删除，派生文件可以按原资源重新生成。</Typography.Text></Space></Modal>
  </Space>;
}
export function MediaBatchActions({ selected, filteredIds, setIds }: { selected: MediaItem[]; filteredIds: string[]; setIds: (ids: string[]) => void }) {
  const runtime = useStudioRuntime(), { message } = App.useApp(), [folder, setFolder] = useState(''), [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ action: 'move' | 'remove'; items: MediaItem[]; folder: string; revision: number }>();
  const count = selected.length;
  const stale = !!confirmation && (confirmation.revision !== runtime.envelope.revision || count !== confirmation.items.length
    || confirmation.items.some(item => !selected.some(current => current.id === item.id && current.name === item.name && current.folder === item.folder)));

  function confirm(action: 'move' | 'remove') {
    if (count) setConfirmation({ action, items: selected, folder: folder.trim(), revision: runtime.envelope.revision });
  }

  async function apply() {
    if (!confirmation || stale || busy) return;
    const { action, items, folder: destination, revision } = confirmation;
    setBusy(true);
    try {
      // 确认清单和修订一起冻结；队列或另一标签页改过草稿后必须重新核对。
      await runtime.mutate(env => {
        if (env.revision !== revision) throw new RequestError(409, '草稿已更新，请重新核对所选素材。');
        return request<StudioEnvelope>('/api/media/batch', { method: 'POST', body: JSON.stringify({ expectedRevision: revision, ids: items.map(item => item.id), action, ...(action === 'move' ? { folder: destination } : {}) }) });
      });
      setIds([]);
      setConfirmation(undefined);
      message.success(action === 'move' ? '所选素材已移动' : '所选素材已移出草稿库');
    } catch (error) {
      if (error instanceof RequestError && error.status === 409) setConfirmation(undefined);
      message.error((error as Error).message);
    } finally { setBusy(false); }
  }

  const removing = confirmation?.action === 'remove';
  return <>
    <Flex gap={8} wrap style={{ marginBottom: 16 }}>
      <Button disabled={runtime.actor.role === 'viewer' || !filteredIds.length || busy} onClick={() => setIds(filteredIds)}>选择当前筛选</Button>
      <Button disabled={!count || busy} onClick={() => setIds([])}>清空选择（{count}）</Button>
      {!!count && <>
        <Input aria-label="批量目标文件夹" placeholder="目标文件夹名称" maxLength={100} style={{ width: 180 }} disabled={busy} value={folder} onChange={e => setFolder(e.target.value)} />
        <Button disabled={!folder.trim() || busy} onClick={() => confirm('move')}>移动到文件夹</Button>
        <Button danger disabled={busy} onClick={() => confirm('remove')}>移出所选</Button>
      </>}
    </Flex>
    <Modal open={!!confirmation} title={removing ? `移出 ${confirmation?.items.length} 份素材？` : `移动 ${confirmation?.items.length ?? 0} 份素材？`}
      okText={removing ? '移出素材库' : '确认移动'} cancelText="取消" confirmLoading={busy} closable={!busy}
      mask={{ closable: false }} keyboard={!busy} okButtonProps={{ danger: removing, disabled: stale }} cancelButtonProps={{ disabled: busy }}
      onCancel={() => setConfirmation(undefined)} onOk={apply}>
      {confirmation && <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        {stale && <Alert showIcon type="warning" title="草稿或勾选已变更，请关闭后重新核对素材。" />}
        {removing
          ? <Typography.Text type="secondary">仍被草稿使用的素材会拦住整批操作。历史文件会保留。</Typography.Text>
          : <Typography.Text>目标文件夹 <Typography.Text strong>{confirmation.folder}</Typography.Text></Typography.Text>}
        <Table size="small" rowKey="id" dataSource={confirmation.items} pagination={false} scroll={{ y: 240 }}
          columns={[
            { title: '素材名称', dataIndex: 'name', render: (name: string) => <Typography.Text style={{ overflowWrap: 'anywhere' }}>{name}</Typography.Text> },
            { title: '当前文件夹', dataIndex: 'folder', render: (name: string) => <Typography.Text type="secondary" style={{ overflowWrap: 'anywhere' }}>{name || '未分组'}</Typography.Text> },
          ]} />
      </Space>}
    </Modal>
  </>;
}
type Usage = { draft: { kind: string; id: string; name: string }[]; historical: { id: string; name: string; createdAt: string }[]; removableFromDraft: boolean };
export function MediaReferencePanel({ id }: { id: string }) {
  const [data, setData] = useState<Usage>(), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => { let active = true; setData(undefined); setError(''); void request<Usage>(`/api/media/${encodeURIComponent(id)}/usage`).then(r => { if (active) setData(r); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [id, reload]);
  return <Space orientation="vertical" style={{ width: '100%' }}><Typography.Title level={5}>素材使用位置</Typography.Title>{error && <Alert type="error" title={error} action={<Button onClick={() => setReload(n => n + 1)}>重试</Button>} />}{data && <><Descriptions column={1} size="small" items={data.draft.map(r => ({ key: `${r.kind}:${r.id}`, label: r.kind, children: r.name }))} />{!data.draft.length && <Typography.Text type="secondary">没有草稿页面、区块、产品、内容或样式/代码引用。</Typography.Text>}<Alert type={data.historical.length ? 'info' : 'success'} title={`${data.historical.length}个历史版本保留此文件`} description="移出草稿库不影响旧版本访问和回滚，文件不会物理删除。" />{!!data.historical.length && <Table rowKey="id" size="small" dataSource={data.historical} pagination={{ pageSize: 5 }} columns={[{ title: '发布版本', dataIndex: 'name' }]} />}</>}</Space>;
}
