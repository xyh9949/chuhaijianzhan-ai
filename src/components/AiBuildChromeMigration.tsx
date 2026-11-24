'use client';

import { useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Flex, Form, List, Modal, Select, Space, Tag, Typography } from 'antd';
import { canAdoptAiGlobalChrome, legacyAiChromePageIds, type AiBuildChromeMigrationMode } from '@/lib/ai-build-shared-layout';
import type { AiBuildPage, AiBuildRunSummary, AiBuildUndoStatus } from '@/lib/ai-build-resume-types';
import type { StudioState } from '@/lib/types';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import AiDesignPreview from './AiDesignPreview';

type MigrationPage = AiBuildPage & { previewPath?: string };
type MigrationRun = AiBuildRunSummary & { operation?: string };
type MigrationPreview = {
  operation: 'shared-chrome';
  previewId: string; baseRevision: number; expiresAt?: string; appliedRevision?: number | null;
  beforePrefix: string; afterPrefix: string; pages: MigrationPage[]; warnings: string[];
} & Partial<AiBuildUndoStatus>;
type BuildEnvelope = StudioEnvelope & { buildUndo: AiBuildUndoStatus & { expiresAt: string } };
const getPreviewPath = (page: MigrationPage) => page.previewPath || (page.slug.includes(':') ? '' : page.slug);
const previewPathWithPrefix = (prefix: string, path: string) => prefix + (path === '/' ? '' : path);

