import { apiError, json } from "@/server/http";
import { requireActor } from "@/server/permissions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return json({ actor: await requireActor(request) }); }
  catch (error) { return apiError(error); }
}
