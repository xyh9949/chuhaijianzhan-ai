'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Collapse, Flex, Grid, List, Space, Spin, Tag, Typography } from 'antd';
import { CheckCircleOutlined, GlobalOutlined, ReloadOutlined } from '@ant-design/icons';
import type { Screen } from '@/lib/types';
import type { LaunchCheckReport, LaunchCheckItem } from '@/lib/launch-check-types';
import { request, useStudioRuntime } from '@/lib/studio-client';
import { requestLocalLeave } from '@/lib/local-recovery';
import { formatDate } from '@/lib/date-format';

const STATUS: Record<LaunchCheckItem['status'], { label: string; color?: string }> = {
  configured: { label: '已配置 · 待验证', color: 'blue' }, unverified: { label: '尚未验证' }, passed: { label: '检查通过', color: 'green' },
  attention: { label: '需要处理', color: 'orange' }, failed: { label: '检查失败', color: 'red' }, 'not-applicable': { label: '本次不适用' },
};
const validTabs = ['general', 'ai', 'mail', 'discovery', 'domain', 'language', 'backup', 'members', 'launch'];
const validScreens: Screen[] = ['overview', 'settings', 'site-journey', 'pages', 'products', 'media', 'inquiries', 'templates', 'releases', 'seo', 'global-design'];
const networkEvidence = new Set(['public-home', 'public-robots', 'public-sitemap', 'public-indexing', 'public-canonical']);
/** 网络抽样可能早于最近本地检查；分别计算证据期限，不能用较新的local回执为旧网络证据续期。 */
function itemExpiresAt(item: LaunchCheckItem) {
  if (!item.checkedAt) return undefined;
  const lifetime = networkEvidence.has(item.id) ? 10 * 60000 : ['ai-connection', 'mail-test'].includes(item.id) && item.status === 'passed' ? 24 * 3600000 : undefined;
  const stamp = Date.parse(item.checkedAt); return lifetime !== undefined && Number.isFinite(stamp) ? stamp + lifetime : undefined;
}

/** 定位设置仍走原未保存保护；地址只保存分区，不夹带检查数据、口令或自动执行动作。 */
export function openLaunchSettings(tab = 'launch') {
  if (!validTabs.includes(tab)) return;
  requestLocalLeave(() => {
    const url = new URL(location.href); url.searchParams.set('settings', tab); url.hash = 'settings';
    history.pushState(history.state, '', url.href); window.dispatchEvent(new HashChangeEvent('hashchange'));
    window.dispatchEvent(new CustomEvent('form-studio:open-settings-tab', { detail: { tab } }));
  }, 'launch-settings');
}

