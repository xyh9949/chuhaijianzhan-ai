/** 邮件凭据只在服务器私表加密保存；前端仅知道是否已有密码。 */
export interface MailSettingsSummary {
  revision: number; source: 'environment' | 'database'; mode: 'none' | 'mock' | 'smtp';
  enabled: boolean; host: string; port: number; security: 'tls' | 'starttls'; username: string;
  from: string; to: string[]; hasPassword: boolean; allowLocal: boolean; configured: boolean; updatedAt: string;
}
export interface MailSettingsInput {
  expectedRevision: number; enabled: boolean; host: string; port: number; security: 'tls' | 'starttls';
  username: string; from: string; to: string[]; password?: string; clearPassword?: boolean; allowLocal: boolean;
}
export interface MailSettingsTestResult {
  mode: 'smtp' | 'mock'; status: 'sent' | 'mock_sent'; message: string;
}
