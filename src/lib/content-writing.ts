import type {ContentEntry,ContentModel,Release} from './types';

/** 沿用原字段ID；常用正文优先，旧自定义栏目回退最后一个长文本，打开时不迁移数据。 */
export function entryWritingFields(model:ContentModel|undefined){
 const fields=model?.fields||[],long=fields.filter(f=>f.type==='textarea');
 const body=long.find(f=>/^(body|content|details?|introduction|bio)$/.test(f.key)||/正文|详情|详细介绍|成员介绍/.test(f.label))||long.at(-1);
 const excerpt=long.find(f=>f!==body&&(/^(summary|excerpt|abstract)$/.test(f.key)||/摘要|简介/.test(f.label)));
 const cover=fields.find(f=>f.type==='image'&&/^(cover|photo|image|thumbnail)$/.test(f.key))||fields.find(f=>f.type==='image');
 return {body,excerpt,cover,other:fields.filter(f=>f!==body&&f!==excerpt&&f!==cover)};
}
export function entryCover(entry:ContentEntry,models:ContentModel[]){const {cover}=entryWritingFields(models.find(m=>m.id===entry.modelId));const value=cover?entry.customFields[cover.id]:undefined;return typeof value==='string'?value:'';}
export function entryExcerpt(entry:ContentEntry,models:ContentModel[]){const {body,excerpt}=entryWritingFields(models.find(m=>m.id===entry.modelId)),value=[excerpt,body].map(field=>field?entry.customFields[field.id]:undefined).find(value=>typeof value==='string'&&value.trim());return typeof value==='string'?value.replace(/\s+/g,' ').trim():'';}
/** 由当前公开快照区分从未上线的草稿和已上线但待更新的修改，不能只看草稿状态。 */
export function entryPublicationState(entry:ContentEntry,releases:Release[],activeReleaseId:string|null){
 if(entry.status==='published')return 'published' as const;
 const snapshot=releases.find(r=>r.id===activeReleaseId)?.snapshot;
 return Array.isArray(snapshot?.contentEntries)&&snapshot.contentEntries.some(v=>v&&typeof v==='object'&&(v as {id?:string}).id===entry.id)?'modified' as const:'draft' as const;
}
export const ENTRY_PUBLICATION_LABELS={draft:'草稿',modified:'有修改待发布',published:'已发布'};
