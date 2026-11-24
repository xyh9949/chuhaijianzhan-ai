/** 页面几何检查为提示，不把允许的叠放自动改成另一种布局。单位均为CSS px。 */
export type LayoutRect={left:number;right:number;top:number;bottom:number;width:number;height:number};
export function outsideRect(rect:LayoutRect,bounds:LayoutRect,vertical=false){return rect.left<bounds.left-2||rect.right>bounds.right+2||vertical&&(rect.top<bounds.top-2||rect.bottom>bounds.bottom+2);}
export function layoutFindings(doc:Document){
 const site=doc.querySelector<HTMLElement>('.editor-site');if(!site)return [{id:'canvas',message:'画布尚未就绪，请稍后检查'}];
 const bounds=site.getBoundingClientRect(),items:{id:string;message:string}[]=[],actions=Array.from(site.querySelectorAll<HTMLElement>('a,button,input,select,textarea,summary')).slice(0,100);
 for(const node of Array.from(site.querySelectorAll<HTMLElement>('.editor-design-node')).slice(0,1000)){
  const rect=node.getBoundingClientRect();if(!rect.width||!rect.height)continue;const id=node.id||node.tagName,style=doc.defaultView?.getComputedStyle(node);
  if(outsideRect(rect,bounds))items.push({id,message:'超出画布左右边界；请核对当前设备宽度、位移和定位'});
  if(style?.position==='absolute'){
   const parent=node.parentElement?.closest('.editor-site-section');if(parent&&outsideRect(rect,parent.getBoundingClientRect(),true))items.push({id,message:'绝对定位超出父容器；请核对容器高度与裁切设置'});
   if(actions.some(action=>{if(node.contains(action)||action.contains(node))return false;const a=action.getBoundingClientRect();return a.width>0&&a.height>0&&rect.left<a.right&&rect.right>a.left&&rect.top<a.bottom&&rect.bottom>a.top;}))items.push({id,message:'绝对定位可能覆盖交互控件，请核对点击和键盘焦点'});
  }
  if(items.length>=30)break;
 }
 return items;
}
