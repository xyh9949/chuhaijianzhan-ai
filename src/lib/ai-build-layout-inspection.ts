import type { AiBuildDeviceLayout, AiBuildLayoutInspection, AiBuildSectionLayout } from './ai-builder-types';
import type { DraftContent } from '../server/types';
import type { Data } from '@puckeditor/core';
import { getLegacyDesign, resolveDesign, type Device } from './responsive-style';
import { resolveThemeDesign } from './theme-design';
import { resolveLinkTarget } from './site-links';
import { safeImageSrc } from './site-safety';

type Node = { type: string; props: Record<string, unknown> };
type LayoutSource=Pick<DraftContent,'pages'|'editorData'|'theme'|'pageTemplates'|'products'|'contentEntries'|'contentModels'|'sharedBlocks'>&{settings:Pick<DraftContent['settings'],'language'|'locales'>};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nodes = (v: unknown): Node[] => Array.isArray(v) ? v.filter(item => record(item) && typeof item.type === 'string' && record(item.props)) as Node[] : [];
const listTypes = ['ContentList','ProductList','ContentLoop'];
function cardBindingFields(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(cardBindingFields);
  if (!record(value)) return [];
  return [...(record(value.bindings) ? Object.values(value.bindings).flatMap(binding => record(binding) && typeof binding.field === 'string' ? [binding.field] : []) : []), ...Object.values(value).flatMap(cardBindingFields)];
}
/** 两位数也可能是业务正文；新编号有显式图层名，旧035只兼容生成器原有编号形状。 */
const isOrdinal=(node:Node)=>{
  const p=node.props,desktop=record(p.design)&&record(p.design.desktop)?p.design.desktop:undefined;
  return node.type==='Text'&&/^\d{2}$/.test(String(p.text||''))&&(p.nodeLabel==='条目编号'||p.size===15&&p.maxWidth===120&&desktop?.fontFamily==='mono'&&desktop?.fontWeight===600);
};
const labels: Record<string, string> = { title: '主标题', heading: '小标题', copy: '正文', image: '图片', action: '按钮', products: '动态产品', entries: '动态内容', details: '实际产品详情', form: '询盘表单', number: '条目编号' };
export const aiLayoutFlowLabel = (flow: string[]) => flow.map(item => labels[item] || item).join(' → ') || '无可见内容';
export const aiLayoutDeviceForWidth = (width:number):Device => width<=700?'mobile':width<=1024?'tablet':'desktop';
/** 预览内导航可能打开真实产品地址；只匹配当前检查范围中的原生详情占位路径。 */
export function matchAiInspectionPage(inspection:AiBuildLayoutInspection,path:string){const value=path.split(/[?#]/)[0];return inspection.pages.find(page=>page.kind==='page'&&page.path===value)||inspection.pages.find(page=>page.kind==='page'&&page.path.includes(':')&&page.path.split('/').length===value.split('/').length&&page.path.split('/').every((part,index)=>part.startsWith(':')?!!value.split('/')[index]:part===value.split('/')[index]));}

/** 与真实渲染共用缺省值、主题/令牌及desktop→tablet→mobile继承，不能只读取显式mobile值。 */
export function inspectAiBuildLayout(source: LayoutSource, pageIds: string[], templateIds: string[] = []): AiBuildLayoutInspection {
  const pages: AiBuildLayoutInspection['pages'] = [];
  const inspect = (id: string, title: string, path: string, kind: 'page' | 'template', value: unknown) => {
    if (!record(value) || !Array.isArray(value.content)) return;
    const data = value as unknown as Data;
    const children = (node: Node) => Array.isArray(node.props.content) ? nodes(node.props.content) : nodes(data.zones?.[`${String(node.props.id)}:content`]);
    const style = (node: Node, device: Device) => resolveDesign(resolveThemeDesign(source.theme, node.props), device, getLegacyDesign(node.type, node.props, device));
    const ordered = (items: Node[], device: Device) => items.map((node,index) => ({node,index,order:Number(style(node,device).order)||0})).filter(item=>style(item.node,device).display!=='none').sort((a,b)=>a.order-b.order||a.index-b.index).map(item=>item.node);
    const columns = (node: Node, device: Device): number | null => { const s=style(node,device);return s.display==='grid'&&typeof s.columns==='number'?s.columns:null; };
    const facts = (node: Node, device: Device): AiBuildDeviceLayout => {
      const result: AiBuildDeviceLayout = {visible:style(node,device).display!=='none',order:Number(style(node,device).order)||0,columns:columns(node,device),innerGrids:[],flow:[],numberedItems:0,actions:[],lists:[]};
      if(!result.visible)return {...result,columns:null};
      let count=0;
      const visit = (item: Node, top=false) => {
        if(++count>10000)throw new Error('页面结构过大，无法生成准确排版摘要');
        if(style(item,device).display==='none')return;
        const p=item.props;
        if (item.type === 'ProductDetail' && device === 'mobile') {
          if (p.mobileOrder === 'identity-first') result.productIdentityFirst = true;
          if (p.mobileOrder === 'specifications-first' || p.mobileOrder === 'overview-first') {
            result.productIdentityFirst = true;
            result.productDetailOrder = p.mobileOrder;
          }
        }
        const token = item.type==='Heading'?(p.level==='h1'?'title':'heading'):item.type==='Text'?(isOrdinal(item)?'number':'copy'):item.type==='Image'&&safeImageSrc(p.src)?'image':item.type==='ActionButton'?'action':listTypes.includes(item.type)?(p.source==='entry'?'entries':'products'):item.type==='ProductDetail'?'details':item.type==='Form'?'form':undefined;
        if(token){if(result.flow[result.flow.length-1]!==token)result.flow.push(token);if(token==='number')result.numberedItems++;}
        if(item.type==='ActionButton'){
          const dynamic=record(p.bindings)&&!!p.bindings.href,href=dynamic?undefined:p.linkTarget?resolveLinkTarget(source,p.linkTarget):typeof p.href==='string'?p.href:undefined;
          result.actions.push({label:String(p.text||'按钮'),...(href?{path:href}:{}),...(dynamic?{dynamic:true}:{})});
        }
        if(listTypes.includes(item.type)){
          // 分页目录的字段来自实际共享卡片，不沿用旧列表字段说明。
          const fields = item.type==='ContentLoop'
            ? [...new Set(cardBindingFields(source.sharedBlocks?.find(block=>block.id===p.itemBlockId)?.data))]
            : [p.titleField,p.descriptionField,p.imageField,p.linkField].filter((field):field is string=>typeof field==='string'&&!!field);
          result.lists.push({id:String(p.id||''),source:p.source==='entry'?'entry':'product',columns:columns(item,device),fields});
        }
        const nested=ordered(children(item),device),n=columns(item,device);
        if(!top&&n!==null&&n>1){const grid={columns:n,spans:nested.map(child=>Number(style(child,device).columnSpan)||1)};if(!result.innerGrids.some(g=>JSON.stringify(g)===JSON.stringify(grid)))result.innerGrids.push(grid);}
        nested.forEach(child=>visit(child));
      };
      visit(node,true);return result;
    };
    const sections: AiBuildSectionLayout[] = nodes(data.content).map((node,index)=>{
      let heading='';const find=(item:Node)=>{if(!heading&&item.type==='Heading'&&typeof item.props.text==='string')heading=item.props.text;children(item).forEach(find);};find(node);
      const label=typeof node.props.nodeLabel==='string'?node.props.nodeLabel:'';
      return {id:String(node.props.id||`${id}-${index}`),title:label||heading||(node.type==='ProductDetail'?'实际产品详情':`内容区块 ${index+1}`),role:label==='AI生成品牌与页面导航'?'navigation':label==='AI生成页面页脚'?'footer':'content',desktop:facts(node,'desktop'),tablet:facts(node,'tablet'),mobile:facts(node,'mobile')};
    });
    // 顶层也遵守断点排序；保存两个断点内的顺序位置由展示层分别读取，原数组仍对应真实DOM顺序。
    pages.push({id,title,path,kind,sections});
  };
  for(const page of source.pages.filter(page=>pageIds.includes(page.id)))inspect(page.id,page.title,page.slug,'page',source.editorData[page.id]);
  for(const template of source.pageTemplates||[])if(templateIds.includes(template.id))inspect(template.id,template.name,template.sourcePath||'','template',template.data);
  return {source:'native-components',pages};
}
