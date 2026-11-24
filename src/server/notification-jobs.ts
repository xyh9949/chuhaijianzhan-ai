import { randomUUID } from 'node:crypto';
import type { Inquiry } from '../lib/types';
import { formatInquiryItems } from '../lib/inquiry-items';
import { getDatabase, getDataDirectory } from './database';
import { ApiError } from './http';
import { deliverConfiguredMail, loadMailConfiguration, mailDeliveryErrorCode, mailRuntimeSummary } from './mail-settings';

export interface NotificationJob { id: string; inquiry_id: string; status: 'pending' | 'processing' | 'sent' | 'mock_sent' | 'failed' | 'unconfigured'; attempts: number; next_attempt: number; lease_token: string | null; lease_until: number | null; error_code: string; provider_id: string; created_at: string; updated_at: string; }
const email = (v: string) => v.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v);
/** 邮件配置只取实例私表或原部署环境；公开定义/提交/快照不能指定收件人或传输凭据。 */
export function notificationConfiguration() {
  const config = mailRuntimeSummary();
  return { ...config, configured: config.enabled && config.configured, secure: config.security === 'tls' };
}
export function notificationStatus() { const config = notificationConfiguration(); return { mode: config.mode, configured: config.configured }; }
export function enqueueNotification(inquiryId: string, now = Date.now()) {
  const stamp = new Date(now).toISOString(), id = `notify-${randomUUID()}`;
  getDatabase().prepare('INSERT INTO cms_notification_job(id,inquiry_id,status,next_attempt,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, inquiryId, notificationConfiguration().configured ? 'pending' : 'unconfigured', now, stamp, stamp);
  return id;
}
export function listNotificationJobs(inquiryId?: string) { return getDatabase().prepare(`SELECT * FROM cms_notification_job${inquiryId ? ' WHERE inquiry_id=?' : ''} ORDER BY created_at DESC,id DESC LIMIT 2000`).all(...(inquiryId ? [inquiryId] : [])) as NotificationJob[]; }
export function notificationMail(inquiry: Inquiry, config = notificationConfiguration()) {
  // 只发纯文本；用户邮箱只作经过校验的reply-to，不参与to/from/envelope。
  const answers = inquiry.answers?.map(a => `${a.label}: ${a.displayValue ?? (a.value === null ? '(not provided)' : a.value === true ? 'Yes' : a.value === false ? 'No' : a.value)}`).join('\n');
  const items = formatInquiryItems(inquiry.items);
  return { from: config.mode === 'mock' ? 'local-mock@example.invalid' : config.from, to: config.mode === 'mock' ? ['local-receiver@example.invalid'] : config.to, replyTo: email(inquiry.email || '') ? inquiry.email : undefined, subject: `[Website inquiry] ${inquiry.formName || 'Contact form'}`.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 180), text: `Received: ${inquiry.date}\nSource: ${inquiry.sourcePath || '(manual entry)'}\n\n${answers || `Name: ${inquiry.name}\nCompany: ${inquiry.company}\nEmail: ${inquiry.email}\nMessage: ${inquiry.message}`}${items ? `\n\nRequested products\n${items}` : ''}`, disableFileAccess: true, disableUrlAccess: true };
}
/** 数据库租约负责跨进程互斥。外发后崩溃仍可能重投，属于至少一次语义，不承诺精确一次。 */
export async function processNotificationJob(now = Date.now(), deliver?: (mail: ReturnType<typeof notificationMail>) => Promise<string>): Promise<boolean> {
  if (!notificationConfiguration().configured) return false;
  const directory = getDataDirectory();
  const config = loadMailConfiguration();
  const startedAt = Date.now();
  const db = getDatabase();
  const claimed = db.transaction(() => {
    // 多进程可在预读后关闭或修改服务；领取事务内复核，避免停用时仍消耗任务次数。
    const latest = notificationConfiguration();
    if (!latest.configured || latest.revision !== config.revision || latest.source !== config.source) return;
    db.prepare("UPDATE cms_notification_job SET status='failed',lease_token=NULL,lease_until=NULL,error_code='LEASE_EXPIRED',updated_at=? WHERE attempts>=5 AND ((status='processing' AND lease_until<=?) OR status='pending')").run(new Date(now).toISOString(), now);
    // 新后台配置只自动通知新询盘；历史未配置任务需管理员逐条重试，防启用后静默补发。
    if (config.source === 'environment') db.prepare("UPDATE cms_notification_job SET status='pending', next_attempt=? WHERE status='unconfigured'").run(now);
    const job = db.prepare("SELECT j.*,i.payload_json FROM cms_notification_job j JOIN cms_inquiry i ON i.id=j.inquiry_id WHERE j.attempts<5 AND ((j.status='pending' AND j.next_attempt<=?) OR (j.status='processing' AND j.lease_until<=?)) ORDER BY j.created_at,j.id LIMIT 1").get(now, now) as NotificationJob & { payload_json: string } | undefined;
    if (!job) return;
    const token = randomUUID();
    db.prepare("UPDATE cms_notification_job SET status='processing',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=?").run(token, now + 120000, new Date(now).toISOString(), job.id);
    return { ...job, attempts: job.attempts + 1, lease_token: token };
  }).immediate();
  if (!claimed) return false;
  try {
    const mail = notificationMail(JSON.parse(claimed.payload_json), { ...config, secure: config.security === 'tls', hasPassword: !!config.password, updatedAt: '' });
    const providerId = deliver ? await deliver(mail) : await deliverConfiguredMail(config, mail, undefined, () => {
      if (getDataDirectory() !== directory) throw new ApiError(409, '实例目录已变化，原任务保持待处理');
      const latest = notificationConfiguration();
      if (!latest.configured || latest.revision !== config.revision || latest.source !== config.source) throw new ApiError(409, '邮件配置已变化，保留任务等待下次处理');
    });
    const finishedAt = now + Math.max(0, Date.now() - startedAt);
    db.prepare("UPDATE cms_notification_job SET status=?,provider_id=?,lease_token=NULL,lease_until=NULL,error_code='',updated_at=? WHERE id=? AND lease_token=?").run(config.mode === 'mock' ? 'mock_sent' : 'sent', providerId, new Date(finishedAt).toISOString(), claimed.id, claimed.lease_token);
  } catch (error) {
    // 不保存SMTP原始消息，避免服务商错误把账号、口令或客户内容带回后台/日志。
    const code = mailDeliveryErrorCode(error);
    const final = claimed.attempts >= 5;
    const finishedAt = now + Math.max(0, Date.now() - startedAt);
    db.prepare("UPDATE cms_notification_job SET status=?,next_attempt=?,error_code=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?").run(final ? 'failed' : 'pending', finishedAt + Math.min(3600000, 30000 * 2 ** (claimed.attempts - 1)), code, new Date(finishedAt).toISOString(), claimed.id, claimed.lease_token);
  }
  return true;
}
export function retryNotification(id: string, now = Date.now()) {
  if (!notificationConfiguration().configured) throw new ApiError(422, '通知尚未配置或未启用，请到站点设置的“邮件通知”完成配置');
  const db = getDatabase();
  db.transaction(() => {
    const job = db.prepare('SELECT * FROM cms_notification_job WHERE id=?').get(id) as NotificationJob | undefined;
    if (!job) throw new ApiError(404, '通知任务不存在');
    if (['sent', 'mock_sent'].includes(job.status)) throw new ApiError(409, '已完成的通知不能作为失败任务重试');
    if (job.status === 'processing' && Number(job.lease_until) > now) throw new ApiError(409, '任务正在处理，请稍后再试');
    db.prepare("UPDATE cms_notification_job SET status='pending',attempts=0,next_attempt=?,lease_token=NULL,lease_until=NULL,error_code='',updated_at=? WHERE id=?").run(now, new Date(now).toISOString(), id);
  }).immediate();
  return { jobs: listNotificationJobs(), configuration: notificationStatus() };
}
const workers = globalThis as typeof globalThis & { formStudioNotifyWorkers?: Map<string, ReturnType<typeof setInterval>> };
export function stopNotificationWorker() {
  const key = getDataDirectory(), registry = workers.formStudioNotifyWorkers; const timer = registry?.get(key); if (timer) clearInterval(timer); registry?.delete(key);
}
export function startNotificationWorker() {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const key = getDataDirectory(), registry = workers.formStudioNotifyWorkers ??= new Map();
  if (!notificationConfiguration().configured) { const timer = registry.get(key); if (timer) clearInterval(timer); registry.delete(key); return; }
  if (registry.has(key)) return;
  let busy = false;
  const timer = setInterval(async () => {
    // 目录切换只发生在热更新或隔离测试；旧定时器不能读取另一实例的配置和询盘。
    if (getDataDirectory() !== key) { clearInterval(timer); registry.delete(key); return; }
    if (busy) return; busy = true;
    try { await processNotificationJob(); } catch { console.error('Notification worker failed; jobs remain durable'); } finally { busy = false; }
  }, 2000);
  timer.unref(); registry.set(key, timer);
}
