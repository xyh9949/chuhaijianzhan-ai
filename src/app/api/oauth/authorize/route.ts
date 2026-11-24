import {beginOAuthAuthorization} from '@/server/mcp-oauth';
import {assertOAuthHost,oauthParameters,oauthError} from '@/server/mcp-oauth-http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{assertOAuthHost(request);const destination=await beginOAuthAuthorization(oauthParameters(new URL(request.url).searchParams),request.signal);return new Response(null,{status:302,headers:{Location:destination,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});}catch(error){return oauthError(error);}}
