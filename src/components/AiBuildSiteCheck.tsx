'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Collapse, Flex, List, Select, Space, Tag, Typography } from 'antd';
import { AimOutlined, CheckCircleOutlined, MobileOutlined } from '@ant-design/icons';
import type { AiBuildCheckJourney, AiBuildCheckLocation, AiBuildCheckStatus, AiBuildSiteCheckReport } from '@/lib/ai-build-site-check-types';
import type { AiBuildPage } from '@/lib/ai-build-resume-types';
import { request } from '@/lib/studio-client';
import AiVisualReview from './AiVisualReview';

type Props = ({ previewId: string; pages: AiBuildPage[]; draftRevision?: never; draftPageId?: never } |
  { draftRevision: number; draftPageId?: string; previewId?: never; pages?: never }) & {
  disabled?: boolean;
  onOpenPage?: (path: string, previewPath: string) => void;
  onLocate?: (location: AiBuildCheckLocation) => void;
};
const fullWidth = { width: '100%', minWidth: 0 };
const pageNames: Record<AiBuildCheckStatus, string> = { checked: '已检查', warning: '需核对', skipped: '未检查' };
const colors: Record<AiBuildCheckStatus, string> = { checked: 'green', warning: 'orange', skipped: 'default' };
const entryNames: Record<AiBuildCheckJourney['entry'], string> = { home: '首页询盘路径', product: '产品详情询盘路径' };
const journeyLabels: Record<AiBuildCheckJourney['status'], [string, string]> = { checked: ['路径已验证', 'green'], warning: ['路径需处理', 'orange'], skipped: ['未验证', 'default'], 'form-only': ['只发现表单', 'blue'] };

