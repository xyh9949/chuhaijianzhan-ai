import test from 'node:test';
import assert from 'node:assert/strict';
import {discoveryErrors,discoveryRobots,llmsText,siteStructuredData,discoveryDiagnostics} from '../src/lib/discovery';
import {withPublicUrlState} from '../src/server/discovery-publication';
import {createInitialDraft} from '../src/server/seed';
import {resolveSitePage} from '../src/lib/site-routing';
import type {SiteSnapshot} from '../src/server/types';
import legacyV15 from './fixtures/snapshot-v15.json';
const snapshot=():SiteSnapshot=>({...createInitialDraft(),schemaVersion:16,settings:{...createInitialDraft().settings,publicUrl:'https://factory.example.invalid'}});
test('公开资源精确开放、每个搜索UA保留管理禁区，训练拒绝不关闭搜索',()=>{
 const s=snapshot();s.settings.discovery={training:{openai:'deny',claude:'deny'},search:{perplexity:false}};const robots=discoveryRobots(s),rules=robots.rules as {userAgent:string;allow?:string[];disallow:string[]}[];
 for(const ua of ['*','OAI-SearchBot','Claude-SearchBot']){const r=rules.find(r=>r.userAgent===ua)!;assert.ok(r.allow?.includes('/api/media/'));assert.ok(r.allow?.includes('/api/site-code/'));assert.ok(r.allow?.includes('/_next/static/'));assert.ok(r.disallow.includes('/api/'));assert.ok(r.disallow.includes('/admin'));}
 assert.deepEqual(rules.find(r=>r.userAgent==='GPTBot')?.disallow,['/']);assert.deepEqual(rules.find(r=>r.userAgent==='PerplexityBot')?.disallow,['/']);assert.deepEqual(discoveryRobots(null).rules,{userAgent:'*',disallow:['/']});
});
test('企业事实白名单、证据网址/日期和模型引用校验，未知凭据拒绝',()=>{
 const fact={id:'f1',title:'Test evidence',value:'Only tested range',scope:'Synthetic example',sourceUrl:'https://lab.example.invalid/report',reviewedAt:'2026-11-01',validUntil:'2027-01-01',status:'reviewed'};
 assert.deepEqual(discoveryErrors({facts:[fact],organization:{legalName:'Synthetic Ltd',sameAs:['https://directory.example.invalid/profile']}}),[]);
 for(const bad of [{password:'secret'},{facts:[{...fact,sourceUrl:'javascript:alert(1)'}]},{facts:[{...fact,reviewedAt:'2026-02-30'}]},{facts:[fact,fact]},{facts:[{...fact,reviewedAt:''}]},{organization:{sameAs:['https://user:password@example.invalid']}}])assert.ok(discoveryErrors(bad).length);
 assert.ok(discoveryErrors({mappings:[{modelId:'missing',type:'Article'}]},[]).length);
});
test('结构化图、公司与产品稳定身份、纯询价不产生Offer或评分',()=>{
 const s=snapshot();s.settings.discovery={organization:{legalName:'Factory legal name',role:'Manufacturer',sameAs:['https://directory.example.invalid/company']}};
 const product=s.products[0],r=resolveSitePage(s,['products',product.slug||product.id])!;assert.ok(r);const graph=siteStructuredData(s,r),text=JSON.stringify(graph);
 assert.ok(text.includes('#organization'));assert.ok(text.includes(product.sku));assert.ok(text.includes('BreadcrumbList'));assert.ok(!text.includes('Offer'));assert.ok(!text.includes('aggregateRating'));assert.ok(!text.includes('"price"'));assert.ok(!text.includes('"manufacturer"'),'建站方不是已确认的产品制造商');
});
test('可选目录排除noindex和未知草稿；旧15真实JSON可读取且不被重写',()=>{
 const s=snapshot();s.pages[1].noindex=true;const text=llmsText(s);assert.ok(text.includes('https://factory.example.invalid'));assert.ok(!text.includes(`](${s.settings.publicUrl}${s.pages[1].slug})`));assert.ok(!text.includes('/admin'));
 const old=structuredClone(legacyV15) as unknown as SiteSnapshot,raw=JSON.stringify(old),r=resolveSitePage(old)!;assert.ok(siteStructuredData(old,r));assert.equal(JSON.stringify(old),raw);assert.ok(discoveryDiagnostics(old).length>=0);
});
test('发布逐URL时间保持、真实记录改变和历史回退比较，不以每次构建冒充更新',()=>{
 const s=snapshot(),first=withPublicUrlState(s,null,'2026-11-01T00:00:00.000Z'),second=withPublicUrlState({...s,releaseId:'another'},first,'2026-11-02T00:00:00.000Z');assert.deepEqual(second.urlState,first.urlState);
 const changed=structuredClone(s);changed.products[0].description='Actual changed content';const next=withPublicUrlState(changed,second,'2026-11-03T00:00:00.000Z');const path=`/products/${changed.products[0].slug||changed.products[0].id}`;assert.equal(next.urlState?.[path]?.modified,'2026-11-03T00:00:00.000Z');
});
test('同步区块中的列表和固定绑定参与页面真实更新时间',()=>{
 const s=snapshot();s.editorData.home={root:{props:{}},content:[{type:'SharedBlock',props:{id:'shared-use',blockId:'list-block'}}]};s.sharedBlocks=[{id:'list-block',name:'Reusable list',updated:'',data:{root:{props:{}},content:[{type:'ProductList',props:{id:'list',count:3}}]}}];
 const first=withPublicUrlState(s,null,'2026-11-01T00:00:00.000Z');const changed=structuredClone(s);changed.products[0].description='A genuine specification change';const second=withPublicUrlState(changed,first,'2026-11-02T00:00:00.000Z');assert.notEqual(second.urlState?.['/'].hash,first.urlState?.['/'].hash);assert.equal(second.urlState?.['/'].modified,'2026-11-02T00:00:00.000Z');
});
