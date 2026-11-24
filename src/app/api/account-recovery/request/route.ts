import { after } from 'next/server';
import { requestAccountRecovery } from '@/server/account-recovery';
import { assertSameOrigin } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
/** 返回后由Next跟踪投递，邮箱存在与SMTP耗时不进入公开回执。 */
export async function POST(request: Request) {
  try { assertSameOrigin(request); const result = await requestAccountRecovery(await readJsonObject(request), work => after(work)); const response = json(result); response.headers.set('Referrer-Policy', 'no-referrer'); return response; }
  catch (error) { const response = apiError(error); response.headers.set('Referrer-Policy', 'no-referrer'); return response; }
}
