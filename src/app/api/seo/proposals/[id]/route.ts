import { requireActor, requirePermission, assertSameOrigin, revalidateActor } from '@/server/permissions';
import { json, apiError } from '@/server/http';
import { readSeoProposal, deleteSeoProposal } from '@/server/seo-proposals';
export const runtime='nodejs'; export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
/** 动态参数可能异步解析；参数就绪后重验当前会话，私有读取和删除均不能沿用旧授权。 */
export async function GET(request:Request,{params}:Context){try{let actor=await requireActor(request);requirePermission(actor,'manage');const id = (await params).id; actor = revalidateActor(actor, 'manage'); return json(readSeoProposal(id, actor));}catch(error){return apiError(error);}}
/** 动态参数可能异步解析；参数就绪后重验当前会话，私有读取和删除均不能沿用旧授权。 */
export async function DELETE(request:Request,{params}:Context){try{assertSameOrigin(request);let actor=await requireActor(request);requirePermission(actor,'manage');const id = (await params).id; actor = revalidateActor(actor, 'manage'); return json(deleteSeoProposal(id, actor));}catch(error){return apiError(error);}}
