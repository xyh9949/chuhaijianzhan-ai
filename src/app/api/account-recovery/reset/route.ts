import { resetAccountPassword } from '@/server/account-recovery';
import { assertSameOrigin } from '@/server/permissions';
import { apiError, json, readJsonObject } from '@/server/http';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try { assertSameOrigin(request); const result = await resetAccountPassword(await readJsonObject(request)); const response = json(result); response.headers.set('Referrer-Policy', 'no-referrer'); return response; }
  catch (error) { const response = apiError(error); response.headers.set('Referrer-Policy', 'no-referrer'); return response; }
}
