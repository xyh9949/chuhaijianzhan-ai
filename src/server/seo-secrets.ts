import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getAuthEnvironment } from './env';
import { ApiError } from './http';

function key() { return createHash('sha256').update('form-studio-seo-secrets:v1\0').update(getAuthEnvironment().secret).digest(); }
/** provider和用途同时参与AAD，配置/令牌/PKCE不能互换，也不修改既有AI密钥格式。 */
export function encryptSeoSecret(value: unknown, purpose: string): string {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key(),iv);cipher.setAAD(Buffer.from(`form-studio/seo/v1/${purpose}`));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
}
export function decryptSeoSecret<T>(encoded: string, purpose: string): T {
  try { const [version,iv,tag,body,extra]=encoded.split('.');if(version!=='v1'||!iv||!tag||!body||extra!==undefined)throw Error();const decipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64url'));decipher.setAAD(Buffer.from(`form-studio/seo/v1/${purpose}`));decipher.setAuthTag(Buffer.from(tag,'base64url'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body,'base64url')),decipher.final()]).toString('utf8')) as T; }
  catch { throw new ApiError(422,'搜索接口凭据无法解密，请重新配置；恢复实例需保留原固定密钥'); }
}
