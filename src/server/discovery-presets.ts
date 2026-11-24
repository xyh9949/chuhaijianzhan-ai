import {randomUUID} from 'node:crypto';
import {DISCOVERY_PRESETS} from '../lib/discovery-presets';
import {getDraftRecord,patchStudio} from './studio';
import {ApiError} from './http';
import type {ActorIdentity} from './types';
import type {ContentModel,FieldBinding} from '../lib/types';
/** 同一保存事务创建模型、独立详情模板与映射；不改已有页面或自动发布。 */
export function createDiscoveryPreset(kind:string,expectedRevision:number,actor:ActorIdentity){
 const preset=DISCOVERY_PRESETS.find(p=>p.id===kind);if(!preset)throw new ApiError(422,'未知资料预设');const d=getDraftRecord().content,suffix=randomUUID().slice(0,8),id=`info-${kind}-${suffix}`,pageId=`${id}-detail`;
 const model:ContentModel={id,name:preset.name,description:'请填写真实资料，完成核对后明确发布。预设不提供业务事实。',target:'content',updated:'',fields:preset.fields.map(([key,label])=>({id:`${id}-${key}`,key,label,type:key==='author'?'text':'textarea',required:key==='summary'}))};
 const binding=(field:string):FieldBinding=>({source:'entry',mode:'current',modelId:id,field});
 const heading=(text:string,level='h2',field?:string)=>({type:'Heading',props:{id:`node-${randomUUID()}`,text,level,size:level==='h1'?44:26,mobileSize:24,color:'#172033',align:'left',style:'sans',spacing:12,...(field?{bindings:{text:binding(field)}}:{})}});
 const content=[heading('','h1','builtin:title'),...model.fields.flatMap(f=>[heading(f.label),{type:'Text',props:{id:`node-${randomUUID()}`,text:'',size:16,color:'#334155',align:'left',maxWidth:900,bindings:{text:binding(`field:${f.id}`)}}}])];
 const discovery={...d.settings.discovery,mappings:[...d.settings.discovery?.mappings||[],{modelId:id,type:preset.schema,descriptionFieldId:model.fields[0].id,...(model.fields.find(f=>f.key==='author')?{authorFieldId:model.fields.find(f=>f.key==='author')!.id}:{})}]};
 return patchStudio({expectedRevision,patch:{contentModels:[...d.contentModels||[],model],pages:[...d.pages,{id:pageId,title:`${preset.name} · 详情`,slug:`/resources/${kind}-${suffix}/:slug`,type:'普通页面',status:'draft',updated:'',contentModelId:id}],editorData:{...d.editorData,[pageId]:{root:{props:{showChrome:'yes'}},content}},settings:{...d.settings,discovery}}},actor,'discovery.preset');
}
