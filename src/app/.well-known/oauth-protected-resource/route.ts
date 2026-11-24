import {oauthProtectedMetadata} from '@/server/mcp-oauth';
import {assertOAuthHost,oauthJson,oauthError,oauthOptions} from '@/server/mcp-oauth-http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export function GET(request:Request){try{assertOAuthHost(request);return oauthJson(oauthProtectedMetadata());}catch(error){return oauthError(error);}}
export const OPTIONS=oauthOptions;