/** 确认与撤销使用原建站事务，重开抽屉仍可从本人记录取回实际预览和回执。 */
export default function AiBuildChromeMigration({ state, onRequestOpen }: { state: StudioState; onRequestOpen: (open: () => void) => void }) {
  const runtime = useStudioRuntime(), { message, modal } = App.useApp();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pageId, setPageId] = useState<string>();
  const [mode, setMode] = useState<AiBuildChromeMigrationMode>('shared');
  const [includeCatalogue, setIncludeCatalogue] = useState(false);
  const [preview, setPreview] = useState<MigrationPreview>();
  const [sample, setSample] = useState<string>();
  const [runs, setRuns] = useState<MigrationRun[]>([]);
  const lock = useRef(false);
  const detected = new Set(legacyAiChromePageIds(state));
  const choices = state.pages.filter(page => detected.has(page.id));
  const selected = choices.find(page => page.id === pageId);
  const globalAvailable = selected?.slug === '/' && canAdoptAiGlobalChrome(state.siteLayout, state.settings.locales?.length);
  const inheritAvailable = state.siteLayout?.header.mode !== 'hidden' && state.siteLayout?.footer.mode !== 'hidden';
  const inspectable = preview?.pages.filter(page => !!getPreviewPath(page)) || [];
  const activeSample = inspectable.find(page => page.id === sample) || inspectable[0];
  const stale = !!preview && (preview.baseRevision !== runtime.envelope.revision || !!preview.expiresAt && Date.parse(preview.expiresAt) <= Date.now());

  async function perform(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '同步操作未完成，请重新核对工作区'); }
    finally { lock.current = false; setBusy(false); }
  }
  function showPreview(next: MigrationPreview) {
    if (next.operation !== 'shared-chrome' || !next.beforePrefix || !next.afterPrefix) throw Error('没有找到可用的头尾同步预览');
    setPreview(next);
    setSample(next.pages.find(page => !!getPreviewPath(page))?.id);
  }
  function loadHistory() {
    void perform(async () => {
      const result = await request<{ items: MigrationRun[] }>('/api/ai/build/runs');
      setRuns(result.items.filter(item => item.operation === 'shared-chrome'));
    });
  }
  function start() {
    onRequestOpen(() => { setOpen(true); loadHistory(); });
  }
  function prepare() {
    if (!selected) return;
    void perform(async () => {
      await runtime.flush();
      showPreview(await request<MigrationPreview>('/api/ai/build/chrome-migration', {
        method: 'POST', body: JSON.stringify({ pageId: selected.id, mode, ...(includeCatalogue ? { includeCatalogue: true } : {}) }),
      }));
    });
  }
  function resume(id: string) {
    void perform(async () => showPreview(await request<MigrationPreview>(`/api/ai/build/runs/${encodeURIComponent(id)}`)));
  }
  function commit(action: 'apply' | 'undo') {
    if (!preview) return;
    const record = preview, undo = action === 'undo';
    modal.confirm({
      title: undo ? '撤销这次头尾同步？' : '确认保存头尾同步？',
      content: undo ? '系统会先检查后续改动，再决定是否可以恢复原页面布局。' : '改动保存为草稿。你可以继续拖拽编辑，并通过发布管理更新公开网站。',
      okText: undo ? '确认撤销' : '确认保存',
      okButtonProps: { danger: undo },
      cancelText: '返回核对',
      onOk: () => perform(async () => {
        await runtime.mutate(async current => {
          const result = await request<BuildEnvelope>(`/api/ai/build/${action}`, {
            method: 'POST', body: JSON.stringify({ previewId: record.previewId, expectedRevision: undo ? current.revision : record.baseRevision }),
          });
          setPreview({ ...record, ...result.buildUndo, appliedRevision: undo ? record.appliedRevision : result.revision });
          return result;
        });
        message.success(undo ? '本次头尾同步已撤销' : '头尾同步已保存为草稿');
      }),
    });
  }
  const saved = preview?.appliedRevision != null;
  return <>
    <Button size="small" onClick={start}>同步旧 AI 页面</Button>
    <Modal title="同步旧 AI 页眉页脚" open={open} width={1260} style={{ maxWidth: 'calc(100vw - 24px)' }}
      maskClosable={!busy} closable={!busy} onCancel={() => { if (!busy) setOpen(false); }}
      footer={<Space wrap><Button disabled={busy} onClick={() => setOpen(false)}>关闭</Button>
        {preview && !saved && <Button type="primary" disabled={busy || stale || !activeSample} onClick={() => commit('apply')}>采用同步方案</Button>}
        {saved && <Button danger disabled={busy || !preview?.canUndo} onClick={() => commit('undo')}>撤销本次同步</Button>}
      </Space>}>
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        {error && <Alert type="error" showIcon title={error} />}
        {preview ? <>
          <Flex align="center" gap={8} wrap>
            <Typography.Text strong>{preview.pages.length} 个页面</Typography.Text>
            {saved && <Tag color={preview.undoneRevision == null ? 'green' : 'default'}>{preview.undoneRevision == null ? '已保存为草稿' : '已撤销'}</Tag>}
            <Button size="small" disabled={busy} onClick={() => resume(preview.previewId)}>刷新记录</Button>
            <Button size="small" disabled={busy} onClick={() => { setPreview(undefined); loadHistory(); }}>返回选择</Button>
          </Flex>
          {!!preview.warnings.length && <Alert type="info" showIcon title="同步后的变化" description={preview.warnings.map(warning => <div key={warning}>{warning}</div>)} />}
          {!saved && stale && <Alert type="warning" showIcon title="工作区已有修改或预览已过期，请返回重新预览。" />}
          {saved && !preview.canUndo && preview.undoReason && <Alert type="info" showIcon title={preview.undoReason} />}
          {activeSample && <>
            <Select aria-label="头尾同步预览页面" value={activeSample.id} onChange={setSample} style={{ width: 280, maxWidth: '100%' }}
              options={inspectable.map(page => ({ value: page.id, label: `${page.title} · ${page.slug}` }))} />
            <AiDesignPreview editId={`${preview.previewId}:${activeSample.id}`} afterLabel="同步后"
              beforeUrl={previewPathWithPrefix(preview.beforePrefix, getPreviewPath(activeSample))}
              afterUrl={previewPathWithPrefix(preview.afterPrefix, getPreviewPath(activeSample))} />
          </>}
          {inspectable.length < preview.pages.length && <Typography.Text type="secondary">其余影响页面：{preview.pages.filter(page => !getPreviewPath(page)).map(page => page.title).join('、')}</Typography.Text>}
        </> : <>
          <Alert type="info" showIcon title="把旧页面各自的头尾变成可以统一编辑的内容"
            description="选择一个由旧版 AI 创建的页面，会同时检查同一次生成的其他页面。可先看修改前后，再决定是否保存。" />
          <Form layout="vertical">
            <Form.Item label="旧 AI 页面">
              <Select aria-label="选择旧 AI 页面" disabled={busy || !choices.length} value={selected?.id} onChange={id => {
                const chosen = choices.find(page => page.id === id);
                setPageId(id);
                setMode(chosen?.slug === '/' && canAdoptAiGlobalChrome(state.siteLayout, state.settings.locales?.length) ? 'global' : 'shared');
                setIncludeCatalogue(false);
              }}
                placeholder={choices.length ? '选择这组页面中的任意一个' : '没有发现可直接同步的旧页面'}
                options={choices.map(page => ({ value: page.id, label: `${page.title} · ${page.slug}` }))} />
            </Form.Item>
            <Form.Item label="同步范围">
              <Select aria-label="选择头尾同步范围" value={mode} onChange={setMode} disabled={!selected || busy}
                options={[
                  { value: 'shared', label: '仅统一这组页面的头尾与菜单' },
                  { value: 'global', label: '将这组头尾设为全站默认', disabled: !globalAvailable },
                  { value: 'inherit', label: '改用现有全站头尾', disabled: !inheritAvailable },
                ]} />
            </Form.Item>
            <Form.Item>
              <Checkbox checked={includeCatalogue} disabled={!selected || busy} onChange={event => setIncludeCatalogue(event.target.checked)}>
                同时开启旧 AI 产品目录的搜索、分类和分页
              </Checkbox>
            </Form.Item>
            <Button type="primary" disabled={!selected || busy} loading={busy} onClick={prepare}>查看同步前后</Button>
          </Form>
          {!!runs.length && <List size="small" header="近期同步记录" dataSource={runs} renderItem={run => <List.Item
            actions={[<Button key="read" size="small" disabled={busy} onClick={() => resume(run.id)}>查看记录</Button>]}>
            {run.pages?.[0]?.title || '头尾同步'} · {run.undoneRevision != null ? '已撤销' : run.appliedRevision != null ? '已采用' : '待确认'}
          </List.Item>} />}
        </>}
      </Space>
    </Modal>
  </>;
}
