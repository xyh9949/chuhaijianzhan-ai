'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Col, Collapse, Divider, Flex, Form, Grid, Input, InputNumber, Row, Select, Space, Spin, Switch, Tag, Typography } from 'antd';
import type { MailSettingsInput, MailSettingsSummary, MailSettingsTestResult } from '@/lib/mail-settings-types';
import { request, useStudioRuntime } from '@/lib/studio-client';

type Draft = Omit<MailSettingsInput, 'expectedRevision' | 'to' | 'password' | 'clearPassword'> & { toText: string; password: string; clearPassword: boolean };
type Errors = Partial<Record<'host' | 'from' | 'toText' | 'port' | 'password' | 'testRecipient', string>>;
const emptyDraft: Draft = { enabled: false, host: '', port: 587, security: 'starttls', username: '', from: '', toText: '', password: '', clearPassword: false, allowLocal: false };
const email = (value: string) => value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const recipients = (value: string) => value.split(/[,;\n，；]/).map(item => item.trim()).filter(Boolean);
const asDraft = (value: MailSettingsSummary): Draft => ({ enabled: value.enabled, host: value.host, port: value.port, security: value.security, username: value.username, from: value.from, toText: value.to.join('\n'), password: '', clearPassword: false, allowLocal: value.allowLocal });
const sameDraft = (draft: Draft, value: MailSettingsSummary) => JSON.stringify(draft) === JSON.stringify(asDraft(value));

