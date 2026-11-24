import {beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import type {request as httpsRequest} from 'node:https';
import {getDatabase} from '../src/server/database';
import {getStudioEnvelope} from '../src/server/studio';
import type {Actor} from '../src/server/permissions';
import {createExternalAiToken,requireExternalAiGrant,revokeExternalAiToken} from '../src/server/external-ai-tokens';
import {registerOAuthClient,beginOAuthAuthorization,readOAuthConsent,confirmOAuthConsent,exchangeOAuthToken,revokeOAuthToken,oauthResource,oauthServerMetadata} from '../src/server/mcp-oauth';
import {OAuthError,oauthRedirect,resolveOAuthClient,oauthBasicCredentials,setOAuthMetadataIoForTests} from '../src/server/mcp-oauth-client';
import {oauthParameters,oauthForm,assertOAuthHost} from '../src/server/mcp-oauth-http';
const actor:Actor={id:'oauth-admin',name:'OAuth administrator',email:'oauth@example.invalid',role:'admin'},other={...actor,id:'oauth-other'};
let directory='',previous:NodeJS.ProcessEnv;
const status=(code:string)=>(error:unknown)=>error instanceof OAuthError&&error.code===code;
const verifier=()=>randomBytes(32).toString('base64url'),challenge=(value:string)=>createHash('sha256').update(value).digest('base64url');
const policy={approve:true,scopes:['read','propose'],pageIds:['home'],recordIds:{productIds:[],entryIds:[]},templateIds:[]};
beforeEach(()=>{previous={...process.env};directory=mkdtempSync(join(tmpdir(),'studio-mcp-oauth-'));process.env.FORM_STUDIO_DATA_DIR=directory;process.env.BETTER_AUTH_URL='http://127.0.0.1:3307';process.env.BETTER_AUTH_SECRET='synthetic-oauth-unit-secret-'.repeat(4);getStudioEnvelope();const db=getDatabase();db.exec('CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,banned INTEGER,banExpires INTEGER)');for(const member of[actor,other])db.prepare('INSERT INTO auth_user VALUES(?,?,?,?,0,NULL)').run(member.id,member.name,member.email,member.role);});
afterEach(()=>{setOAuthMetadataIoForTests();getDatabase().close();for(const key of Object.keys(process.env))if(!Object.hasOwn(previous,key))delete process.env[key];Object.assign(process.env,previous);if(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}studio-mcp-oauth-`))rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
type Registration=ReturnType<typeof registerOAuthClient>;
function client(authMethod='none'){return registerOAuthClient({client_name:'Synthetic MCP client',redirect_uris:['http://127.0.0.1:8321/callback?existing=kept'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:authMethod});}
async function authorize(registration:Registration,scopes='read propose'){const proof=verifier(),start=await beginOAuthAuthorization({response_type:'code',client_id:registration.client_id,redirect_uri:registration.redirect_uris[0],scope:scopes,state:'opaque state + value',code_challenge:challenge(proof),code_challenge_method:'S256',resource:oauthResource()}),id=new URL(start).searchParams.get('oauth_request')!;return{id,proof,registration};}
async function code(registration=client()){const prepared=await authorize(registration),result=confirmOAuthConsent(prepared.id,policy,actor),url=new URL(result.redirect);return{...prepared,code:url.searchParams.get('code')!,redirect:url};}
function tokenInput(value:Awaited<ReturnType<typeof code>>){return{grant_type:'authorization_code',client_id:value.registration.client_id,code:value.code,code_verifier:value.proof,redirect_uri:value.registration.redirect_uris[0],resource:oauthResource()};}
const machine=(token:string,path=oauthResource())=>new Request(path,{headers:{Authorization:`Bearer ${token}`}});

test('SQL19真实授权码闭环：公共请求不取Cookie权限，明确同意后才颁码，PKCE一次兑换且私密信息不存明文',async()=>{
 const before=getStudioEnvelope(),prepared=await authorize(client());assert.deepEqual(getStudioEnvelope(),before);const consent=readOAuthConsent(prepared.id,actor);assert.equal(consent.clientName,'Synthetic MCP client');assert.equal(JSON.stringify(consent).includes(prepared.proof),false);assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_external_ai_token').get() as {n:number}).n,0);
 assert.throws(()=>confirmOAuthConsent(prepared.id,{...policy,scopes:['read','content:read']},actor),status('invalid_scope'));assert.throws(()=>confirmOAuthConsent(prepared.id,policy,actor,()=>{throw new OAuthError('access_denied','Revoked',401);}),status('access_denied'));
 const redirect=new URL(confirmOAuthConsent(prepared.id,policy,actor).redirect);assert.equal(redirect.searchParams.get('state'),'opaque state + value');assert.equal(redirect.searchParams.get('existing'),'kept');assert.equal(redirect.searchParams.get('iss'),process.env.BETTER_AUTH_URL);assert.throws(()=>confirmOAuthConsent(prepared.id,policy,actor),status('invalid_request'));const value={...prepared,code:redirect.searchParams.get('code')!,redirect};
 await assert.rejects(exchangeOAuthToken({...tokenInput(value),code_verifier:verifier()},null),status('invalid_grant'));await assert.rejects(exchangeOAuthToken({...tokenInput(value),redirect_uri:'http://127.0.0.1:8321/callback'},null),status('invalid_grant'));const issued=await exchangeOAuthToken(tokenInput(value),null);assert.equal(issued.scope,'read propose');assert.equal(issued.expires_in,3600);assert.ok(issued.refresh_token);assert.deepEqual(requireExternalAiGrant(machine(issued.access_token)).pageIds,['home']);assert.deepEqual(getStudioEnvelope(),before);
 const stored=JSON.stringify({code:getDatabase().prepare('SELECT * FROM cms_mcp_oauth_code').all(),refresh:getDatabase().prepare('SELECT * FROM cms_mcp_oauth_refresh').all(),access:getDatabase().prepare('SELECT * FROM cms_external_ai_token').all(),audit:getDatabase().prepare('SELECT * FROM cms_audit').all()});for(const secret of[value.code,value.proof,issued.access_token,issued.refresh_token!])assert.equal(stored.includes(secret),false);await assert.rejects(exchangeOAuthToken(tokenInput(value),null),status('invalid_grant'));
});

test('刷新轮换并撤销旧access；重放旧refresh原子撤销同family全部令牌，手工Bearer不受影响',async()=>{
 const value=await code(),issued=await exchangeOAuthToken(tokenInput(value),null),manual=createExternalAiToken({name:'Manual unaffected',scopes:['read'],pageIds:['home']},actor);
 const next=await exchangeOAuthToken({grant_type:'refresh_token',client_id:value.registration.client_id,resource:oauthResource(),refresh_token:issued.refresh_token!},null);assert.notEqual(next.refresh_token,issued.refresh_token);assert.throws(()=>requireExternalAiGrant(machine(issued.access_token)));assert.ok(requireExternalAiGrant(machine(next.access_token)));
 await assert.rejects(exchangeOAuthToken({grant_type:'refresh_token',client_id:value.registration.client_id,resource:oauthResource(),refresh_token:issued.refresh_token!},null),status('invalid_grant'));assert.throws(()=>requireExternalAiGrant(machine(next.access_token)));await assert.rejects(exchangeOAuthToken({grant_type:'refresh_token',client_id:value.registration.client_id,resource:oauthResource(),refresh_token:next.refresh_token!},null),status('invalid_grant'));assert.ok(requireExternalAiGrant(machine(manual.token,'http://127.0.0.1:3307/api/external-ai/context')));
});

test('客户端认证严格绑定basic/post/none，Cookie不能替代密钥；回调resource与接口audience均不扩权',async()=>{
 for(const method of['client_secret_basic','client_secret_post']){const registration=client(method),value=await code(registration),resolved=await resolveOAuthClient(registration.client_id);assert.equal(JSON.stringify(resolved).includes(registration.client_secret!),false);await assert.rejects(exchangeOAuthToken(tokenInput(value),null),status('invalid_client'));const auth=method==='client_secret_basic'?`Basic ${Buffer.from(`${registration.client_id}:${registration.client_secret}`).toString('base64')}`:null;
 const issued=await exchangeOAuthToken({...tokenInput(value),...(method==='client_secret_post'?{client_secret:registration.client_secret!}:{})},auth);assert.throws(()=>requireExternalAiGrant(machine(issued.access_token,'http://127.0.0.1:3307/api/mcp?query=other')));assert.throws(()=>requireExternalAiGrant(machine(issued.access_token,'http://127.0.0.1:3307/api/external-ai/context')));
 await assert.rejects(exchangeOAuthToken({...tokenInput(value),resource:'https://other.invalid/api/mcp'},auth),status('invalid_target'));}
 const registration=client(),value=await code(registration);await assert.rejects(exchangeOAuthToken({...tokenInput(value),client_secret:'unexpected'},null),status('invalid_client'));await assert.rejects(exchangeOAuthToken(tokenInput(value),'Bearer cookie-is-not-client-auth'),status('invalid_client'));
});

test('OAuth audience兼容Next内部来源，仍绑定当前公开resource、精确Host、入口和无查询路径',async()=>{
 const value=await code(),issued=await exchangeOAuthToken(tokenInput(value),null),origin='http://127.0.0.1:3307',target=`${origin}/api/mcp`;
 const request=(url:string,host?:string)=>new Request(url,{headers:{Authorization:`Bearer ${issued.access_token}`,...(host===undefined?{}:{Host:host})}});
 const denied=(error:unknown)=>(error as {status?:number})?.status===401&&error instanceof Error&&error.message==='OAuth连接只能用于获授权的MCP入口';
 // Next生产服务器可把URL重建为localhost；只有匹配配置的公开Host才能采用此内部表示。
 assert.ok(requireExternalAiGrant(request('http://localhost:3307/api/mcp','127.0.0.1:3307')));assert.ok(requireExternalAiGrant(request(target)));
 for(const host of['localhost:3307','127.0.0.1:3308','wrong.invalid','127.0.0.1:3307, wrong.invalid',''])assert.throws(()=>requireExternalAiGrant(request('http://localhost:3307/api/mcp',host)),denied);
 for(const url of['http://localhost:3307/api/mcp',`${target}?query=other`,`${target}?`,`${target}#fragment`,`${target}#`,`${target}/`,`${origin}/api/external-ai/context`])assert.throws(()=>requireExternalAiGrant(request(url,url.startsWith('http://localhost')?undefined:'127.0.0.1:3307')),denied);
 process.env.BETTER_AUTH_URL='https://public.example.invalid';assert.throws(()=>requireExternalAiGrant(request(target,'public.example.invalid')),denied);
 const secureCode=await code(),secureIssued=await exchangeOAuthToken(tokenInput(secureCode),null),secureRequest=(url:string,host?:string)=>new Request(url,{headers:{Authorization:`Bearer ${secureIssued.access_token}`,...(host===undefined?{}:{Host:host})}});
 assert.ok(requireExternalAiGrant(secureRequest('http://localhost:3000/api/mcp','PUBLIC.EXAMPLE.INVALID')));assert.ok(requireExternalAiGrant(secureRequest('https://public.example.invalid/api/mcp')));assert.throws(()=>requireExternalAiGrant(secureRequest('http://public.example.invalid/api/mcp')),denied);assert.throws(()=>requireExternalAiGrant(secureRequest('ftp://localhost/api/mcp','public.example.invalid')),denied);
 process.env.BETTER_AUTH_URL=origin;const id=requireExternalAiGrant(request(target)).tokenId;getDatabase().prepare('UPDATE cms_mcp_oauth_access SET resource=? WHERE token_id=?').run('https://previous.example.invalid/api/mcp',id);assert.throws(()=>requireExternalAiGrant(request(target,'127.0.0.1:3307')),denied);
});

test('授权码过期、管理员降权与后台手工撤销都会拒绝，别的client不能撤销',async()=>{
 const value=await code(),issued=await exchangeOAuthToken(tokenInput(value),null),otherClient=client();await revokeOAuthToken({client_id:otherClient.client_id,token:issued.refresh_token!},null);assert.ok(requireExternalAiGrant(machine(issued.access_token)));getDatabase().prepare("UPDATE auth_user SET role='viewer' WHERE id=?").run(actor.id);assert.throws(()=>requireExternalAiGrant(machine(issued.access_token)));await assert.rejects(exchangeOAuthToken({grant_type:'refresh_token',client_id:value.registration.client_id,resource:oauthResource(),refresh_token:issued.refresh_token!},null),status('invalid_grant'));getDatabase().prepare("UPDATE auth_user SET role='admin' WHERE id=?").run(actor.id);const grant=requireExternalAiGrant(machine(issued.access_token));revokeExternalAiToken(grant.tokenId,actor);await assert.rejects(exchangeOAuthToken({grant_type:'refresh_token',client_id:value.registration.client_id,resource:oauthResource(),refresh_token:issued.refresh_token!},null),status('invalid_grant'));
 const expired=await code();getDatabase().prepare('UPDATE cms_mcp_oauth_code SET expires_at=? WHERE code_hash=?').run('2000-01-01T00:00:00.000Z',createHash('sha256').update(expired.code).digest('hex'));await assert.rejects(exchangeOAuthToken(tokenInput(expired),null),status('invalid_grant'));
});

test('refresh与access各自过期、负责人停用和scope变化都拒绝，失败不消费合法刷新',async()=>{
 const value=await code(),issued=await exchangeOAuthToken(tokenInput(value),null),input={grant_type:'refresh_token',client_id:value.registration.client_id,resource:oauthResource(),refresh_token:issued.refresh_token!};await assert.rejects(exchangeOAuthToken({...input,scope:'read'},null),status('invalid_scope'));assert.ok(requireExternalAiGrant(machine(issued.access_token)));
 getDatabase().prepare('UPDATE auth_user SET banned=1 WHERE id=?').run(actor.id);assert.throws(()=>requireExternalAiGrant(machine(issued.access_token)));await assert.rejects(exchangeOAuthToken(input,null),status('invalid_grant'));getDatabase().prepare('UPDATE auth_user SET banned=0 WHERE id=?').run(actor.id);const next=await exchangeOAuthToken(input,null);assert.ok(next.refresh_token);
 getDatabase().prepare('UPDATE cms_mcp_oauth_refresh SET expires_at=? WHERE token_hash=?').run('2000-01-01T00:00:00.000Z',createHash('sha256').update(next.refresh_token!).digest('hex'));await assert.rejects(exchangeOAuthToken({...input,refresh_token:next.refresh_token!},null),status('invalid_grant'));const grant=requireExternalAiGrant(machine(next.access_token));getDatabase().prepare('UPDATE cms_external_ai_token SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',grant.tokenId);assert.throws(()=>requireExternalAiGrant(machine(next.access_token)));
});

test('协议表单重复项、redirect开放跳转与host混淆拒绝，拒绝连接只返回原state不颁发code',async()=>{
 for(const value of['javascript:alert(1)','http://example.invalid/callback','https://user:secret@example.invalid/callback','https://example.invalid/callback#fragment','https://example.invalid/callback#',' https://example.invalid/callback'])assert.throws(()=>oauthRedirect(value));for(const good of['https://example.invalid/callback','http://127.0.0.1:8321/callback','http://[::1]:8321/callback'])assert.equal(oauthRedirect(good),good);
 assert.throws(()=>oauthParameters(new URLSearchParams('resource=one&resource=two')),status('invalid_request'));assert.throws(()=>assertOAuthHost(new Request('http://127.0.0.1:3307/api/oauth/token',{headers:{Host:'wrong.invalid'}})),status('invalid_request'));await assert.rejects(oauthForm(new Request('http://127.0.0.1:3307/api/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})),status('invalid_request'));
 const pending=await authorize(client()),rejected=new URL(confirmOAuthConsent(pending.id,{approve:false},actor).redirect);assert.equal(rejected.searchParams.get('error'),'access_denied');assert.equal(rejected.searchParams.has('code'),false);assert.equal(rejected.searchParams.get('state'),'opaque state + value');assert.deepEqual(oauthServerMetadata().code_challenge_methods_supported,['S256']);
});

test('OAuth颁发来源要求HTTPS，只为明确本机loopback保留HTTP例外',()=>{
 process.env.BETTER_AUTH_URL='http://public.example.invalid';assert.throws(()=>oauthServerMetadata(),status('server_error'));process.env.BETTER_AUTH_URL='https://public.example.invalid';assert.equal(oauthServerMetadata().issuer,'https://public.example.invalid');process.env.BETTER_AUTH_URL='http://[::1]:3307';assert.equal(oauthResource(),'http://[::1]:3307/api/mcp');
});

test('连接数量达到50时refresh轮换仍替换同一连接，不额外占用活跃连接名额',async()=>{
 const value=await code(),issued=await exchangeOAuthToken(tokenInput(value),null);for(let i=0;i<49;i++)createExternalAiToken({name:`Capacity ${i}`,scopes:['read'],pageIds:['home']},actor);const next=await exchangeOAuthToken({grant_type:'refresh_token',client_id:value.registration.client_id,resource:oauthResource(),refresh_token:issued.refresh_token!},null);assert.ok(next.access_token);assert.equal((getDatabase().prepare('SELECT count(*) n FROM cms_external_ai_token WHERE revoked_at IS NULL').get() as {n:number}).n,50);
});

test('重复原型参数、伪content-type、混合认证和宽松base64不能绕过严格OAuth参数解析',async()=>{
 assert.throws(()=>oauthParameters(new URLSearchParams('__proto__=one&__proto__=two')),status('invalid_request'));assert.equal(Object.getPrototypeOf(oauthParameters(new URLSearchParams('client_id=one'))),null);
 await assert.rejects(oauthForm(new Request('http://127.0.0.1:3307/api/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencodedevil'},body:'client_id=one'})),status('invalid_request'));
 const good=Buffer.from('test-client:real-secret').toString('base64');assert.deepEqual(oauthBasicCredentials(`basic ${good}`),{clientId:'test-client',secret:'real-secret'});for(const value of[`Basic ${good}!!!`,'Basic !!!','Basic '+Buffer.from('no-colon').toString('base64')])assert.throws(()=>oauthBasicCredentials(value),status('invalid_client'));
 await assert.rejects(oauthForm(new Request('http://127.0.0.1:3307/api/oauth/token',{method:'POST',headers:{Authorization:`Basic ${good}`,'Content-Type':'application/x-www-form-urlencoded'},body:'client_id=another'})),status('invalid_client'));
});

test('CIMD只通过公网HTTPS且DNS固定，真实私网分类在测试运输层之前执行，不跟随跳转',async()=>{
 const id='https://oauth-client.example.invalid/client-metadata.json',metadata={client_id:id,client_name:'CIMD synthetic',redirect_uris:['http://127.0.0.1:8321/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token']};let calls=0,dnsCalls=0,body:unknown=metadata,responseStatus=200,mime='application/json';
 const request=((url:URL,options:import('node:https').RequestOptions,callback:(response:unknown)=>void)=>{calls++;assert.equal(url.href,id);assert.equal(options.method,'GET');assert.equal((options.headers as Record<string,string>).Authorization,undefined);assert.notEqual(options.rejectUnauthorized,false);const pinned=options.lookup as (host:string,options:{all:boolean},done:(error:unknown,value:unknown,family?:number)=>void)=>void;pinned(url.hostname,{all:true},(error,addresses)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'93.184.216.34',family:4}]);});pinned(url.hostname,{all:false},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'93.184.216.34');assert.equal(family,4);});const outgoing=new EventEmitter() as EventEmitter&{end:()=>void};outgoing.end=()=>queueMicrotask(()=>{const response=new PassThrough() as PassThrough&{statusCode:number;headers:Record<string,string>};response.statusCode=responseStatus;response.headers={'content-type':mime};callback(response);response.end(Buffer.from(typeof body==='string'?body:JSON.stringify(body)));});return outgoing;}) as unknown as typeof httpsRequest;
 setOAuthMetadataIoForTests({lookup:async()=>{dnsCalls++;return[{address:'93.184.216.34',family:4}]},request});const resolved=await resolveOAuthClient(id);assert.equal(resolved.source,'metadata');assert.equal(resolved.name,'CIMD synthetic');assert.equal(calls,1);await resolveOAuthClient(id);assert.equal(calls,1);assert.equal(dnsCalls,1);
 const expire=()=>getDatabase().prepare('DELETE FROM cms_mcp_oauth_client WHERE id=?').run(id);expire();setOAuthMetadataIoForTests({lookup:async()=>[{address:'127.0.0.1',family:4}],request});await assert.rejects(resolveOAuthClient(id),status('invalid_client'));assert.equal(calls,1);
 setOAuthMetadataIoForTests({lookup:async()=>[{address:'93.184.216.34',family:4},{address:'::1',family:6}],request});await assert.rejects(resolveOAuthClient(id),status('invalid_client'));assert.equal(calls,1);
 setOAuthMetadataIoForTests({lookup:async()=>[{address:'93.184.216.34',family:4}],request});responseStatus=302;await assert.rejects(resolveOAuthClient(id),status('invalid_client'));assert.equal(calls,2);responseStatus=200;body={...metadata,client_id:'https://different.invalid/document'};await assert.rejects(resolveOAuthClient(id),status('invalid_client'));body='x'.repeat(65537);await assert.rejects(resolveOAuthClient(id),status('invalid_client'));body=metadata;mime='text/html';await assert.rejects(resolveOAuthClient(id),status('invalid_client'));
 for(const bad of['https://user:password@example.invalid/meta','https://oauth-client.example.invalid/','https://oauth-client.example.invalid/meta?secret=one','https://oauth-client.example.invalid/meta#fragment'])await assert.rejects(resolveOAuthClient(bad),status('invalid_client'));
});
