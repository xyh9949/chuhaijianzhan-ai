'use client';
import { useMemo, useState } from 'react';
import { Button, Card, Col, Flex, Modal, Row, Segmented, Select, Space, Tag, Typography } from 'antd';
import { ArrowRightOutlined, DesktopOutlined, EyeOutlined, ExportOutlined, MobileOutlined, TabletOutlined } from '@ant-design/icons';
import { STARTER_KITS, createStarterSnapshot, type StarterKind } from '@/lib/starter-kits';
import './starter-showcase.css';

/** 完整案例只读预览；选用仍交给整站包的版本预检和显式确认，不在此处写入站点。 */
export default function StarterShowcase({ onChoose, busy }: { onChoose: (kind: StarterKind) => void; busy: boolean }) {
  const [preview, setPreview] = useState<StarterKind>();
  const [path, setPath] = useState('/');
  const [device, setDevice] = useState('desktop');
  const kit = STARTER_KITS.find(item => item.id === preview);
  const pages = useMemo(() => {
    if (!preview) return [];
    const snapshot = createStarterSnapshot(preview);
    return snapshot.pages.map(page => {
      // 动态模板预览选取所属模型的第一条记录；无记录时不伪造详情地址。
      const record = page.contentModelId ? snapshot.contentEntries?.find(entry => entry.modelId === page.contentModelId) : snapshot.products[0];
      const slug = page.slug.includes(':slug') ? record?.slug || record?.id : undefined;
      return { label: `${page.title}${slug ? ' · 示例详情' : ''}`, value: slug ? page.slug.replace(':slug', slug) : page.slug };
    }).filter(page => !page.value.includes(':'));
  }, [preview]);
  const url = preview ? `/preview/~starter/${preview}${path === '/' ? '' : path}` : '';
  function open(kind: StarterKind) { setPath('/'); setDevice('desktop'); setPreview(kind); }
  return <div className="starter-showcase">
    <Flex justify="space-between" gap={16} wrap className="starter-showcase-intro">
      <div><Typography.Title level={4}>从一套完整网站开始</Typography.Title><Typography.Paragraph type="secondary">先看整站效果，再按自己的品牌自由调整。首页、内页、动态内容和全站页眉页脚都能编辑。</Typography.Paragraph></div>
      <Tag>{STARTER_KITS.length} 种行业方向 · {STARTER_KITS.reduce((sum, item) => sum + item.pageCount, 0)} 个页面与模板</Tag>
    </Flex>
    <Row gutter={[24, 24]}>{STARTER_KITS.map(item => <Col xs={24} md={12} xxl={6} key={item.id}>
      <Card className="starter-showcase-card" styles={{ body: { padding: 20 } }} cover={<Button type="text" block className="starter-showcase-cover" onClick={() => open(item.id)} aria-label={`预览${item.name}`}><img src={item.cover} alt={`${item.name}实际首页效果`} /><span><EyeOutlined /> 浏览完整网站</span></Button>}>
        <Flex gap={8} wrap className="starter-showcase-labels"><Tag color={item.recommended ? 'blue' : undefined}>{item.recommended ? '推荐默认主题' : item.industry}</Tag><Typography.Text type="secondary">{item.pageCount} 个页面与模板</Typography.Text></Flex>
        <Typography.Title level={4}>{item.name}</Typography.Title><Typography.Text className="starter-showcase-style">{item.style}</Typography.Text>
        <Typography.Paragraph type="secondary" className="starter-showcase-description">{item.description}</Typography.Paragraph>
        <Flex gap="8px 6px" wrap className="starter-showcase-features">{item.features.map(feature => <Tag key={feature}>{feature}</Tag>)}</Flex>
        <Flex gap={8} wrap><Button icon={<EyeOutlined />} onClick={() => open(item.id)}>完整预览</Button><Button type={item.recommended ? 'primary' : 'default'} disabled={busy} onClick={() => onChoose(item.id)}>选用此案例 <ArrowRightOutlined /></Button></Flex>
      </Card>
    </Col>)}</Row>
    <Typography.Paragraph type="secondary" className="starter-showcase-note">概念演示：公司、产品与项目用于展示建站效果。选用后请替换为自己的真实资料；不会自动发布。</Typography.Paragraph>
    <Modal className="starter-preview-modal" title={kit ? `完整网站预览 · ${kit.name}` : '完整网站预览'} open={!!preview} width="calc(100vw - 48px)" style={{ top: 24, maxWidth: 1600 }} onCancel={() => setPreview(undefined)} destroyOnHidden footer={<Flex justify="space-between" gap={12} wrap><Typography.Text type="secondary">可点击网站导航与内容卡片浏览内页。预览为私有演示。</Typography.Text><Space><Button onClick={() => setPreview(undefined)}>关闭预览</Button><Button type="primary" disabled={busy} onClick={() => { if (preview) onChoose(preview); setPreview(undefined); }}>选用此案例</Button></Space></Flex>}>
      <Flex gap={12} justify="space-between" align="center" wrap className="starter-preview-toolbar">
        <Select aria-label="案例预览页面" value={path} onChange={setPath} options={pages} style={{ width: 260, maxWidth: '100%' }} />
        <Segmented aria-label="案例预览尺寸" value={device} onChange={setDevice} options={[{ value: 'desktop', label: '桌面', icon: <DesktopOutlined /> }, { value: 'tablet', label: '平板', icon: <TabletOutlined /> }, { value: 'mobile', label: '手机', icon: <MobileOutlined /> }]} />
        <Button href={url} target="_blank" rel="noopener noreferrer" icon={<ExportOutlined />}>单独打开</Button>
      </Flex>
      <div className="starter-preview-stage">{preview && <iframe key={preview} title={`完整案例 ${preview}`} src={url} referrerPolicy="no-referrer" style={{ width: device === 'mobile' ? 390 : device === 'tablet' ? 768 : '100%', maxWidth: '100%' }} />}</div>
    </Modal>
  </div>;
}
