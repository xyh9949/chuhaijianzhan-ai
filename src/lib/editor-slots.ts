import type {ComponentData} from '@puckeditor/core';

export interface EditorSlot {path:string;content:ComponentData[];label:string}

/** 与 Puck array/slot 字段路径一致；图层、校验和移动共用，不能漏掉面板里的子组件。 */
export function componentSlots(node:{type:string;props:Record<string,any>}):EditorSlot[]{
 const slots:EditorSlot[]=[];
 if(node.type==='Container'&&Array.isArray(node.props.content))slots.push({path:'content',content:node.props.content,label:'容器内容'});
 const key=['Tabs','Accordion'].includes(node.type)?'items':node.type==='Carousel'?'slides':undefined;
 if(key&&Array.isArray(node.props[key]))node.props[key].forEach((item:any,index:number)=>{
  if(item&&Array.isArray(item.content))slots.push({path:`${key}[${index}].content`,content:item.content,label:String(item.title||`第${index+1}项`)});
 });
 return slots;
}

/** 不使用动态求值或任意路径写入，只更新已经声明的内容插槽。 */
export function mapComponentSlots(node:ComponentData,change:(slot:EditorSlot)=>ComponentData[]):ComponentData{
 let props=node.props;
 for(const slot of componentSlots(node)){
  const content=change(slot);
  if(content===slot.content)continue;
  if(slot.path==='content')props={...props,content};
  else{const match=/^(items|slides)\[(\d+)\]\.content$/.exec(slot.path)!;const key=match[1],index=Number(match[2]);props={...props,[key]:props[key].map((item:any,i:number)=>i===index?{...item,content}:item)};}
 }
 return props===node.props?node:{...node,props};
}