/** 邮件口令只在本表单内存保留；导航确认保护输入，但绝不写入本地恢复、浏览器存储或站点草稿。 */
export default function MailSettings() {
  const { actor } = useStudioRuntime(), { message, modal } = App.useApp(), screens = Grid.useBreakpoint(), id = useId();
  const [value, setValue] = useState<MailSettingsSummary>(), [draft, setDraft] = useState<Draft>(emptyDraft);
  const [revision, setRevision] = useState<number>(), [testRecipient, setTestRecipient] = useState(actor.email || '');
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | 'reload' | ''>('load'), [error, setError] = useState(''), [success, setSuccess] = useState(''), [errors, setErrors] = useState<Errors>({});
  const mounted = useRef(false), lock = useRef(false), sequence = useRef(0), confirmation = useRef<{ destroy: () => void } | undefined>(undefined);
  const changed = !!value && !sameDraft(draft, value), operationBusy = busy === 'save' || busy === 'test' || busy === 'reload';
  const latest = useRef({ changed, operationBusy, value }); latest.current = { changed, operationBusy, value };
  function discard() { latest.current.changed = false; setDraft(latest.current.value ? asDraft(latest.current.value) : emptyDraft); setError(''); setSuccess(''); setErrors({}); }
  function ask(next: () => void) {
    if (latest.current.operationBusy) { message.info('正在等待邮件设置操作结果，请稍后再离开'); return; }
    if (!latest.current.changed) { next(); return; }
    if (confirmation.current) return;
    confirmation.current = modal.confirm({ title: '放弃尚未保存的邮件设置？', content: '离开会清除本次填写的密码和配置输入，已经保存的邮件设置不受影响。', okText: '放弃修改并离开', cancelText: '继续编辑', okButtonProps: { danger: true }, onOk: () => { discard(); confirmation.current = undefined; next(); }, afterClose: () => { confirmation.current = undefined; } });
  }
  const askRef = useRef(ask); askRef.current = ask;
  useLayoutEffect(() => {
    if (actor.role !== 'admin') return;
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<{ proceed?: () => void }>).detail;
      if (event.defaultPrevented || !detail?.proceed || !latest.current.changed && !latest.current.operationBusy) return;
      event.preventDefault(); event.stopImmediatePropagation();
      askRef.current(() => {
        // 清除内存输入后重新走原导航保护，让其他分区自己的未保存检查继续生效。
        const retry = new CustomEvent('form-studio:before-navigate', { cancelable: true, detail });
        if (window.dispatchEvent(retry)) detail.proceed!();
      });
    };
    window.addEventListener('form-studio:before-navigate', navigate, true);
    return () => window.removeEventListener('form-studio:before-navigate', navigate, true);
  }, [actor.role]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (latest.current.changed || latest.current.operationBusy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload);
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (actor.role === 'admin') void run('load'); else setBusy('');
    return () => { mounted.current = false; sequence.current++; lock.current = false; confirmation.current?.destroy(); };
    // 只在挂载或账号变更后读取；其他窗口的保存不会覆盖本表单未提交的密码。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor.id, actor.role]);
  function change(values: Partial<Draft>) { setDraft(previous => ({ ...previous, ...values })); setErrors({}); setError(''); setSuccess(''); }
  function validate(): Errors {
    const result: Errors = {}, to = recipients(draft.toText), host = draft.host.trim(), from = draft.from.trim();
    if ((draft.enabled || host) && (!host || host.length > 253 || /[\s/\\@?#]/.test(host))) result.host = '填写邮箱服务商提供的服务器名称，例如 smtp.example.com，不要加 https://。';
    if ((draft.enabled || from) && !email(from)) result.from = '请输入有效的发件邮箱。';
    if ((draft.enabled || to.length) && (!to.length || to.length > 5 || to.some(item => !email(item)) || new Set(to.map(item => item.toLowerCase())).size !== to.length)) result.toText = '请填写1至5个不重复的有效邮箱，用逗号或换行分开。';
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) result.port = '端口需为1至65535之间的整数。';
    const normalizedHost = (name: string) => name.toLowerCase().replace(/\.$/, '');
    const changedIdentity = !!value?.hasPassword && (normalizedHost(host) !== normalizedHost(value.host) || draft.port !== value.port || draft.security !== value.security || draft.username.trim() !== value.username);
    if (changedIdentity && !draft.password && !draft.clearPassword) result.password = '邮件服务或账号已更换，请填写对应密码或明确移除原密码。';
    if (draft.enabled && draft.username.trim() && (!value?.hasPassword || draft.clearPassword) && !draft.password) result.password = '请填写邮箱密码或授权码，或先关闭询盘邮件通知。';
    return result;
  }
  function fieldError(name: keyof Errors) { const text = validate()[name]; setErrors(previous => ({ ...previous, [name]: text })); }
  async function run(kind: 'load' | 'save' | 'test' | 'reload') {
    if (actor.role !== 'admin' || lock.current) return;
    if (kind === 'save') { const validation = validate(); setErrors(validation); if (Object.values(validation).some(Boolean)) return; }
    if (kind === 'test') {
      if (latest.current.changed) { setError('请先保存当前邮件设置，再发送测试邮件。'); return; }
      if (!email(testRecipient.trim())) { setErrors(previous => ({ ...previous, testRecipient: '请输入有效的测试收件邮箱。' })); return; }
    }
    if (['save', 'test'].includes(kind) && (!value || revision === undefined)) { setError('请先成功读取邮件设置。'); return; }
    lock.current = true; setBusy(kind); setError(''); setSuccess(''); const operation = ++sequence.current;
    const live = () => mounted.current && sequence.current === operation;
    try {
      if (kind === 'save') {
        const input: MailSettingsInput = { expectedRevision: revision!, enabled: draft.enabled, host: draft.host.trim(), port: draft.port, security: draft.security, username: draft.username.trim(), from: draft.from.trim(), to: recipients(draft.toText), allowLocal: draft.allowLocal, ...(draft.password ? { password: draft.password } : {}), ...(draft.clearPassword ? { clearPassword: true } : {}) };
        const next = await request<MailSettingsSummary>('/api/notifications/settings', { method: 'PATCH', body: JSON.stringify(input) });
        if (!live()) return;
        setValue(next); setRevision(next.revision); setDraft(asDraft(next)); latest.current.changed = false;
        setSuccess('邮件设置已保存，立即生效。未发送测试邮件。');
      } else if (kind === 'test') {
        const result = await request<MailSettingsTestResult>('/api/notifications/settings/test', { method: 'POST', body: JSON.stringify({ expectedRevision: revision, recipient: testRecipient.trim() }) });
        if (live()) setSuccess(result.message);
      } else {
        const next = await request<MailSettingsSummary>('/api/notifications/settings');
        if (!live()) return;
        setValue(next); setRevision(next.revision);
        if (kind === 'load' || !latest.current.changed) { setDraft(asDraft(next)); setTestRecipient(next.to[0] || actor.email || ''); }
        if (kind === 'reload') setSuccess('已读取最新配置版本，当前输入仍保留；请核对后再保存。');
      }
    } catch (cause) { if (live()) setError(cause instanceof Error ? cause.message : '邮件操作未完成，当前输入仍保留。'); }
    finally { if (live()) { lock.current = false; setBusy(''); } }
  }
  if (actor.role !== 'admin') return <Alert type="info" showIcon title="邮件通知设置需要管理员权限" description="询盘查看与跟进仍可在原页面使用。" />;
  return <Card title="邮件通知" className="sys-panel" style={{ maxWidth: 920, minWidth: 0 }} styles={{ body: { padding: screens.md ? 24 : 16 } }}>
    <Space orientation="vertical" size={20} style={{ width: '100%', minWidth: 0 }}>
      <Typography.Paragraph style={{ margin: 0 }}>客户提交询盘后先保存到后台，再通知你指定的邮箱。这里配置发送服务，与网站展示的公开联系邮箱分开。</Typography.Paragraph>
      {busy === 'load' && <Flex align="center" gap={8}><Spin size="small" /><Typography.Text type="secondary">正在读取邮件设置…</Typography.Text></Flex>}
      {value && <Flex align="center" gap={8} wrap><Tag color={value.enabled ? 'green' : 'default'}>{value.enabled ? '询盘通知已开启' : '询盘通知已关闭'}</Tag><Typography.Text type="secondary">{value.source === 'environment' ? '沿用服务器配置' : '由后台管理'}</Typography.Text></Flex>}
      {value?.source === 'environment' && <Alert showIcon type={value.mode === 'mock' ? 'warning' : 'info'} title={value.mode === 'mock' ? '当前为本地模拟，不会发送真实邮件' : '当前沿用服务器配置'} description="保存后改由本页面管理，立即生效，无需重启。已有密码不会显示在这里。" />}
      <Form layout="vertical" disabled={!!busy || !value}>
        <Form.Item label="询盘邮件通知" extra="关闭后询盘仍正常保存；开启后新询盘自动通知，已有待发送任务也会继续处理。"><Switch aria-label="启用询盘邮件通知" checked={draft.enabled} checkedChildren="开启" unCheckedChildren="关闭" onChange={enabled => change({ enabled })} /></Form.Item>
        <Row gutter={[20, 0]}>
          <Col xs={24} md={12}><Form.Item label="发件邮箱" htmlFor={`${id}-from`} required={draft.enabled} validateStatus={errors.from ? 'error' : undefined} help={errors.from} extra="邮件中显示的发件地址，请使用该邮件服务允许的邮箱。"><Input id={`${id}-from`} aria-label="发件邮箱" value={draft.from} maxLength={254} placeholder="website@example.com" onBlur={() => fieldError('from')} onChange={event => change({ from: event.target.value })} /></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item label="SMTP服务器" htmlFor={`${id}-host`} required={draft.enabled} validateStatus={errors.host ? 'error' : undefined} help={errors.host} extra="由邮箱服务商提供，例如 smtp.example.com。"><Input id={`${id}-host`} aria-label="SMTP服务器" value={draft.host} maxLength={253} autoComplete="off" placeholder="smtp.example.com" onBlur={() => fieldError('host')} onChange={event => change({ host: event.target.value })} /></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item label="登录账号" htmlFor={`${id}-username`} extra="通常是完整邮箱地址，以服务商要求为准。"><Input id={`${id}-username`} aria-label="邮件登录账号" value={draft.username} maxLength={320} autoComplete="off" placeholder="website@example.com" onChange={event => change({ username: event.target.value })} /></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item label="邮箱密码 / 授权码" htmlFor={`${id}-password`} validateStatus={errors.password ? 'error' : undefined} help={errors.password} extra={value?.hasPassword ? '已保存；同一服务和账号下留空保留。更换服务或账号需重新填写。' : '部分邮箱需要专用SMTP授权码，不是网页登录密码。'}><Input.Password id={`${id}-password`} aria-label="邮箱密码或授权码" value={draft.password} maxLength={4096} autoComplete="new-password" placeholder={value?.hasPassword ? '已保存 · 留空保持' : '填写密码或SMTP授权码'} disabled={!!busy || !value || draft.clearPassword} onChange={event => change({ password: event.target.value })} /></Form.Item></Col>
        </Row>
        <Form.Item label="连接方式" extra={`当前端口：${draft.port}。不确定时请查看邮箱服务商的SMTP说明。`}><Select aria-label="邮件连接方式" value={draft.security} options={[{ value: 'tls', label: '加密连接（常用465端口）' }, { value: 'starttls', label: 'STARTTLS加密升级（常用587端口）' }]} onChange={security => change({ security, port: security === 'tls' ? 465 : 587 })} /></Form.Item>
        <Form.Item label="接收询盘的邮箱" htmlFor={`${id}-to`} required={draft.enabled} validateStatus={errors.toText ? 'error' : undefined} help={errors.toText} extra="最多5个邮箱，用逗号或换行分开。可以与发件邮箱相同。"><Input.TextArea id={`${id}-to`} aria-label="接收询盘的邮箱" value={draft.toText} maxLength={1500} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="sales@example.com" onBlur={() => fieldError('toText')} onChange={event => change({ toText: event.target.value })} /></Form.Item>
        <Collapse items={[{ key: 'advanced', label: '更多连接选项（高级）', children: <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <Form.Item label="自定义SMTP端口" validateStatus={errors.port ? 'error' : undefined} help={errors.port} style={{ margin: 0 }}><InputNumber aria-label="自定义SMTP端口" min={1} max={65535} precision={0} value={draft.port} onChange={port => port !== null && change({ port })} /></Form.Item>
          <Checkbox checked={draft.allowLocal} onChange={event => change({ allowLocal: event.target.checked })}>允许连接本机或内网邮件服务</Checkbox>
          <Typography.Text type="secondary">“本机”指运行网站的服务器。仅在使用自己的邮件中继服务时开启；加密校验仍保持启用。</Typography.Text>
          {value?.hasPassword && <Checkbox checked={draft.clearPassword} onChange={event => change({ clearPassword: event.target.checked, password: '' })}>保存时移除现有邮件密码</Checkbox>}
        </Space> }]} />
      </Form>
      {changed && <Typography.Text type="secondary">还有未保存的设置；保存后才能测试。</Typography.Text>}
      {error && <Alert type="error" showIcon title={error} action={<Button size="small" disabled={!!busy} loading={busy === 'reload'} onClick={() => void run('reload')}>读取最新配置</Button>} />}
      {success && <Alert type="success" showIcon title={success} />}
      <Flex justify="end"><Button type="primary" disabled={!!busy || !value || !changed} loading={busy === 'save'} onClick={() => void run('save')}>保存邮件设置</Button></Flex>
      <Divider style={{ margin: 0 }} />
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text strong>发送一封测试邮件</Typography.Text>
        <Typography.Text type="secondary">只向下面的邮箱发送固定测试内容，不带客户询盘资料。关闭自动通知时，也可以测试已保存的完整邮件服务。</Typography.Text>
        <Form layout="vertical" disabled={!!busy || !value}><Form.Item label="测试收件邮箱" htmlFor={`${id}-test-recipient`} validateStatus={errors.testRecipient ? 'error' : undefined} help={errors.testRecipient} style={{ marginBottom: 0 }}><Input id={`${id}-test-recipient`} aria-label="测试收件邮箱" value={testRecipient} maxLength={254} onChange={event => { setTestRecipient(event.target.value); setErrors(previous => ({ ...previous, testRecipient: undefined })); setSuccess(''); }} /></Form.Item></Form>
        <Flex gap={12} wrap align="center"><Button loading={busy === 'test'} disabled={!!busy || changed || !value || !value.configured && value.mode !== 'mock'} onClick={() => void run('test')}>发送测试邮件</Button><Typography.Text type="secondary">{value?.mode === 'mock' ? '当前只模拟生成，不会真实发送。' : '服务接受邮件不等于已经进入收件箱，请同时检查垃圾邮件。'}</Typography.Text></Flex>
      </Space>
      <Typography.Text type="secondary">历史未配置的通知不会自动补发，可在询盘详情手动重试。关闭会停止领取新任务，正在发送的邮件可能仍会完成。</Typography.Text>
    </Space>
  </Card>;
}
