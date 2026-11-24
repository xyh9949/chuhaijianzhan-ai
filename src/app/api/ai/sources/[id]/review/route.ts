import { assertSameOrigin, requireActor, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { readAiSourceJsonRequest, readAiSourceReview, saveAiSourceReview } from '@/server/ai-source-import';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

/** 本人读取核对回执，不会导入或发布产品。 */
export async function GET(request: Request, context: Context) {
  try {
    const actor = await requireActor(request);
    const { id } = await context.params;
    return json(readAiSourceReview(id, new URL(request.url).searchParams.get('id') || '', revalidateActor(actor, 'manage')));
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor(request);
    const { id } = await context.params;
    const value = await readAiSourceJsonRequest(request);
    return json(saveAiSourceReview(id, value, revalidateActor(actor, 'manage')));
  } catch (error) { return apiError(error); }
}
