import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {getMigrations} from 'better-auth/db/migration';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {auth as sdkAuth,refreshAuthorization,type OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import type {OAuthTokens,OAuthClientInformationMixed} from '@modelcontextprotocol/sdk/shared/auth.js';
import {getDatabase} from '../src/server/database';
import {getStudioEnvelope} from '../src/server/studio';
import {getAuth} from '../src/server/auth';
import {registerOAuthClient,beginOAuthAuthorization,oauthResource,oauthServerMetadata} from '../src/server/mcp-oauth';
import {GET as authorization} from '../src/app/api/oauth/authorize/route';
import {POST as registration} from '../src/app/api/oauth/register/route';
import {POST as token} from '../src/app/api/oauth/token/route';
import {POST as revoke} from '../src/app/api/oauth/revoke/route';
import {GET as consentRead,POST as consent} from '../src/app/api/oauth/requests/[id]/route';
import {GET as serverMetadata} from '../src/app/.well-known/oauth-authorization-server/route';
import {GET as protectedMetadata} from '../src/app/.well-known/oauth-protected-resource/route';
import {POST as mcp,GET as mcpGet} from '../src/app/api/mcp/route';

async function sdk<T>(label:string,work:()=>Promise<T>):Promise<T>{try{return await work();}catch{throw new Error(`Synthetic OAuth SDK ${label} failed`);}}
const policy={approve:true,scopes:['read','propose'],pageIds:['home'],recordIds:{productIds:[],entryIds:[]},templateIds:[]};
/** 本机随机端口实际传输SDK发现/注册/PKCE/原MCP生产handlers；临时BetterAuth账号与SQLite不接正式实例。 */
test('真实SDK OAuth HTTP发现到MCP、刷新轮换/重放撤销和真实会话异步撤销', {timeout:60000},async t=>{
 const previous={...process.env},directory=mkdtempSync(join(tmpdir(),'studio-oauth-http-')),requests:{method:string;path:string}[]=[];let origin='',client:Client|undefined;
 const server=createServer(async(incoming,outgoing)=>{
  try{const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));const url=new URL(incoming.url||'/',origin),method=incoming.method||'GET',headers=new Headers();for(const[key,value]of Object.entries(incoming.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);const request=new Request(url,{method,headers,...(!['GET','HEAD'].includes(method)?{body:Buffer.concat(chunks)}:{})});requests.push({method,path:url.pathname});let response:Response;
   if(url.pathname.startsWith('/api/auth/'))response=await getAuth().handler(request);
   else if(url.pathname==='/api/oauth/register')response=await registration(request);
   else if(url.pathname==='/api/oauth/authorize')response=await authorization(request);
   else if(url.pathname==='/api/oauth/token')response=await token(request);
   else if(url.pathname==='/api/oauth/revoke')response=await revoke(request);
   else if(url.pathname.startsWith('/api/oauth/requests/')){const context={params:Promise.resolve({id:url.pathname.split('/').at(-1)!})};response=method==='GET'?await consentRead(request,context):await consent(request,context);}
   else if(url.pathname==='/.well-known/oauth-authorization-server')response=serverMetadata(request);
   else if(url.pathname.startsWith('/.well-known/oauth-protected-resource'))response=protectedMetadata(request);
   else if(url.pathname==='/api/mcp')response=method==='POST'?await mcp(request):mcpGet();
   else response=new Response('Synthetic route unavailable',{status:404});
   outgoing.statusCode=response.status;response.headers.forEach((value,key)=>{if(key!=='set-cookie')outgoing.setHeader(key,value);});const cookies=response.headers.getSetCookie();if(cookies.length)outgoing.setHeader('Set-Cookie',cookies);outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch{outgoing.statusCode=500;outgoing.end('Synthetic HTTP handler failed');}
 });
 try{
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address!=='string');origin=`http://127.0.0.1:${address.port}`;process.env.FORM_STUDIO_DATA_DIR=directory;process.env.BETTER_AUTH_URL=origin;process.env.BETTER_AUTH_SECRET='synthetic-oauth-http-secret-'.repeat(4);getStudioEnvelope();const native=getAuth();await(await getMigrations(native.options)).runMigrations();const email='oauth-http-admin@example.invalid',password='Synthetic-OAuth-HTTP-password-123';await native.api.createUser({body:{name:'OAuth HTTP administrator',email,password,role:'admin'}});
  const login=async()=>{const response=await fetch(`${origin}/api/auth/sign-in/email`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(response.status,200);return response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');};
  const cookie=await login(),post=async(path:string,body:unknown,cookieValue=cookie)=>fetch(`${origin}${path}`,{method:'POST',headers:{Origin:origin,Cookie:cookieValue,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'manual'});
  let info:OAuthClientInformationMixed|undefined,tokens:OAuthTokens|undefined,verifier='',authorizationUrl:URL|undefined;
  const provider:OAuthClientProvider={redirectUrl:`http://127.0.0.1:${address.port}/synthetic-callback`,clientMetadata:{client_name:'Synthetic SDK OAuth',redirect_uris:[`http://127.0.0.1:${address.port}/synthetic-callback`],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:'read propose'},clientInformation:()=>info,saveClientInformation:value=>{info=value;},tokens:()=>tokens,saveTokens:value=>{tokens=value;},saveCodeVerifier:value=>{verifier=value;},codeVerifier:()=>verifier,state:()=> 'sdk-opaque-state',redirectToAuthorization:value=>{authorizationUrl=value;}};
  await t.test('SDK真实发现、DCR、PKCE和显式Cookie同意，随后正常调用MCP工具',async()=>{
   assert.equal(await sdk('discover-and-register',()=>sdkAuth(provider,{serverUrl:`${origin}/api/mcp`,scope:'read propose'})),'REDIRECT');assert.ok(authorizationUrl);assert.ok(info);const start=await fetch(authorizationUrl!,{redirect:'manual'});assert.equal(start.status,302);const id=new URL(start.headers.get('location')!).searchParams.get('oauth_request')!;
   assert.equal((await fetch(`${origin}/api/oauth/requests/${id}`)).status,401);assert.equal((await post(`/api/oauth/requests/${id}`,policy,'')).status,401);const accepted=await post(`/api/oauth/requests/${id}`,policy);assert.equal(accepted.status,200);const callback=new URL((await accepted.json()).redirect);assert.equal(callback.searchParams.get('state'),'sdk-opaque-state');assert.equal(callback.searchParams.get('iss'),origin);
   assert.equal(await sdk('code-exchange',()=>sdkAuth(provider,{serverUrl:`${origin}/api/mcp`,authorizationCode:callback.searchParams.get('code')!,scope:'read propose'})),'AUTHORIZED');assert.ok(tokens?.refresh_token);
   client=new Client({name:'synthetic-oauth-sdk',version:'1'});await sdk('MCP initialize',()=>client!.connect(new StreamableHTTPClientTransport(new URL('/api/mcp',origin),{authProvider:provider,reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}})));const listed=await sdk('tools/list',()=>client!.listTools());assert.ok(listed.tools.some(tool=>tool.name==='site_design_propose'));const overview=await sdk('site_overview',()=>client!.callTool({name:'site_overview',arguments:{}}));assert.notEqual(overview.isError,true);assert.ok(JSON.stringify(overview).includes('home'));await client.close();client=undefined;
  });
  await t.test('SDK refresh真实轮换且旧refresh重放撤销新access，不泄露机器凭据',async()=>{
   assert.ok(info&&tokens?.refresh_token);const old=tokens!,next=await sdk('refresh',()=>refreshAuthorization(origin,{metadata:oauthServerMetadata(),clientInformation:info!,refreshToken:old.refresh_token!,resource:oauthResource()}));assert.ok(next.refresh_token);assert.notEqual(next.refresh_token,old.refresh_token);const body=new URLSearchParams({grant_type:'refresh_token',client_id:info!.client_id,resource:oauthResource(),refresh_token:old.refresh_token!});const replay=await fetch(`${origin}/api/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});assert.equal(replay.status,400);assert.equal((await replay.json()).error,'invalid_grant');const denied=await fetch(`${origin}/api/mcp`,{method:'POST',headers:{Authorization:`Bearer ${next.access_token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'denied',version:'1'}}})});assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate')||'',/resource_metadata=/);assert.equal(JSON.stringify(requests).includes(next.access_token),false);
  });
  const newPending=async()=>{const registered=registerOAuthClient({redirect_uris:['http://127.0.0.1:8321/callback'],token_endpoint_auth_method:'none'}),proof=randomBytes(32).toString('base64url'),url=await beginOAuthAuthorization({response_type:'code',client_id:registered.client_id,redirect_uri:registered.redirect_uris[0],scope:'read propose',code_challenge:createHash('sha256').update(proof).digest('base64url'),code_challenge_method:'S256',resource:oauthResource()});return new URL(url).searchParams.get('oauth_request')!;};
  await t.test('真实会话等待POST正文时登出，fresh检查拒绝且请求不消费、不颁码',async()=>{
   const cookieValue=await login(),id=await newPending();let reached!:()=>void,release!:()=>void,pulled=false;const reading=new Promise<void>(done=>reached=done),gate=new Promise<void>(done=>release=done),stream=new ReadableStream<Uint8Array>({async pull(controller){if(pulled)return;pulled=true;reached();await gate;controller.enqueue(new TextEncoder().encode(JSON.stringify(policy)));controller.close();}},{highWaterMark:0});const request=new Request(`${origin}/api/oauth/requests/${id}`,{method:'POST',headers:{Origin:origin,Cookie:cookieValue,'Content-Type':'application/json'},body:stream,duplex:'half'} as RequestInit),pending=consent(request,{params:Promise.resolve({id})});await reading;assert.equal((await post('/api/auth/sign-out',{},cookieValue)).status,200);release();assert.equal((await pending).status,401);assert.equal((getDatabase().prepare('SELECT consumed_at FROM cms_mcp_oauth_request WHERE id=?').get(id) as {consumed_at:null}).consumed_at,null);
  });
  await t.test('真实会话等待params时撤销、同源保护和账号降权均不返回私有授权详情',async()=>{
   const cookieValue=await login(),id=await newPending();let reached!:()=>void,release!:()=>void;const reading=new Promise<void>(done=>reached=done);class Params extends Promise<{id:string}>{static get[Symbol.species](){return Promise;}}const params=new Params(done=>release=()=>done({id})),then=params.then.bind(params);Object.defineProperty(params,'then',{value:(...args:Parameters<typeof then>)=>{reached();return then(...args);}});const pending=consentRead(new Request(`${origin}/api/oauth/requests/${id}`,{headers:{Cookie:cookieValue}}),{params});await reading;assert.equal((await post('/api/auth/sign-out',{},cookieValue)).status,200);release();const denied=await pending;assert.equal(denied.status,401);assert.deepEqual(Object.keys(await denied.json()),['error']);const fresh=await login();assert.equal((await fetch(`${origin}/api/oauth/requests/${id}`,{method:'POST',headers:{Origin:'https://wrong.invalid',Cookie:fresh,'Content-Type':'application/json'},body:JSON.stringify(policy)})).status,403);getDatabase().prepare("UPDATE auth_user SET role='viewer' WHERE email=?").run(email);assert.equal((await post(`/api/oauth/requests/${id}`,policy,fresh)).status,403);assert.equal((getDatabase().prepare('SELECT consumed_at FROM cms_mcp_oauth_request WHERE id=?').get(id) as {consumed_at:null}).consumed_at,null);
  });
  assert.equal(requests.some(request=>request.path==='/api/oauth/register'),true);assert.equal(requests.some(request=>request.path==='/api/mcp'),true);
 }finally{await client?.close().catch(()=>{});server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));getDatabase().close();for(const key of Object.keys(process.env))if(!Object.hasOwn(previous,key))delete process.env[key];Object.assign(process.env,previous);if(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-oauth-http-`))rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
