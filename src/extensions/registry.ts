/** 本地受信源码扩展：注册后重新构建；后台只保存经过schema验证的声明式JSON。 */
export type ExtensionField={kind:'text'|'rows'|'product'|'document';label:string;max?:number};
export type LocalExtension={namespace:string;type:string;label:string;version:number;readableVersions:readonly number[];license:string;description:string;schema:Record<string,ExtensionField>;defaultProps:Record<string,unknown>;migrate:(props:Record<string,unknown>,version:number)=>Record<string,unknown>};
export const SPEC_TYPE='studio/SpecificationTable';
export const LOCAL_EXTENSIONS:readonly LocalExtension[]=[{
 namespace:'studio',type:SPEC_TYPE,label:'业务规格表',version:2,readableVersions:[1,2],license:'MIT',description:'自填规格行，可关联产品和PDF目录；不推断真实产品参数。',
 schema:{title:{kind:'text',label:'规格表标题',max:160},caption:{kind:'text',label:'规格说明',max:500},rows:{kind:'rows',label:'规格行',max:50},productId:{kind:'product',label:'关联产品'},fileUrl:{kind:'document',label:'PDF目录'}},
 defaultProps:{extensionVersion:2,title:'Specifications',caption:'',rows:[{label:'Specification',value:'Add verified product information'}],productId:'',fileUrl:''},
 migrate:(props,version)=>{if(version===2)return structuredClone(props);const {items,...rest}=props;return {...structuredClone(rest),extensionVersion:2,rows:Array.isArray(items)?items.map(row=>{const r=row as Record<string,unknown>;return {label:r.name,value:r.value};}):items};},
}];
export const extensionFor=(type:string)=>LOCAL_EXTENSIONS.find(e=>e.type===type);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const shared=new Set(['id','anchor','nodeLabel','locked','design','stylePresetId','tokenBindings','stateStyles','bindings']);
/** 旧属性只在内存转成当前结构，不改历史快照；未来版本与未知业务属性必须显式拒绝。 */
export function normalizeExtensionProps(type:string,value:unknown):Record<string,unknown>{
 const e=extensionFor(type);if(!e||!object(value))throw Error(`缺少本地组件 ${type}`);
 if(!Number.isInteger(value.extensionVersion)||!e.readableVersions.includes(Number(value.extensionVersion)))throw Error(`组件 ${type} 不支持数据版本 ${String(value.extensionVersion)}`);
 const keys=new Set([...Object.keys(e.schema),'extensionVersion',...(value.extensionVersion===1?['items']:[])]);
 if(Object.keys(value).some(k=>!keys.has(k)&&!shared.has(k)))throw Error(`组件 ${type} 包含未知属性`);
 if(value.extensionVersion===1){if(!Array.isArray(value.items)||value.items.some(r=>!object(r)||Object.keys(r).some(k=>!['name','value'].includes(k))))throw Error(`组件 ${type} 旧规格行无效`);}
 const p=e.migrate(value,Number(value.extensionVersion));
 for(const[key,rule]of Object.entries(e.schema)){
  const v=p[key];if(v===undefined&&rule.kind!=='rows')continue;
  if(rule.kind==='rows'){if(!Array.isArray(v)||v.length>(rule.max||50)||v.some(r=>!object(r)||Object.keys(r).some(k=>!['label','value'].includes(k))||typeof r.label!=='string'||r.label.length>120||typeof r.value!=='string'||r.value.length>2000))throw Error(`组件 ${type} 规格最多50行，每行名称120/值2000字符`);}
  else if(typeof v!=='string'||(rule.kind==='text'?v.length>(rule.max||200):rule.kind==='product'?v!==''&&!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(v):v!==''&&!/^\/api\/media\/[a-zA-Z0-9_-]+$/.test(v)))throw Error(`组件 ${type} 属性“${rule.label}”无效`);
 }
 return p;
}
export function extensionReferences(type:string,value:unknown){
 const e=extensionFor(type),products:string[]=[],media:string[]=[];if(!e)return {products,media};const p=normalizeExtensionProps(type,value);
 for(const[key,rule]of Object.entries(e.schema)){const v=p[key];if(typeof v==='string'&&v){if(rule.kind==='product')products.push(v);if(rule.kind==='document')media.push(v);}}
 return {products,media};
}
export type ExtensionSource={pages:{id:string;title:string}[];editorData:Record<string,unknown>;sharedBlocks?:{id:string;name:string;data:unknown}[];pageTemplates?:{id:string;name:string;data:unknown}[];products?:{id:string}[];media?:{url:string;kind:string}[]};
export function extensionSourceErrors(source:ExtensionSource){const errors:string[]=[];
 const walk=(v:unknown,label:string):void=>{if(Array.isArray(v)){v.forEach(x=>walk(x,label));return;}if(!object(v))return;if(typeof v.type==='string'&&extensionFor(v.type)){try{const refs=extensionReferences(v.type,v.props);for(const id of refs.products)if(!source.products?.some(p=>p.id===id))errors.push(`${label}业务组件引用产品 ${id} 不存在或未选择发布`);for(const url of refs.media)if(!source.media?.some(m=>m.url===url&&m.kind==='document'))errors.push(`${label}业务组件目录必须选择现有PDF素材`);}catch(e){errors.push(`${label}：${(e as Error).message}`);}}Object.values(v).forEach(x=>walk(x,label));};
 for(const p of source.pages)walk(source.editorData[p.id],`页面“${p.title}”`);for(const b of source.sharedBlocks||[])walk(b.data,`区块“${b.name}”`);for(const t of source.pageTemplates||[])walk(t.data,`模板“${t.name}”`);return errors;
}

/** 提供给编辑器的明确升级动作；只转属性结构，不改节点ID、关系值或历史发布。 */
export function migrateExtensionData<T>(data:T):T{
 const walk=(v:unknown):unknown=>{if(Array.isArray(v))return v.map(walk);if(!object(v))return v;const next=Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)]));if(typeof v.type==='string'&&extensionFor(v.type))next.props=normalizeExtensionProps(v.type,v.props);return next;};return walk(data) as T;
}
export function extensionMigrationsNeeded(data:unknown):boolean{
 if(Array.isArray(data))return data.some(extensionMigrationsNeeded);if(!object(data))return false;if(typeof data.type==='string'&&object(data.props)){const e=extensionFor(data.type);if(e&&data.props.extensionVersion!==e.version)return true;}return Object.values(data).some(extensionMigrationsNeeded);
}

export function usedExtensionTypes(data:unknown):Set<string>{const result=new Set<string>();const walk=(v:unknown)=>{if(Array.isArray(v)){v.forEach(walk);return;}if(!object(v))return;if(typeof v.type==='string'&&extensionFor(v.type)&&object(v.props))result.add(v.type);Object.values(v).forEach(walk);};walk(data);return result;}
