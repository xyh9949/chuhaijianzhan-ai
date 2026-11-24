import { createHmac, randomUUID } from 'node:crypto';
import { getDatabase } from './database';
import { getAuthEnvironment } from './env';
import type { Actor } from './permissions';

export interface ServiceTestConfiguration { service: 'mail' | 'ai'; revision: number; source: 'database' | 'environment'; fingerprint: string; }
type Receipt = { mode: string; status: string; error_code: string; created_at: string };
/** 口令/密文只参与服务端HMAC；换账号、环境、固定密钥或配置版本后，旧成功不能证明新配置可用。 */
export function captureServiceTestConfiguration(service: 'mail' | 'ai'): ServiceTestConfiguration {
  const db = getDatabase(); let revision = 0, source: ServiceTestConfiguration['source'] = 'database', identity: unknown;
  if (service === 'mail') {
    const row = db.prepare('SELECT revision,config_json,secret_cipher FROM cms_mail_settings WHERE id=1').get() as { revision: number; config_json: string; secret_cipher: string } | undefined;
    if (row) { revision = row.revision; identity = row; }
    else { source = 'environment'; identity = Object.fromEntries(['FORM_STUDIO_NOTIFY_TRANSPORT','FORM_STUDIO_NOTIFY_TO','FORM_STUDIO_SMTP_FROM','FORM_STUDIO_SMTP_HOST','FORM_STUDIO_SMTP_PORT','FORM_STUDIO_SMTP_SECURE','FORM_STUDIO_SMTP_USER','FORM_STUDIO_SMTP_PASSWORD'].map(name => [name, process.env[name] || ''])); }
  } else {
    const row = db.prepare('SELECT revision,enabled,base_url,model,allow_local,secret_cipher FROM cms_ai_provider WHERE id=1').get() as { revision: number } | undefined;
    revision = row?.revision || 0; identity = row || null;
  }
  const fingerprint = createHmac('sha256', getAuthEnvironment().secret).update(`form-studio/service-test/v1/${service}\0`).update(JSON.stringify(identity)).digest('hex');
  return { service, revision, source, fingerprint };
}
/** 只写配置身份和固定结果类别，不保存目标邮箱、模型回复、密码、令牌或服务商原始错误。 */
export function recordServiceTestEvidence(configuration: ServiceTestConfiguration, actor: Actor, result: { mode: string; status: string; errorCode?: string }) {
  const errorCode = result.errorCode && /^[A-Z0-9_]{1,60}$/.test(result.errorCode) ? result.errorCode : '';
  const stamp = new Date().toISOString();
  getDatabase().transaction(() => {
    getDatabase().prepare('DELETE FROM cms_service_test_receipt WHERE created_at<?').run(new Date(Date.now() - 30 * 86400000).toISOString());
    getDatabase().prepare('INSERT INTO cms_service_test_receipt(id,service,actor_id,configuration_revision,configuration_source,configuration_fingerprint,mode,status,error_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(`st-${randomUUID()}`, configuration.service, actor.id, configuration.revision, configuration.source, configuration.fingerprint, result.mode, result.status, errorCode, stamp);
  }).immediate();
}
export function readServiceTestEvidence(service: 'mail' | 'ai') {
  const configuration = captureServiceTestConfiguration(service);
  const row = getDatabase().prepare('SELECT mode,status,error_code,created_at FROM cms_service_test_receipt WHERE service=? AND configuration_revision=? AND configuration_source=? AND configuration_fingerprint=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(service, configuration.revision, configuration.source, configuration.fingerprint) as Receipt | undefined;
  return row ? { checkedAt: row.created_at, status: row.status, errorCode: row.error_code, mode: row.mode, configurationRevision: configuration.revision, configurationSource: configuration.source } : null;
}
export function readAiTestEvidence() { return readServiceTestEvidence('ai'); }
