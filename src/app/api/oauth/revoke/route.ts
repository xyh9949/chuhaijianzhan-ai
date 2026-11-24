import {revokeOAuthToken} from '@/server/mcp-oauth';
import {assertOAuthHost,oauthForm,oauthJson,oauthError,oauthOptions} from '@/server/mcp-oauth-http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{assertOAuthHost(request);await revokeOAuthToken(await oauthForm(request),request.headers.get('authorization'),request.signal);return oauthJson({});}catch(error){return oauthError(error);}}
export const OPTIONS=oauthOptions;