/** 候选检查和已保存草稿分开。切换版本取消旧任务，旧报告不再用于定位当前编辑区。 */
export default function AiBuildSiteCheck({ previewId, pages, draftRevision, draftPageId, disabled = false, onOpenPage, onLocate }: Props) {
  const controller = useRef<AbortController | null>(null);
  const [report, setReport] = useState<AiBuildSiteCheckReport>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [visualBusy, setVisualBusy] = useState(false);
  const [visualPage, setVisualPage] = useState('');

  useEffect(() => {
    setError(''); setBusy(false);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [previewId, draftRevision, draftPageId]);

  async function run() {
    if (disabled || visualBusy || controller.current) return;
    const active = new AbortController();
    controller.current = active; setBusy(true); setError('');
    try {
      const result = await request<AiBuildSiteCheckReport>('/api/ai/build/check', {
        method: 'POST', body: JSON.stringify(previewId ? { previewId } : { draftRevision, ...(draftPageId ? { draftPageId } : {}) }), signal: active.signal,
      });
      if (!active.signal.aborted && (previewId ? result.previewId === previewId : result.source === 'draft' && result.baseRevision === draftRevision)) setReport(result);
    } catch (cause) {
      if (!active.signal.aborted) setError(cause instanceof Error ? cause.message : '整站检查未完成，请稍后重试');
    } finally {
      if (controller.current === active) { controller.current = null; setBusy(false); }
    }
  }

  function cancel() {
    controller.current?.abort(); controller.current = null; setBusy(false);
  }

  const current = report && (previewId ? report.previewId === previewId : report.source === 'draft' && report.baseRevision === draftRevision) ? report : undefined;
  const previousDraft = report?.source === 'draft' && draftRevision !== undefined;
  const options = (current?.pages.filter(page => page.path).map(page => ({ value: page.pageId, label: page.title })) ||
    (pages || []).filter(page => !page.slug.includes(':')).map(page => ({ value: page.id, label: page.title })));
  const selected = options.some(option => option.value === visualPage) ? visualPage : options[0]?.value;
  const needsReview = current?.pages.filter(page => page.status === 'warning').length || 0;
  const incomplete = current?.pages.filter(page => page.status === 'skipped').length || 0;
  const checked = current ? current.pages.length - incomplete : 0;
  const locateButton = (location: AiBuildCheckLocation | undefined) => location && onLocate
    ? <Button size="small" icon={<AimOutlined aria-hidden="true" />} disabled={disabled || busy} onClick={() => onLocate(location)}>{!previewId && !location.target ? '查看所在页' : '定位区块'}</Button>
    : null;
  return <Card size="small" title="整站检查" styles={{ body: { minWidth: 0, overflowWrap: 'anywhere' } }}>
    <Space orientation="vertical" size={14} style={fullWidth} styles={{ item: { minWidth: 0 } }}>
      <Flex justify="space-between" align="start" wrap gap={12}>
        <Typography.Text type="secondary">{previewId ? '用手机预览检查排版、按钮和通往询盘表单的路径。' : '用最新保存的草稿检查手机排版、按钮和询盘路径。'}</Typography.Text>
        <Space wrap>
          <Button icon={<CheckCircleOutlined aria-hidden="true" />} disabled={disabled || visualBusy} loading={busy} onClick={() => void run()}>{current || previousDraft ? '重新检查整站' : '检查整站'}</Button>
          {busy && <Button onClick={cancel}>取消检查</Button>}
        </Space>
      </Flex>
      {busy && <Typography.Text type="secondary" role="status">正在逐页读取真实预览并检查手机询盘路径。</Typography.Text>}
      {previousDraft && !current && <Alert type="info" showIcon title="草稿已更新，重新检查即可看到本次修改后的结果。" />}
      {error && <Alert type="warning" showIcon title={error} />}
      {current && <>
        <Typography.Text role="status">已检查 {checked}/{current.pages.length} 页{needsReview ? ` · ${needsReview} 页需核对` : ''}{incomplete ? ` · ${incomplete} 页未检查` : ''}</Typography.Text>
        <Typography.Text type="secondary">每次最多 {current.pageLimit} 页，动态详情每类只抽一条。{current.languages.some(language => language.notSampled > 0) ? `未覆盖的网址：${current.languages.filter(language => language.notSampled > 0).map(language => `${language.code} ${language.notSampled} 条`).join('、')}。` : '本次没有额外未覆盖的网址。'}</Typography.Text>
        <List size="small" dataSource={current.journeys} renderItem={journey => <List.Item>
          <Space orientation="vertical" size={3} style={fullWidth}>
            <Space wrap><Typography.Text strong>{entryNames[journey.entry]}</Typography.Text><Tag color={journeyLabels[journey.status][1]}>{journeyLabels[journey.status][0]}</Tag></Space>
            <Typography.Text type="secondary">{journey.note}</Typography.Text>
            {locateButton(journey.location)}
            {journey.steps.length > 0 && <Typography.Text type="secondary">{journey.steps.map(step => step.label).join(' → ')}{journey.form ? ' → 询盘表单' : ''}</Typography.Text>}
            {journey.form && <Typography.Text type="secondary">{journey.form.fields} 个表单字段 · 提交效果需上线后单独验证。</Typography.Text>}
          </Space>
        </List.Item>} />
        <Collapse size="small" items={[
          { key: 'pages', label: '逐页手机检查', children: <List size="small" dataSource={current.pages} renderItem={page => <List.Item>
            <Flex justify="space-between" align="start" gap={10} wrap style={fullWidth}>
              <Space orientation="vertical" size={3} style={{ flex: '1 1 200px', minWidth: 0 }}>
                <Space wrap><Typography.Text strong>{page.title}</Typography.Text><Tag color={colors[page.status]}>{pageNames[page.status]}</Tag></Space>
                {page.path && <Typography.Text type="secondary">{page.path}</Typography.Text>}
                {page.notes.map((note, index) => <Typography.Text type="secondary" key={index}>{note}</Typography.Text>)}
                {page.issues.map((issue, index) => <Flex key={`${issue.code}-${issue.location?.nodeId || index}`} gap={6} wrap align="center">
                  <Typography.Text>{issue.widths.join('、')}px · {issue.message}</Typography.Text>
                  {locateButton(issue.location)}
                </Flex>)}
              </Space>
              {page.path && page.previewPath && (onOpenPage
                ? <Button size="small" icon={<MobileOutlined aria-hidden="true" />} onClick={() => onOpenPage(page.path!, page.previewPath!)}>{previewId ? '查看手机' : '查看页面'}</Button>
                : <Button size="small" icon={<MobileOutlined aria-hidden="true" />} href={page.previewPath} target="_blank" rel="noopener noreferrer">打开预览</Button>)}
            </Flex>
          </List.Item>} /> },
          { key: 'coverage', label: '检查范围', children: <List split={false} size="small" dataSource={current.coverage} renderItem={item => <List.Item>{item}</List.Item>} /> },
        ]} />
      </>}
      {previewId && selected && <Space orientation="vertical" size={8} style={fullWidth} styles={{ item: { minWidth: 0 } }}>
        <Select aria-label="选择视觉检查页面" value={selected} options={options} onChange={setVisualPage} style={{ width: '100%', maxWidth: 380 }} disabled={disabled || busy || visualBusy}/>
        <AiVisualReview target={{ kind: 'site-build', id: previewId, pageId: selected }} disabled={disabled || busy} onBusyChange={setVisualBusy} />
      </Space>}
    </Space>
  </Card>;
}
