import {exchangeOAuthToken} from '@/server/mcp-oauth';
import {assertOAuthHost,oauthForm,oauthJson,oauthError,oauthOptions} from '@/server/mcp-oauth-http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{assertOAuthHost(request);return oauthJson(await exchangeOAuthToken(await oauthForm(request),request.headers.get('authorization'),request.signal));}catch(error){return oauthError(error);}}
export const OPTIONS=oauthOptions;
