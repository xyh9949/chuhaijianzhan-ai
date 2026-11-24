import {registerOAuthClient} from '@/server/mcp-oauth';
import {readJsonObject} from '@/server/http';
import {assertOAuthHost,oauthJson,oauthError,oauthOptions} from '@/server/mcp-oauth-http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{assertOAuthHost(request);return oauthJson(registerOAuthClient(await readJsonObject(request)),201);}catch(error){return oauthError(error);}}
export const OPTIONS=oauthOptions;
