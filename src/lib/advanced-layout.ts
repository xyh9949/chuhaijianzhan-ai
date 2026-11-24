import {componentSlots} from './editor-slots';
import type {SiteTheme,SharedBlock} from './types';
import {resolveThemeDesign} from './theme-design';
import {ADVANCED_LAYOUT_KEYS,DESIGN_DEVICES,resolveDesign} from './responsive-style';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const hasKeys=(v:unknown)=>object(v)&&Object.values(v).some(fields=>object(fields)&&ADVANCED_LAYOUT_KEYS.some(k=>Object.hasOwn(fields,k)));
/** 复用样式和令牌的最终值也要受容器规则约束，不能只验证元素本地覆盖。 */
export function advancedLayoutErrors(source:{theme:SiteTheme;pages:{id:string;title:string}[];editorData:Record<string,unknown>;sharedBlocks?:{name:string;data:unknown}[];pageTemplates?:{name:string;data:unknown}[]}){
 const errors:string[]=[];
 function data(value:unknown,label:string){if(!object(value))return;const root=object(value.root)&&object(value.root.props)?value.root.props:{};if(hasKeys(resolveThemeDesign(source.theme,root)))errors.push(`${label}整页根节点不能使用高级定位与裁切`);
  const walk=(nodes:unknown,insideContainer=false):void=>{if(!Array.isArray(nodes))return;for(const node of nodes){if(!object(node)||!object(node.props))continue;const props=node.props,design=resolveThemeDesign(source.theme,props);
   if(!insideContainer&&DESIGN_DEVICES.some(device=>resolveDesign(design,device).position==='absolute'))errors.push(`${label}：组件 ${String(props.id)} 通过元素/复用样式/令牌绝对定位，必须放在显式容器内`);
   for(const key of ['fieldDesign','submitDesign'])if(hasKeys(props[key]))errors.push(`${label}：表单输入和提交控件不支持脱离表单的高级定位`);
   componentSlots({type:String(node.type),props}).forEach(slot=>walk(slot.content,insideContainer||node.type==='Container'));
  }};walk(value.content);if(object(value.zones))Object.values(value.zones).forEach(nodes=>walk(nodes));
 }
 source.pages.forEach(p=>data(source.editorData[p.id],`页面“${p.title}”`));source.sharedBlocks?.forEach(b=>data(b.data,`区块“${b.name}”`));source.pageTemplates?.forEach(t=>data(t.data,`模板“${t.name}”`));return errors;
}
/** 只有启用新属性的页面才建立定位/层叠上下文，避免旧客户的自定义CSS被全局改变。 */
export function usesAdvancedLayout(data:unknown,theme:SiteTheme,blocks:SharedBlock[]=[],seen=new Set<string>()):boolean{
 if(Array.isArray(data))return data.some(v=>usesAdvancedLayout(v,theme,blocks,seen));if(!object(data))return false;
 if(object(data.props)){
  const props=data.props,preset=theme.presets?.find(p=>p.id===props.stylePresetId);
  if(hasKeys(resolveThemeDesign(theme,data.props))||object(data.props.stateStyles)&&Object.values(data.props.stateStyles).some(hasKeys)||preset?.stateStyles&&Object.values(preset.stateStyles).some(hasKeys))return true;
  for(const key of ['blockId','itemBlockId'])if(typeof data.props[key]==='string'&&!seen.has(data.props[key])){const id=data.props[key];seen.add(id);const block=blocks.find(b=>b.id===id);if(block&&usesAdvancedLayout(block.data,theme,blocks,seen))return true;}
 }
 return Object.values(data).some(v=>usesAdvancedLayout(v,theme,blocks,seen));
}
