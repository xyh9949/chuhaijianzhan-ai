'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Collapse, Descriptions, Drawer, Flex, Form, Input, Select, Space, Tag, Typography } from 'antd';
import { CheckCircleOutlined, DisconnectOutlined, GoogleOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import type { SeoSourceSummary, SeoGscConnection, SeoKeywordConnection } from '@/lib/seo-types';
import { request, useStudioRuntime } from '@/lib/studio-client';
import { readLocalRecovery } from '@/lib/local-recovery';
import { useLocalDraftGuard } from './useLocalDraftGuard';

const { Text, Paragraph } = Typography;
type Property = { siteUrl: string; permissionLevel: string };
type Props = { open: boolean; summary?: SeoSourceSummary; onClose: () => void; onChanged: () => Promise<void>; onConfigureAi: () => void };

/** 接口凭据只在当前表单内存中输入；恢复投影不含secret、password或token。 */
export default function SeoConnectionSettings({ open, summary, onClose, onChanged, onConfigureAi }: Props) {
  const runtime = useStudioRuntime(), { message } = App.useApp();
  const [clientId, setClientId] = useState(''), [clientSecret, setClientSecret] = useState(''), [clearGoogle, setClearGoogle] = useState(false), [property, setProperty] = useState('');
  const [login, setLogin] = useState(''), [password, setPassword] = useState(''), [clearKeyword, setClearKeyword] = useState(false);
  const [properties, setProperties] = useState<Property[]>([]), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const lock = useRef(false);
  const dirty = open && !!summary && (clientId !== summary.gsc.clientId || property !== summary.gsc.property || login !== summary.keywords.login || !!clientSecret || !!password || clearGoogle || clearKeyword);
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope: 'seo-connections', screen: 'seo', title: '搜索接口配置', dirty, busy: !!busy, snapshot: { clientId, login, property }, discard: () => { reset(); onClose(); } });
  function reset() { setClientId(summary?.gsc.clientId || ''); setProperty(summary?.gsc.property || ''); setLogin(summary?.keywords.login || ''); setClientSecret(''); setPassword(''); setClearGoogle(false); setClearKeyword(false); setError(''); }
  useEffect(() => {
    if (!open) return; reset();
    const saved = readLocalRecovery<{ clientId: string; login: string; property: string }>(runtime.actor.id, 'seo-connections', value => !!value && typeof value === 'object' && Object.keys(value).every(key => ['clientId','login','property'].includes(key)) && ['clientId','login','property'].every(key => typeof (value as Record<string, unknown>)[key] === 'string'));
    if (saved) { setClientId(saved.snapshot.clientId); setLogin(saved.snapshot.login); setProperty(saved.snapshot.property); }
    // 恢复仅包含公开标识和选项，密钥重新打开时不回填。
  }, [open]);
  async function run(name: string, work: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(name); setError('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : '连接操作未完成，表单仍保留。'); }
    finally { lock.current = false; setBusy(''); }
  }
  async function saveGoogle() {
    if (!summary) return;
    await run('保存Google设置', async () => {
      const saved = await request<SeoGscConnection>('/api/seo/sources/gsc', { method: 'PATCH', body: JSON.stringify({ expectedRevision: summary.gsc.revision, clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}), ...(clearGoogle ? { clearSecret: true } : {}), ...(property !== summary.gsc.property ? { property } : {}) }) });
      setClientId(saved.clientId); setProperty(saved.property); setClientSecret(''); setClearGoogle(false); guard.clear(); await onChanged(); message.success('Google设置已保存，尚未读取搜索数据。');
    });
  }
  async function saveKeywords() {
    if (!summary) return;
    await run('保存关键词设置', async () => {
      const saved = await request<SeoKeywordConnection>('/api/seo/sources/keywords', { method: 'PATCH', body: JSON.stringify({ expectedRevision: summary.keywords.revision, login: login.trim(), ...(password ? { password } : {}), ...(clearKeyword ? { clearSecret: true } : {}) }) });
      setLogin(saved.login); setPassword(''); setClearKeyword(false); guard.clear(); await onChanged(); message.success('关键词接口已保存，没有发起收费查询。');
    });
  }
  async function loadProperties() { await run('读取已授权网站', async () => { const value = await request<{ items: Property[] }>('/api/seo/sources/gsc/properties'); setProperties(value.items); if (!value.items.length) message.info('此Google账号尚无可用的网站资源，请先在Search Console验证网站。'); }); }
  return <>{guard.dialog}<Drawer title="连接搜索数据" open={open} size={680} onClose={() => { if (!busy) guard.ask(onClose); }} maskClosable={!busy} closable={!busy} footer={<Flex gap={12} align="center" justify="space-between" wrap><Text type="secondary">保存不发起搜索报告同步、收费查询或发布。</Text><Button disabled={!!busy} onClick={() => guard.ask(onClose)}>完成</Button></Flex>}>
    <Space orientation="vertical" size={20} style={{ width: '100%' }}>
      {summary?.mockMode && <Alert type="warning" showIcon title="当前是模拟数据环境" description="连接与报告仅用于本机验证，不代表真实Google账号或供应商数据。" />}
      <Alert type="info" showIcon title="使用你自己的账户和接口" description="Google只读授权用于读取搜索表现；关键词服务可能按查询收费。密钥加密保存在本实例，不放进网站或恢复草稿。未保存的密钥在刷新后需要重新填写。" />
      {error && <Alert type="error" showIcon title="操作未完成" description={error} action={<Button size="small" disabled={!!busy} onClick={() => void onChanged()}>读取最新连接状态</Button>} />}
      <div className="seo-settings-section">
        <Flex align="center" justify="space-between" gap={12} wrap><h3><GoogleOutlined /> Google Search Console</h3><Tag color={summary?.gsc.connected ? 'green' : 'default'}>{summary?.gsc.connected ? '已授权读取' : '未连接'}</Tag></Flex>
        <Paragraph type="secondary">先在自己的Google Cloud项目启用Search Console API，创建网页应用OAuth凭据，再把下方回调地址原样登记。连接只申请读取权限。</Paragraph>
        <Form layout="vertical">
          <Form.Item label="Google客户端ID"><Input aria-label="Google客户端ID" value={clientId} disabled={!!busy} maxLength={500} onChange={event => setClientId(event.target.value)} placeholder="你的Google OAuth客户端ID" /></Form.Item>
          <Form.Item label="Google客户端密钥" extra={summary?.gsc.hasClientSecret ? '已保存；留空保留，填写新值则替换。密钥不会回显。' : '由你自己的Google项目提供。'}><Input.Password aria-label="Google客户端密钥" value={clientSecret} disabled={!!busy || clearGoogle} autoComplete="new-password" onChange={event => setClientSecret(event.target.value)} placeholder={summary?.gsc.hasClientSecret ? '已配置，留空保留' : '填写你的客户端密钥'} /></Form.Item>
          {summary?.gsc.hasClientSecret && <Checkbox checked={clearGoogle} disabled={!!busy} onChange={event => { setClearGoogle(event.target.checked); if (event.target.checked) setClientSecret(''); }}>移除已保存的Google密钥并重新连接</Checkbox>}
          <div className="seo-settings-actions"><Button icon={<SaveOutlined />} loading={busy === '保存Google设置'} disabled={!!busy} onClick={() => void saveGoogle()}>保存Google设置</Button><Button type="primary" icon={<GoogleOutlined />} disabled={!!busy || dirty || !summary?.gsc.hasClientSecret || !summary.gsc.clientId} onClick={() => void run('准备Google授权', async () => { const value = await request<{ authorizationUrl: string }>('/api/seo/sources/gsc/connect', { method: 'POST', body: '{}' }); window.location.assign(value.authorizationUrl); })}>前往Google授权</Button></div>
          <Descriptions size="small" column={1} items={[{ key: 'redirect', label: '登记的回调地址', children: <Text copyable className="seo-break-word">{summary?.gsc.redirectUri || '读取连接状态后显示'}</Text> }, { key: 'scope', label: '授权范围', children: '仅读取Search Console网站和搜索数据，不修改Google网站设置。' }]} />
          {summary?.gsc.connected && <><div className="seo-settings-actions"><Button icon={<ReloadOutlined />} disabled={!!busy} loading={busy === '读取已授权网站'} onClick={() => void loadProperties()}>读取已授权网站</Button><Button danger icon={<DisconnectOutlined />} disabled={!!busy} onClick={() => void run('断开Google授权', async () => { const saved = await request<SeoGscConnection>('/api/seo/sources/gsc/disconnect', { method: 'POST', body: JSON.stringify({ expectedRevision: summary.gsc.revision }) }); setProperty(saved.property); setProperties([]); guard.clear(); await onChanged(); message.success('本实例已断开Google授权，原报告和网站内容保留。'); })}>断开授权</Button></div><Form.Item label="读取哪个网站" extra="先读取列表，再选择你已验证的网站；域资源和网址前缀按Google原值保存。"><Select aria-label="Google网站资源" value={property || undefined} placeholder="先读取已授权网站" disabled={!!busy} options={[...properties, ...(property && !properties.some(item => item.siteUrl === property) ? [{ siteUrl: property, permissionLevel: '' }] : [])].map(item => ({ value: item.siteUrl, label: item.siteUrl }))} onChange={setProperty} /></Form.Item><Button icon={<CheckCircleOutlined />} disabled={!!busy || !property || property === summary.gsc.property} onClick={() => void saveGoogle()}>使用这个网站</Button></>}
        </Form>
      </div>
      <div className="seo-settings-section"><h3>关键词数据 · DataForSEO</h3><Paragraph type="secondary">使用你自己的API登录名和API密码。保存不收费；只有你主动确认查询时，才向供应商请求所填关键词的Google Ads估计数据。</Paragraph><Form layout="vertical"><Form.Item label="API登录名"><Input aria-label="关键词API登录名" value={login} disabled={!!busy} maxLength={500} autoComplete="off" onChange={event => setLogin(event.target.value)} /></Form.Item><Form.Item label="API密码" extra={summary?.keywords.hasPassword ? '已保存；留空保留，填写新值替换。' : '这是供应商API密码，不是本系统登录密码。'}><Input.Password aria-label="关键词API密码" value={password} disabled={!!busy || clearKeyword} autoComplete="new-password" onChange={event => setPassword(event.target.value)} /></Form.Item>{summary?.keywords.hasPassword && <Checkbox checked={clearKeyword} disabled={!!busy} onChange={event => { setClearKeyword(event.target.checked); if (event.target.checked) setPassword(''); }}>移除已保存的关键词接口密码</Checkbox>}<div className="seo-settings-actions"><Button icon={<SaveOutlined />} disabled={!!busy} loading={busy === '保存关键词设置'} onClick={() => void saveKeywords()}>保存关键词设置</Button><Tag color={summary?.keywords.hasPassword ? 'green' : 'default'}>{summary?.keywords.hasPassword ? '接口已配置' : '未配置'}</Tag></div></Form></div>
      <Collapse size="small" items={[{ key: 'ai', label: 'AI优化建议由谁提供？', children: <Space orientation="vertical"><Text>统一使用“站点设置 → AI服务”中配置的模型。站内诊断、读取搜索数据和手动预览不调用模型；点“用我的AI建议”才使用自己的模型额度。</Text><Button disabled={!!busy} onClick={onConfigureAi}>AI服务设置</Button></Space> }, { key: 'help', label: '配置与费用说明', children: <Space orientation="vertical"><a href="https://developers.google.com/webmaster-tools/v1/prereqs" target="_blank" rel="noreferrer">Google Search Console API准备说明</a><a href="https://docs.dataforseo.com/v3/keywords_data-google_ads-search_volume-live/" target="_blank" rel="noreferrer">DataForSEO搜索量接口说明</a><Text type="secondary">Google授权可能需要项目测试用户或应用审核，由你的Google项目和账号决定。系统不会提供公共密钥或替你购买接口额度。</Text></Space> }]} />
    </Space>
  </Drawer></>;
}
