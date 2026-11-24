import type {ContentEntry,ContentModel,ContentField,PageItem} from './types';
import {createContentDesignData} from './content-design-presets';

/** 常用栏目只是填写项目和可编辑详情页；点“启用”才写入，绝不生成业务记录。 */
export const CONTENT_COLUMN_PRESETS=[
 {key:'case',name:'案例',description:'填写项目介绍、图片和实际方案。',aliases:['案例','项目案例','客户案例','cases','case studies'],path:'cases',fields:[['cover','案例封面','image'],['country','国家 / 地区','text'],['summary','案例简介','textarea'],['body','项目详情','textarea'],['gallery','案例图库','gallery']]},
 {key:'news',name:'新闻',description:'发布公司动态、行业资讯和活动消息。',aliases:['新闻','公司新闻','新闻资讯','news'],path:'news',fields:[['cover','新闻图片','image'],['summary','新闻摘要','textarea'],['body','新闻正文','textarea'],['author','作者','text'],['date','内容日期','date']]},
 {key:'team',name:'团队',description:'介绍成员照片、职位和工作经历。',aliases:['团队','团队成员','team'],path:'team',fields:[['photo','成员照片','image'],['position','职位','text'],['body','成员介绍','textarea']]},
] as const;
export type ColumnPresetKey=typeof CONTENT_COLUMN_PRESETS[number]['key'];
export function columnPreset(model:ContentModel){return CONTENT_COLUMN_PRESETS.find(p=>p.aliases.some(name=>name.toLowerCase()===model.name.trim().toLowerCase())||model.id.startsWith(`column-${p.key}-`)||p.key==='case'&&model.id.startsWith('info-case-'));}
export function contentColumns(models:ContentModel[],entries:ContentEntry[]){
 const current=models.filter(m=>m.target==='content');
 return [...current.map(model=>({key:model.id,name:model.name,count:entries.filter(e=>e.modelId===model.id).length,model,preset:columnPreset(model)})),...CONTENT_COLUMN_PRESETS.filter(p=>!current.some(m=>columnPreset(m)?.key===p.key)).map(p=>({key:`preset:${p.key}`,name:p.name,count:0,model:undefined,preset:p}))];
}
export function createContentColumn(kind:ColumnPresetKey,token:string,pages:PageItem[]){
 const preset=CONTENT_COLUMN_PRESETS.find(p=>p.key===kind)!;const id=`column-${kind}-${token}`;
 const fields:ContentField[]=preset.fields.map(([key,label,type])=>({id:`${id}-${key}`,key,label,type,required:false}));
 const model:ContentModel={id,name:preset.name,description:preset.description,target:'content',fields,updated:''};
 // 已有栏目和静态子页不改名；新详情路径取可用后缀，语言前缀仍由原路由规则处理。
 let path=`/${preset.path}`,index=2;while(pages.some(p=>p.slug.startsWith(`${path}/`)))path=`/${preset.path}-${index++}`;
 const page:PageItem={id:`${id}-detail`,title:`${preset.name}详情`,slug:`${path}/:slug`,type:'普通页面',status:'draft',updated:'',contentModelId:id};
 const binding=(field:string)=>({source:'entry',mode:'current',modelId:id,field});
 const content=[{type:'Heading',props:{id:`${id}-title`,text:'',level:'h1',bindings:{text:binding('builtin:title')}}},...fields.map(f=>f.type==='image'?{type:'Image',props:{id:`${f.id}-node`,src:'',alt:'',bindings:{src:binding(`field:${f.id}`),alt:binding('builtin:title')}}}:{type:'Text',props:{id:`${f.id}-node`,text:'',bindings:{text:binding(`field:${f.id}`)}}})];
 // 只改善明确的新案例起点；新闻/团队和已保存详情不自动重编。
 const data=kind==='case'?createContentDesignData({name:page.title,source:'entry',model,kind:'detail',detailKind:'case'}):{root:{props:{showChrome:'yes'}},content};
 return {model,page,data,mapping:{modelId:id,type:kind==='team'?'WebPage' as const:'Article' as const,descriptionFieldId:fields.find(f=>f.key==='summary'||f.key==='body')!.id,...(fields.find(f=>f.key==='author')?{authorFieldId:fields.find(f=>f.key==='author')!.id}:{})}};
}
