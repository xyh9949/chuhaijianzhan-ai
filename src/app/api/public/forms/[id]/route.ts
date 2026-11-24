import { apiError, json, readJsonObject } from '@/server/http';
import { FormSubmissionError, FormThrottleError, submitPublicForm } from '@/server/form-submissions';
import { identifier } from '@/server/validation';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { return json(submitPublicForm(identifier((await context.params).id), await readJsonObject(request), request)); }
  catch (error) { const response = error instanceof FormSubmissionError ? json({ error: error.message, code: error.code }, error.status) : apiError(error); if (error instanceof FormThrottleError) response.headers.set('Retry-After', String(error.retryAfter)); return response; }
}
