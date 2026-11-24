import { withAiUsage } from '@/server/ai-usage';
import { testAiProviderConnection } from '@/server/ai-provider';
import { apiError, json } from '@/server/http';
import { assertSameOrigin, requireActor, requirePermission } from '@/server/permissions';
import { captureServiceTestConfiguration, recordServiceTestEvidence } from '@/server/service-test-evidence';
import { ApiError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const actor = await requireActor(request); requirePermission(actor, 'manage');
    const configuration = captureServiceTestConfiguration('ai');
    // 记录的是本次连接测试，不把接口响应当成设计质量、余额或长期可用保证。
    try { const result = await withAiUsage(actor,'connection',()=>testAiProviderConnection(request.signal)); if (captureServiceTestConfiguration('ai').fingerprint === configuration.fingerprint) recordServiceTestEvidence(configuration, actor, { mode: 'ai', status: 'passed' }); return json(result); }
    catch (error) { recordServiceTestEvidence(configuration, actor, { mode: 'ai', status: 'failed', errorCode: error instanceof ApiError ? `AI_HTTP_${error.status}` : 'AI_TEST_FAILED' }); throw error; }
  } catch (error) { return apiError(error); }
}
