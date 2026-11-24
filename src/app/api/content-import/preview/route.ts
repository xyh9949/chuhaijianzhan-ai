import { assertSameOrigin, requireActor, requirePermission, revalidateActor } from '@/server/permissions';
import { apiError, json } from '@/server/http';
import { previewContentImport, readImportRequest } from '@/server/content-import';
export const runtime = 'nodejs';
export async function POST(request: Request) { try { assertSameOrigin(request); let actor = await requireActor(request); requirePermission(actor, 'edit'); const input = await readImportRequest(request); /* 导入预检只给仍有编辑权限的会话返回。 */ actor = revalidateActor(actor, 'edit'); return json(previewContentImport(input)); } catch (e) { return apiError(e); } }
