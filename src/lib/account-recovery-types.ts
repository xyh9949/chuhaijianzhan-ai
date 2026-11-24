/** 对外回执不区分邮箱存在、账号状态或邮件是否可投递。 */
export interface AccountRecoveryRequest { email: string; }
export interface AccountRecoveryAccepted { accepted: true; message: string; }
export interface AccountRecoveryReset { token: string; newPassword: string; }
export interface AccountRecoveryCompleted { reset: true; message: string; }
