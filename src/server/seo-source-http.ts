import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { ApiError } from './http';
import { classifyAiAddress } from './ai-provider';

const HOSTS=new Set(['accounts.google.com','oauth2.googleapis.com','www.googleapis.com','api.dataforseo.com']);
export type SeoHttpRequest={url:string;method:'GET'|'POST';headers?:Record<string,string>;body?:string;signal?:AbortSignal};
export type SeoSourceTransport=(request:SeoHttpRequest)=>Promise<unknown>;
let testTransport:SeoSourceTransport|undefined;
/** 只在Node单测进程开放注入；运行中网站没有可写传输地址或测试开关API。 */
export function setSeoSourceTransportForTests(transport?:SeoSourceTransport){if(!process.env.NODE_TEST_CONTEXT)throw Error('SEO transport injection is test-only');testTransport=transport;}
export function seoSourceMockOrigin():string|undefined {
  if(process.env.FORM_STUDIO_SEO_MOCK!=='true')return;
  let url:URL;try{url=new URL(process.env.FORM_STUDIO_SEO_MOCK_ORIGIN||'');}catch{throw new ApiError(422,'SEO模拟环境地址无效');}
  if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new ApiError(422,'SEO模拟环境只允许服务器本机固定来源');return url.origin;
}
export function seoGoogleAuthorizationBase(){const mock=seoSourceMockOrigin();return mock?`${mock}/google/oauth`:'https://accounts.google.com/o/oauth2/v2/auth';}
export function seoSourceIsMock(){return !!testTransport||!!seoSourceMockOrigin();}
// DNS和正文共用同一截止时间，取消后迟到的解析结果不会再次发起请求。
async function resolveHost(host:string,signal:AbortSignal){return new Promise<{address:string;family:number}[]>((resolve,reject)=>{let settled=false;const finish=(error?:unknown,value?:{address:string;family:number}[])=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);if(error)reject(error);else resolve(value!);};const abort=()=>finish(new ApiError(504,'搜索接口地址解析已取消或超时'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}void lookup(host,{all:true,verbatim:true}).then(value=>finish(undefined,value),()=>finish(new ApiError(502,'搜索接口地址暂时无法解析')));});}
/** 固定官方HTTPS域名、固定DNS目标、禁重定向和自动重试；错误只给状态类别，不回传上游正文。 */
export async function requestSeoJson(input:SeoHttpRequest):Promise<unknown>{
  if(testTransport)return testTransport(input);
  let url=new URL(input.url);if(url.protocol!=='https:'||!HOSTS.has(url.hostname)||url.username||url.password||url.hash)throw new ApiError(422,'搜索接口目标不在允许范围');
  const mock=seoSourceMockOrigin();if(mock)url=new URL(`${url.hostname==='api.dataforseo.com'?'/keywords':'/google'}${url.pathname}${url.search}`,mock);
  const deadline=AbortSignal.timeout(30_000),signal=input.signal?AbortSignal.any([input.signal,deadline]):deadline;
  if(signal.aborted)throw new ApiError(499,'搜索接口请求已取消');
  let address:string|undefined,family:4|6|undefined;
  if(!mock){const addresses=await resolveHost(url.hostname,signal);if(!addresses.length||addresses.some(item=>classifyAiAddress(item.address)!=='public'))throw new ApiError(422,'搜索接口解析到了不允许的网络地址');address=addresses[0].address;family=addresses[0].family as 4|6;}
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error?:unknown,value?:unknown)=>{if(settled)return;settled=true;if(error)reject(error);else resolve(value);};
    const pinnedLookup:NonNullable<import('node:http').RequestOptions['lookup']>=(_hostname,options,done)=>options.all?done(null,[{address:address!,family:family!}]):done(null,address!,family!);
    const request=(mock?httpRequest:httpsRequest)(url,{method:input.method,agent:false,headers:{Accept:'application/json',...input.headers,...(input.body?{'Content-Length':Buffer.byteLength(input.body)}:{})},signal,...(!mock?{family,lookup:pinnedLookup}:{})},response=>{
      const chunks:Buffer[]=[];let length=0;response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>4*1024*1024){response.destroy();finish(new ApiError(502,'搜索接口回复超过4MB，请缩小日期或关键词范围'));}else chunks.push(chunk);});
      response.on('end',()=>{if(settled)return;const status=response.statusCode||500;if(status<200||status>=300){finish(new ApiError(status===401||status===403?422:status===429?429:502,status===401||status===403?'搜索接口未授权或权限不足，请重新连接并核对所选网站':status===429?'搜索接口额度或频率受限，请稍后手工重试':'搜索接口未成功返回；本次不会自动重试'));return;}try{finish(undefined,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(new ApiError(502,'搜索接口返回了无效JSON'));}});
      response.on('error',()=>finish(new ApiError(502,'搜索接口回复中断，请核对连接后手工重试')));
    });
    request.once('error',()=>finish(new ApiError(signal.aborted?input.signal?.aborted?499:504:502,signal.aborted?'搜索接口请求已取消或超时':'搜索接口暂时无法连接，请核对后手工重试')));
    if(input.body)request.write(input.body);request.end();
  });
}
