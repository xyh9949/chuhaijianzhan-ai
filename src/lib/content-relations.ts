import type {BindingContext,ContentEntry,ContentField,ContentModel,PageItem,Product,RelationDefinition,RelationLoop} from './types';
import {getContentEntryPath,getProductPath} from './content-routes';
import type {LocaleSettings} from './localization';
export type RelationSource={products:Product[];contentEntries?:ContentEntry[];contentModels?:ContentModel[];pages?:PageItem[];settings?:LocaleSettings};
export type RelatedRecord=Product|ContentEntry;
export const MAX_RELATION_ITEMS=50,MAX_RELATION_EDGES=10000;
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);
/** 缓存/表单共用结构检查，不执行表达式；存在性由最终草稿或发布候选中的目标集合判断。 */
export function isRelationDefinition(value:unknown,{draft=false}:{draft?:boolean}={}):value is RelationDefinition{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as RelationDefinition;
 return Object.keys(v).every(k=>['source','modelId','multiple','onDelete'].includes(k))&&['product','entry'].includes(v.source)&&typeof v.multiple==='boolean'&&v.onDelete==='restrict'&&(v.modelId===undefined||draft&&v.modelId===''||validId(v.modelId))&&(draft||v.source!=='entry'||!!v.modelId);
}
export function relationIds(field:ContentField,value:unknown):string[]{return field.type==='relation'&&isRelationDefinition(field.relation)?field.relation.multiple?Array.isArray(value)?value.filter(validId):[]:validId(value)?[value]:[]:[];}
export function relationOptions(source:RelationSource,relation:RelationDefinition):RelatedRecord[]{return (relation.source==='product'?source.products:source.contentEntries||[]).filter(record=>!relation.modelId||record.modelId===relation.modelId);}
/** 保留业务选择顺序；只取目标记录本身，不继续展开它的关系，因此双向业务关系不会递归。 */
export function relatedRecords(source:RelationSource,field:ContentField,value:unknown):RelatedRecord[]{if(!isRelationDefinition(field.relation))return [];const byId=new Map(relationOptions(source,field.relation).map(r=>[r.id,r]));return relationIds(field,value).flatMap(id=>byId.has(id)?[byId.get(id)!]:[]);}
export function relatedTitle(record:RelatedRecord):string{return 'name' in record?record.name:record.title;}
export function relatedUrl(source:RelationSource,relation:RelationDefinition,record:RelatedRecord):string|undefined{return relation.source==='product'?getProductPath({...source,pages:source.pages||[]},record as Product):getContentEntryPath({...source,pages:source.pages||[]},record as ContentEntry);}
/** 检查字段结构、强引用与总边数，复用目标集合；不会偷偷携带未发布目标。 */
export function relationErrors(source:RelationSource):string[]{
 const errors:string[]=[],models=new Map((source.contentModels||[]).map(m=>[m.id,m]));let edges=0,missing=0;
 const targetSets=new Map<string,Set<string>>();
 const targets=(relation:RelationDefinition)=>{const key=`${relation.source}:${relation.modelId||'*'}`;if(!targetSets.has(key))targetSets.set(key,new Set(relationOptions(source,relation).map(r=>r.id)));return targetSets.get(key)!;};
 for(const model of source.contentModels||[])for(const field of model.fields){
  if(field.type!=='relation'){if(field.relation!==undefined)errors.push(`字段“${field.label}”不是关系字段，不能设置关系定义`);continue;}
  const relation=field.relation;if(!isRelationDefinition(relation)){errors.push(`关系字段“${field.label}”需明确目标/单多选及限制删除策略`);continue;}
  if(relation.modelId){const target=models.get(relation.modelId);if(!target||target.target!==(relation.source==='product'?'product':'content'))errors.push(`关系字段“${field.label}”的目标模型不存在或类型不匹配`);}
 }
 for(const record of [...source.products,...source.contentEntries||[]]){const model=record.modelId?models.get(record.modelId):undefined;if(!model)continue;
  for(const field of model.fields.filter(f=>f.type==='relation'&&isRelationDefinition(f.relation))){const ids=relationIds(field,record.customFields?.[field.id]);edges+=ids.length;
   // 达到预算立即停止，错误明细也有上限，避免坏导入放大检查时间和响应体。
   if(edges>MAX_RELATION_EDGES)return [...new Set(errors),`关系引用总数超过${MAX_RELATION_EDGES}，请减少记录关联`];
   const available=targets(field.relation!);for(const id of ids)if(!available.has(id)){if(++missing<=200)errors.push(`“${relatedTitle(record)}”的关系“${field.label}”引用了不存在或未选择发布的目标 ${id}，请先解除引用或同时发布目标`);}
  }
 }
 if(missing>200)errors.push(`另有${missing-200}处关系目标缺失，请修复后重新检查`);
 return [...new Set(errors)];
}
/** 依赖收集只返回稳定ID与明确模型，供保存/删除/部分发布/模板分发共用。 */
export function relationReferences(source:RelationSource){
 const productIds=new Set<string>(),entryIds=new Set<string>(),modelIds=new Set<string>();
 const models=new Map((source.contentModels||[]).map(m=>[m.id,m]));
 for(const model of models.values())for(const field of model.fields)if(field.type==='relation'&&isRelationDefinition(field.relation)&&field.relation.modelId)modelIds.add(field.relation.modelId);
 for(const record of [...source.products,...source.contentEntries||[]])for(const field of models.get(record.modelId||'')?.fields||[])if(field.type==='relation'&&isRelationDefinition(field.relation))for(const id of relationIds(field,record.customFields?.[field.id]))(field.relation.source==='product'?productIds:entryIds).add(id);
 return {productIds,entryIds,modelIds};
}
export function parseRelatedField(key:string):{fieldId:string;property:'title'|'url'}|undefined{const match=/^related:([a-zA-Z0-9][a-zA-Z0-9_-]{0,99}):(title|url)$/.exec(key);return match?{fieldId:match[1],property:match[2] as 'title'|'url'}:undefined;}
export function isRelationLoop(value:unknown):value is RelationLoop{if(!value||typeof value!=='object'||Array.isArray(value))return false;const v=value as RelationLoop;return Object.keys(v).every(k=>['source','modelId','fieldId'].includes(k))&&['product','entry'].includes(v.source)&&validId(v.modelId)&&validId(v.fieldId);}
export function relationLoopField(source:RelationSource,value:unknown):ContentField|undefined{if(!isRelationLoop(value))return;const model=source.contentModels?.find(m=>m.id===value.modelId&&m.target===(value.source==='product'?'product':'content'));return model?.fields.find(f=>f.id===value.fieldId&&f.type==='relation'&&isRelationDefinition(f.relation));}
/** 未配置时保留普通集合；关系缺值返回空集合，绝不能退回全站内容。 */
export function relationLoopIds(source:RelationSource,value:unknown,context:{bindingContext?:BindingContext;productId?:string}={}):string[]|undefined{
 if(value===undefined)return undefined;if(!isRelationLoop(value))return [];const field=relationLoopField(source,value);if(!field)return [];
 const id=value.source==='product'&&context.productId?context.productId:context.bindingContext?.source===value.source?context.bindingContext.recordId:undefined;
 const record=(value.source==='product'?source.products:source.contentEntries||[]).find(r=>r.id===id&&r.modelId===value.modelId&&r.status==='published');return record?relationIds(field,record.customFields?.[field.id]):[];
}