/** 检查只给当前证据和修复入口；配置就绪、已发布、外部可访问与搜索收录分别说明。 */
export default function LaunchCheck({ navigate, embedded = false }: { navigate: (screen: Screen) => void; embedded?: boolean }) {
  const runtime = useStudioRuntime(), screens = Grid.useBreakpoint();
  const [report, setReport] = useState<LaunchCheckReport>(), [busy, setBusy] = useState<'read' | 'local' | 'public-website' | ''>('read'), [error, setError] = useState(''), [now, setNow] = useState(Date.now);
  const mounted = useRef(false), lock = useRef(false), sequence = useRef(0);
  const refreshedExpiry = useRef('');
  const admin = runtime.actor.role === 'admin';
  useEffect(() => { mounted.current = true; lock.current = false; if (admin) void read(); else setBusy(''); return () => { mounted.current = false; lock.current = false; sequence.current++; }; }, [runtime.actor.id, admin]);
  async function read() {
    if (!admin || lock.current) return;
    lock.current = true; const epoch = ++sequence.current; setBusy('read'); setError('');
    try { const next = await request<LaunchCheckReport>('/api/launch-check'); if (mounted.current && epoch === sequence.current) setReport(next); }
    catch (cause) { if (mounted.current && epoch === sequence.current) setError(cause instanceof Error ? cause.message : '上线状态暂未读到，请稍后重试。'); }
    finally { if (mounted.current && epoch === sequence.current) { lock.current = false; setBusy(''); } }
  }
  const expires = report ? [report.lastCheck ? Date.parse(report.lastCheck.expiresAt) : undefined, ...report.items.map(itemExpiresAt)].filter((value): value is number => value !== undefined && Number.isFinite(value)) : [];
  const nextExpiry = expires.length ? Math.min(...expires) : undefined;
  const expired = nextExpiry !== undefined && nextExpiry <= now;
  const expiryKey = report ? JSON.stringify([report.lastCheck?.id, report.lastCheck?.expiresAt, ...report.items.filter(item => itemExpiresAt(item) !== undefined).map(item => [item.id, item.checkedAt, item.status])]) : '';
  useEffect(() => {
    if (!report || nextExpiry === undefined) return;
    // 每组已过期证据只自动GET一次；失败后仍安排其他证据的未来期限，不能被旧期限遮住。
    const dueKey = (stamp: number) => {
      const keys = [...(report.lastCheck && Date.parse(report.lastCheck.expiresAt) <= stamp ? [report.lastCheck.id] : []), ...report.items.filter(item => { const expiry = itemExpiresAt(item); return expiry !== undefined && expiry <= stamp; }).map(item => `${item.id}:${item.checkedAt}`)];
      return keys.length ? JSON.stringify(keys) : '';
    };
    const update = (visibility = false) => {
      if (!mounted.current) return;
      const stamp = Date.now(), key = dueKey(stamp); setNow(stamp);
      if (key && !lock.current && (visibility || refreshedExpiry.current !== key)) { refreshedExpiry.current = key; void read(); }
    };
    const stamp = Date.now(), key = dueKey(stamp), future = expires.filter(value => value > stamp);
    const delay = key && !lock.current && refreshedExpiry.current !== key ? 0 : future.length ? Math.min(...future) - stamp + 20 : undefined;
    const timer = delay === undefined ? undefined : setTimeout(() => update(), Math.min(delay, 2147483647));
    const visible = () => { if (document.visibilityState === 'visible') update(true); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [nextExpiry, expiryKey, busy, now]);
  async function inspect(kind: 'local' | 'public-website') {
    if (!admin || lock.current) return;
    lock.current = true; const epoch = ++sequence.current; setBusy(kind); setError('');
    try {
      await runtime.flush(); const env = runtime.getEnvelope();
      const next = await request<LaunchCheckReport>('/api/launch-check/check', { method: 'POST', body: JSON.stringify({ expectedRevision: env.revision, expectedReleaseId: env.activeReleaseId, checks: [kind] }) });
      if (mounted.current && epoch === sequence.current) setReport(next);
    } catch (cause) { if (mounted.current && epoch === sequence.current) setError(cause instanceof Error ? cause.message : '检查暂未完成，原设置和网站保持。'); }
    finally { if (mounted.current && epoch === sequence.current) { lock.current = false; setBusy(''); } }
  }
  function act(item: LaunchCheckItem) {
    const action = item.action; if (!action || !!busy) return;
    if (action.screen === 'settings') { openLaunchSettings(action.settingsTab && validTabs.includes(action.settingsTab) ? action.settingsTab : 'general'); return; }
    if (validScreens.includes(action.screen as Screen)) navigate(action.screen as Screen);
  }
  if (!admin) return <Alert type="info" showIcon title="上线检查需要管理员权限" />;
  const stale = !!report && (report.revision !== runtime.envelope.revision || report.releaseId !== runtime.envelope.activeReleaseId);
  const expiredItems = report?.items.filter(item => { const expiry = itemExpiresAt(item); return expiry !== undefined && expiry <= now; }) || [];
  const displayedItems = report?.items.map(item => expiredItems.includes(item) ? { ...item, status: 'unverified' as const, message: '这项结果只适用于之前的核对时间，当前已过期，需要重新主动验证。' } : item) || [];
  const displayedSummary = report ? { ...report.summary, passed: report.summary.passed - expiredItems.filter(item => item.status === 'passed').length, needsAttention: report.summary.needsAttention - expiredItems.filter(item => ['attention', 'failed'].includes(item.status)).length, unverified: report.summary.unverified + expiredItems.filter(item => item.status !== 'unverified').length } : undefined;
  const content = <Space orientation="vertical" size={20} style={{ width: '100%', minWidth: 0 }}>
    {embedded && <Typography.Title level={4} style={{ margin: 0 }}>上线检查</Typography.Title>}
    <Typography.Paragraph style={{ margin: 0 }}>把网站资料、正式网址、邮件和备份一起核对。这里只根据已有证据显示状态，检查不会自动发布、发送邮件或调用AI。</Typography.Paragraph>
    <Flex gap={12} wrap>
      <Button type="primary" icon={<CheckCircleOutlined />} loading={busy === 'local'} disabled={!!busy} onClick={() => void inspect('local')}>检查本站资料</Button>
      <Button icon={<GlobalOutlined />} loading={busy === 'public-website'} disabled={!!busy || !report?.publicUrl} onClick={() => void inspect('public-website')}>检查正式网站连接</Button>
      <Button icon={<ReloadOutlined />} loading={busy === 'read'} disabled={!!busy} onClick={() => void read()}>刷新已知状态</Button>
    </Flex>
    <Typography.Text type="secondary">正式连接检查会访问已保存的正式网站。AI和邮件测试需到对应设置中主动操作；配置齐全不代表服务已经验证。</Typography.Text>
    {error && <Alert type="warning" showIcon title={error} />}
    {expired && <Alert type="info" showIcon title="部分检查依据已到期，需要重新核对" description={busy ? '正在操作，旧的通过结果已标为过期；完成后只读取已知状态，不会自动连接正式网站、调用AI或发邮件。' : '已到期的证据不再作为当前通过结果。刷新只读取已知状态；正式网站、AI和邮件仍须分别主动验证。'} />}
    {stale && <Alert type="info" showIcon title="草稿或公开版本已有变化，请重新检查" description="下面是上一次读取的结果，不代表最新网站已经通过。" />}
    {busy === 'read' && !report && <Flex gap={8}><Spin size="small" /><Typography.Text type="secondary">正在读取上线状态…</Typography.Text></Flex>}
    {report && <>
      <Flex gap={8} wrap><Tag color="green">检查通过 {displayedSummary!.passed}</Tag><Tag color="orange">需处理 {displayedSummary!.needsAttention}</Tag><Tag color="blue">已配置待验证 {displayedSummary!.configured}</Tag><Tag>尚待核实 {displayedSummary!.unverified}</Tag>{report.summary.notApplicable > 0 && <Tag>本次不适用 {report.summary.notApplicable}</Tag>}<Typography.Text type="secondary">共 {report.summary.total} 项 · {report.releaseId ? '已有公开版本' : '尚未发布'}</Typography.Text></Flex>
      <Typography.Text type="secondary" style={{ overflowWrap: 'anywhere' }}>正式网址：{report.publicUrl || '尚未填写'}{report.lastCheck ? ` · 最近主动检查：${formatDate(report.lastCheck.createdAt, runtime.envelope.state.settings.timezone)}` : ' · 尚无主动检查记录'}</Typography.Text>
      <List bordered size="small" dataSource={displayedItems} style={{ background: 'var(--surface, #fff)', minWidth: 0 }} renderItem={item => <List.Item style={{ display: 'block', padding: screens.md ? '18px 20px' : 16 }}>
        <Space orientation="vertical" size={10} style={{ width: '100%', minWidth: 0 }}>
          <Flex justify="space-between" align="center" gap={12} wrap><Space size={8} wrap><Typography.Text strong>{item.title}</Typography.Text><Tag color={STATUS[item.status].color}>{expiredItems.some(value => value.id === item.id) ? '证据已过期 · 待验证' : STATUS[item.status].label}</Tag></Space>{item.action && <Button size="small" disabled={!!busy} onClick={() => act(item)}>{item.action.label}</Button>}</Flex>
          <Typography.Paragraph style={{ margin: 0, overflowWrap: 'anywhere' }}>{item.message}</Typography.Paragraph>
          {item.checkedAt && <Typography.Text type="secondary">核对时间：{formatDate(item.checkedAt, runtime.envelope.state.settings.timezone)}</Typography.Text>}
          {!!item.evidence?.length && <Collapse size="small" ghost items={[{ key: 'evidence', label: '查看检查依据', children: <Space orientation="vertical" size={6} style={{ width: '100%' }}>{item.evidence.map((value, index) => <Typography.Text type="secondary" style={{ overflowWrap: 'anywhere' }} key={index}>{value}</Typography.Text>)}</Space> }]} />}
        </Space>
      </List.Item>} />
      <Alert type="info" showIcon title="上线准备与收录、效果需要分别核对" description="通过检查不代表Google已经收录、邮件已经进入收件箱，或AI设计已经得到客户认可。没有执行或缺少证据的项目会继续显示待验证。" />
    </>}
  </Space>;
  return embedded ? <section aria-label="上线检查">{content}</section> : <Card title="上线检查" className="sys-panel" styles={{ body: { padding: screens.md ? 24 : 16 } }}>{content}</Card>;
}
