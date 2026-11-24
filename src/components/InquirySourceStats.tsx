'use client';

import { useState } from 'react';
import { Collapse, Empty, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { Inquiry } from '@/lib/types';
import { inquiriesInPeriod } from '@/lib/inquiry-tracking';
import { ATTRIBUTION_UNVERIFIED_LABEL, attributionChannelLabel, inquirySourceLabel } from '@/lib/inquiry-attribution';

type Dimension = 'channel' | 'page' | 'campaign';
type SourceRow = { key: string; label: string; detail: string; total: number; qualified: number; invalid: number; unreviewed: number };

/** 仅对真实收到的询盘分组；缺失来源保留独立分组，不推算访客人数或转化率。 */
function sourceRows(inquiries: Inquiry[], dimension: Dimension): SourceRow[] {
  const groups = new Map<string, SourceRow>();
  for (const inquiry of inquiries) {
    let label = inquirySourceLabel(inquiry), detail = inquiry.attribution ? attributionChannelLabel(inquiry.attribution.channel) : '';
    if (dimension === 'page') { label = inquiry.sourcePath || (inquiry.origin === 'manual' ? '后台人工录入' : '来源页面未记录'); detail = ''; }
    if (dimension === 'campaign') { label = inquiry.attribution?.utmCampaign || (inquiry.origin === 'manual' ? '后台人工录入' : '活动名称未记录'); detail = ''; }
    if (detail === label) detail = '';
    const key = `${label}\u0000${detail}`;
    const row = groups.get(key) || { key, label, detail, total: 0, qualified: 0, invalid: 0, unreviewed: 0 };
    row.total += 1;
    row[inquiry.qualification || 'unreviewed'] += 1;
    groups.set(key, row);
  }
  return [...groups.values()].sort((left, right) => right.total - left.total || left.label.localeCompare(right.label, 'zh-CN'));
}

export default function InquirySourceStats({ inquiries }: { inquiries: Inquiry[] }) {
  const [days, setDays] = useState<7 | 30 | null>(30), [dimension, setDimension] = useState<Dimension>('channel');
  const period = inquiriesInPeriod(inquiries, days), rows = sourceRows(period.items, dimension);
  const totals = rows.reduce((sum, row) => ({ total: sum.total + row.total, qualified: sum.qualified + row.qualified, invalid: sum.invalid + row.invalid, unreviewed: sum.unreviewed + row.unreviewed }), { total: 0, qualified: 0, invalid: 0, unreviewed: 0 });
  return <Collapse className="cs-source-stats" styles={{ body: { padding: 'var(--admin-panel-space,24px)' }, header: { padding: '16px var(--admin-panel-space,24px)' } }} items={[{ key: 'sources', label: '询盘来源统计', children: <Space orientation="vertical" size={16} style={{ width: '100%' }}>
    <div className="cs-source-stats-toolbar"><Space wrap><Typography.Text>收到时间</Typography.Text><Select aria-label="询盘来源统计期间" value={days === null ? 'all' : String(days)} onChange={value => setDays(value === 'all' ? null : Number(value) as 7 | 30)} options={[{ value: '7', label: '近7天' }, { value: '30', label: '近30天' }, { value: 'all', label: '全部' }]} /></Space><Space wrap><Typography.Text>共 {totals.total} 条</Typography.Text><Tag color="green">有效 {totals.qualified}</Tag><Tag>无效 {totals.invalid}</Tag><Tag color="blue">待判断 {totals.unreviewed}</Tag></Space></div>
    <Tabs activeKey={dimension} onChange={value => setDimension(value as Dimension)} items={[{ key: 'channel', label: '按渠道' }, { key: 'page', label: '按来源页面' }, { key: 'campaign', label: '按活动' }]} />
    <Table<SourceRow> rowKey="key" size="small" dataSource={rows} pagination={{ pageSize: 8, hideOnSinglePage: true, showSizeChanger: false }} scroll={{ x: 520 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个期间还没有询盘记录" /> }} columns={[
      { title: dimension === 'page' ? '来源页面' : dimension === 'campaign' ? '活动名称' : '渠道 / 来源', key: 'source', render: (_, row) => <Space orientation="vertical" size={2} className="cs-source-label"><Typography.Text>{row.label}</Typography.Text>{row.detail && <Typography.Text type="secondary">{row.detail}</Typography.Text>}</Space> },
      { title: '收到询盘', dataIndex: 'total', width: 95, align: 'right' }, { title: '有效', dataIndex: 'qualified', width: 75, align: 'right' }, { title: '无效', dataIndex: 'invalid', width: 75, align: 'right' }, { title: '待判断', dataIndex: 'unreviewed', width: 85, align: 'right' },
    ]} />
    <Typography.Paragraph type="secondary" style={{ margin: 0 }}>统计全站已收到的询盘，不受上方列表筛选影响；{days === null ? '全部期间' : `近${days}天按过去${days}×24小时筛选`}。有效性由成员人工判断。{ATTRIBUTION_UNVERIFIED_LABEL}，不代表已核实的投放效果。{period.undated ? days === null ? `包含 ${period.undated} 条日期未记录的旧询盘。` : `${period.excludedUndated} 条旧询盘日期未记录，未计入当前期间。` : ''}</Typography.Paragraph>
  </Space> }]} />;
}
