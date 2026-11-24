import { apiError, json, readJsonObject } from '@/server/http';
import { createFormSession, FormThrottleError } from '@/server/form-submissions';
import { identifier } from '@/server/validation';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { cookie, ...session } = createFormSession(identifier((await context.params).id), await readJsonObject(request), request);
    const response = json(session); response.headers.set('Set-Cookie', cookie); return response;
  } catch (error) { const response = apiError(error); if (error instanceof FormThrottleError) response.headers.set('Retry-After', String(error.retryAfter)); return response; }
}
