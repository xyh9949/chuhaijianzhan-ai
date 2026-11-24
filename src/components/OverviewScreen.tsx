'use client';

import { useEffect, useState } from 'react';
import { Button, Card, Empty, Image, Table, Tag, Tooltip } from 'antd';
import {
  ArrowRightOutlined, AuditOutlined, CheckCircleOutlined, CloudUploadOutlined, EditOutlined,
  EyeOutlined, FileTextOutlined, GlobalOutlined, InboxOutlined,
  LinkOutlined, MessageOutlined, NotificationOutlined, RightOutlined,
  ShoppingOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import type { PageItem, ScreenProps } from '@/lib/types';
import './overview.css';
import { formatDate } from '@/lib/date-format';
import { getInquiryFollowUpState, summarizeInquiryFollowUps } from '@/lib/inquiry-tracking';
import { useStudioRuntime } from '@/lib/studio-client';
import { openLaunchSettings } from './LaunchCheck';
import { PAGE_PUBLICATION_STATE, pagePublicationState } from '@/lib/page-publication-state';

type OverviewProps = ScreenProps & { onPublish: () => void; onShowNotices: () => void };
const languageNames: Record<string, string> = { en: '英语', 'zh-CN': '简体中文', es: '西班牙语', de: '德语', fr: '法语' };

/** 工作台只汇总现有记录，不从示例时间、产品草稿推断新增量或实际在线状态。 */
export default function OverviewScreen({ state, update, navigate, onPublish, onShowNotices }: OverviewProps) {
  const canBuild = useStudioRuntime().actor.role === 'admin';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []);
  const publicationState = pagePublicationState(state.releases);
  const drafts = state.pages.filter(page => publicationState(page) === 'draft');
  const modified = state.pages.filter(page => publicationState(page) === 'modified');
  const pendingPages = drafts.length + modified.length;
  const activeSnapshot = state.releases.find(release => release.status === 'current')?.snapshot;
  const publishedPages = Array.isArray(activeSnapshot?.pages) ? activeSnapshot.pages.length : 0;
  const publishedProducts = Array.isArray(activeSnapshot?.products) ? activeSnapshot.products.length : 0;
  const followUps = summarizeInquiryFollowUps(state.inquiries, undefined, now);
  const pendingInquiries = followUps.pending;
  // 待处理和到期记录可能重叠；待办徽标按询盘去重，未排期、无效或已归档不额外产生提醒。
  const inquiryTaskCount = state.inquiries.filter(item => item.status !== 'archived' && item.qualification !== 'invalid' && (item.status === 'new' || getInquiryFollowUpState(item, now) === 'overdue')).length;
  const missingCovers = state.products.filter((product) => !product.image?.trim()).length;
  const currentRelease = state.releases.find((release) => release.status === 'current');
  const homePage = state.pages.find((page) => page.id === 'home') || state.pages.find((page) => page.slug === '/') || state.pages[0];
  const language = languageNames[state.settings.language] || state.settings.language || '—';

  // 首页 ID 沿用已有记录；无页面时转到页面管理，不写入不存在的活动页面。
  function openPage(pageId: string | undefined, mode: 'editor' | 'preview') {
    if (!pageId) { navigate('pages'); return; }
    update({ activePageId: pageId });
    navigate(mode);
  }

  const stats = [
    { label: '网站页面', value: state.pages.length, detail: `公开 ${publishedPages} · 待更新 ${modified.length} · 草稿 ${drafts.length}`, icon: <FileTextOutlined />, action: () => navigate('pages') },
    { label: '产品内容', value: state.products.length, detail: `已展示 ${publishedProducts} · 草稿 ${state.products.filter(product => product.status === 'draft').length}`, icon: <ShoppingOutlined />, action: () => navigate('products') },
    { label: '待跟进询盘', value: pendingInquiries, detail: `逾期 ${followUps.overdue} · 共 ${state.inquiries.length} 条询盘`, icon: <MessageOutlined />, action: () => navigate('inquiries'), readable: true },
    { label: '待发布页面', value: pendingPages, detail: '包含新草稿和已有页面的更新', icon: <CloudUploadOutlined />, action: onPublish },
  ];
  const tasks = [
    { title: '客户询盘跟进', description: inquiryTaskCount || followUps.scheduled ? `待跟进 ${pendingInquiries} · 逾期 ${followUps.overdue} · 已排期 ${followUps.scheduled}` : '暂无待跟进或到期的询盘', count: inquiryTaskCount, icon: <InboxOutlined />, action: () => navigate('inquiries'), readable: true },
    { title: '页面发布检查', description: pendingPages ? `${pendingPages} 个页面有待发布内容` : '暂无待发布页面', count: pendingPages, icon: <AuditOutlined />, action: onPublish },
    { title: '产品资料检查', description: missingCovers ? `${missingCovers} 个产品尚未填写封面` : '当前产品均已填写封面地址', count: missingCovers, icon: <ShoppingOutlined />, action: () => navigate('products') },
  ];

  return <div className="ov-screen">
    <header className="ov-page-header mb-6 flex flex-wrap items-start justify-between gap-4">
      <div><h1>工作台</h1><p>内容、询盘与网站更新，一目了然。</p></div>
      <div className="flex flex-wrap items-center gap-3">
        {currentRelease && <Button className="ov-outline-action" icon={<GlobalOutlined />} href="/" target="_blank" rel="noopener noreferrer">查看已发布网站</Button>}
        <Button className="ov-outline-action" icon={<EyeOutlined />} onClick={() => openPage(homePage?.id, 'preview')}>预览草稿</Button>
        <Button type={canBuild ? 'default' : 'primary'} icon={<EditOutlined />} onClick={() => openPage(homePage?.id, 'editor')}>编辑网站</Button>
        {canBuild && <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => navigate('site-journey')}>开始 / 继续建站</Button>}
        {canBuild && <Button icon={<CheckCircleOutlined />} onClick={() => openLaunchSettings()}>上线检查</Button>}
      </div>
    </header>

    <Card className="ov-card ov-summary mb-5" classNames={{ body: 'p-0' }}>
      <div className="grid grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => <Button type="text" key={stat.label} className="ov-stat" disabled={stat.readable ? false : undefined} onClick={stat.action}>
          <span className="ov-stat-icon">{stat.icon}</span>
          <span className="ov-stat-content"><span className="ov-stat-label">{stat.label}</span><strong className="ov-stat-number">{stat.value}</strong><span className="ov-stat-detail">{stat.detail}</span></span>
        </Button>)}
      </div>
    </Card>

    <div className="ov-middle-grid mb-5 grid grid-cols-1 items-stretch gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(330px,1fr)]">
      <Card className="ov-card ov-site-card min-w-0" title={<h2>网站概况</h2>} extra={<Tag className="ov-local-status" icon={<EyeOutlined />}>草稿预览</Tag>} classNames={{ body: 'ov-site-body' }}>
        <div className="ov-site-cover">
          <div className="ov-site-mini-header flex items-center justify-between gap-3"><strong>{state.settings.name || '未命名站点'}</strong><span>静态演示封面</span></div>
          <div className="ov-site-image"><Image src="/images/interior.jpg" alt="现代客厅演示封面，非当前网站实时截图" preview={false} width="100%" height={214} styles={{ image: { objectFit: 'cover', objectPosition: 'center 52%' } }} /><div className="ov-cover-caption"><span>网站内容以实际预览为准</span><Button size="small" onClick={() => openPage(homePage?.id, 'preview')}>打开预览 <ArrowRightOutlined /></Button></div></div>
        </div>
        <div className="ov-site-details flex flex-wrap items-center gap-x-5 gap-y-2">
          <Button type="link" className="ov-domain-link" icon={<LinkOutlined />} onClick={() => navigate('settings')}>{state.settings.domain || '尚未设置域名'}</Button>
          <span className="ov-site-language"><GlobalOutlined /> 默认语言：{language}</span>
        </div>
        <div className="ov-site-version flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2"><span>当前公开版本 <strong>{currentRelease?.title || (currentRelease?'已发布':'尚未发布')}</strong></span><span>记录时间 <strong>{currentRelease ? formatDate(currentRelease.date, state.settings.timezone) : '—'}</strong></span></div>
          <Button type="link" onClick={() => navigate('settings')}>管理网站</Button>
        </div>
      </Card>

      <Card className="ov-card ov-tasks-card min-w-0" title={<h2>待处理事项</h2>} extra={<Button type="link" onClick={onShowNotices}>查看全部</Button>} classNames={{ body: 'ov-tasks-body' }}>
        <div className="flex flex-col">
          {tasks.map((task) => <Button type="text" className="ov-task-row" key={task.title} disabled={task.readable ? false : undefined} onClick={task.action}><span className="ov-task-icon">{task.icon}</span><span className="ov-task-copy"><strong>{task.title}</strong><span>{task.description}</span></span><span className={`ov-task-count${task.count === 0 ? ' is-zero' : ''}`}>{task.count}</span><RightOutlined className="ov-task-arrow" /></Button>)}
        </div>
        <div className="ov-publish-callout mt-5 flex flex-wrap items-center gap-3"><NotificationOutlined /><div><strong>准备好更新网站内容？</strong><span>先检查发布范围，再更新公开网站。</span></div><Button type="primary" onClick={onPublish}>检查并发布 <ArrowRightOutlined /></Button></div>
      </Card>
    </div>

    <Card className="ov-card ov-pages-card" title={<h2>页面列表</h2>} extra={<Button type="link" onClick={() => navigate('pages')}>全部页面 <ArrowRightOutlined /></Button>} classNames={{ body: 'p-0' }}>
      <Table<PageItem> dataSource={state.pages.slice(0, 4)} rowKey="id" pagination={false} scroll={{ x: 740 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有网站页面"><Button type="primary" onClick={() => navigate('pages')}>创建页面</Button></Empty> }} columns={[
        { title: '页面', key: 'title', width: 300, render: (_, page) => <div className="ov-table-name flex items-center gap-3"><FileTextOutlined /><div className="min-w-0"><Button type="link" onClick={() => openPage(page.id, 'editor')}>{page.title}</Button><span>{page.slug}</span></div></div> },
        { title: '页面类型', dataIndex: 'type', width: 160, render: (value: string) => value || '—' },
        { title: '状态', key: 'status', width: 130, render: (_, page) => { const status = PAGE_PUBLICATION_STATE[publicationState(page)]; return <Tag className="ov-table-status" color={status.color}>{status.label}</Tag>; } },
        { title: '记录更新时间', dataIndex: 'updated', width: 180, render: (value: string) => <span className="ov-table-date">{formatDate(value, state.settings.timezone)}</span> },
        { title: '操作', key: 'action', width: 140, render: (_, page) => <div className="flex items-center gap-2"><Button type="link" onClick={() => openPage(page.id, 'editor')}>编辑</Button><Tooltip title={`预览${page.title}`}><Button type="text" icon={<EyeOutlined />} aria-label={`预览${page.title}`} onClick={() => openPage(page.id, 'preview')} /></Tooltip></div> },
      ]} />
    </Card>
    <p className="ov-data-note">客户提交的网站询盘会显示在询盘列表中，邮件通知结果可在详情查看。这里尚未接入访问人数统计。</p>
  </div>;
}
