import type {ComponentData} from '@puckeditor/core';
import type {StudioState} from './types';

export const BUSINESS_BLOCKS=[
 {id:'hero',title:'首屏大图',group:'公司展示',description:'清楚的主标题、介绍和行动按钮',art:'hero'},
 {id:'company',title:'公司简介',group:'公司展示',description:'左右图文，介绍公司与业务',art:'split'},
 {id:'advantages',title:'公司优势',group:'公司展示',description:'三列图标卡片，突出合作价值',art:'cards'},
 {id:'factory',title:'工厂与生产',group:'公司展示',description:'用图片介绍车间、设备与生产环节',art:'gallery'},
 {id:'figures',title:'企业数据',group:'公司展示',description:'展示已核实的规模、经验和服务范围',art:'figures'},
 {id:'certificates',title:'证书与资质',group:'公司展示',description:'列明证书名称、范围与相关资料',art:'cards'},
 {id:'partners',title:'客户与合作伙伴',group:'公司展示',description:'整齐展示获得展示授权的合作标识',art:'logos'},
 {id:'process',title:'合作流程',group:'联系转化',description:'从沟通需求到交付的四步说明',art:'steps'},
 {id:'cases',title:'项目案例',group:'产品与案例',description:'图片、项目介绍和了解详情入口',art:'gallery'},
 {id:'downloads',title:'资料下载',group:'产品与案例',description:'产品目录与技术资料的集中入口',art:'cards'},
 {id:'faq',title:'常见问题',group:'联系转化',description:'可展开的问题，内部也能自由排版',art:'faq'},
 {id:'contact',title:'联系与询盘',group:'联系转化',description:'联系方式与明确的合作邀请',art:'contact'},
 {id:'buying-guide',title:'采购指南',group:'联系转化',description:'按问题介绍起订量、样品、报价及询盘准备',art:'faq'},
 {id:'quality-dispatch',title:'质检与出货',group:'公司展示',description:'用时间线说明检验、签样和出货记录',art:'steps'},
 {id:'customization',title:'定制选项',group:'产品与案例',description:'用可拖拽标签页介绍材料、尺寸、配置与品牌定制',art:'split'},
 {id:'applications',title:'产品应用场景',group:'产品与案例',description:'用实景图和核对要点帮助客户判断产品是否合适',art:'gallery'},
 {id:'industry-solutions',title:'行业解决方案',group:'产品与案例',description:'用交错图文展示不同采购群体的使用需求与下一步',art:'split'},
 {id:'packing-logistics',title:'包装物流',group:'联系转化',description:'整理外箱、标签、装载及目的地交接信息',art:'cards'},
] as const;
export type BusinessBlockId=typeof BUSINESS_BLOCKS[number]['id'];

/** 区块只生成普通组件；每次插入重建全部节点 ID，不增加发布依赖或伪造企业事实。 */
export function createBusinessBlock(id:BusinessBlockId,state:Pick<StudioState,'settings'|'pages'|'media'>,makeId=()=>`block-${crypto.randomUUID()}`):ComponentData{
 const node=(type:string,props:Record<string,unknown>):ComponentData=>({type,props:{id:makeId(),...props}});
 const text=(value:string)=>node('Text',{text:value,size:16,color:'#526274',align:'left',maxWidth:900});
 const heading=(value:string,size=32,level:'h2'|'h3'='h2')=>node('Heading',{text:value,level,size,mobileSize:28,color:'#172c3e',align:'left',style:'sans',spacing:0,design:{desktop:{fontSize:size,lineHeight:1.2},mobile:{fontSize:Math.min(size,30)}}});
 const label=(value:string)=>node('Text',{text:value,size:12,color:'#587466',align:'left',maxWidth:900,design:{desktop:{fontWeight:600,letterSpacing:1.5}}});
 const contact=state.pages.find(p=>/contact|联系/.test(p.slug+' '+p.title)&&!p.slug.includes(':'));
 const contactHref=contact?.slug||state.pages.find(p=>p.slug==='/')?.slug||state.pages.find(p=>!p.slug.includes(':'))?.slug||'/';
 const button=(value:string,href=contactHref)=>node('ActionButton',{text:value,href,kind:'theme',align:'left'});
 // 新区块的询盘按钮只指向已有联系页或填写过的邮箱，空站点不会把询盘导回首页。
 const inquiry=(value:string)=>{
  const emailHref=state.settings.email?`mailto:${state.settings.email}`:'';
  const href=contact?.slug||emailHref;
  return href?[button(value,href)]:[];
 };
 const image=(src='/images/studio.jpg',height=300)=>node('Image',{src,alt:'Illustrative layout image — replace with your own photograph',height,fit:'cover',radius:8,design:{desktop:{width:'100%',height},mobile:{height:220}}});
 const box=(content:ComponentData[],columns=1,extra:Record<string,unknown>={})=>node('Container',{content,layout:columns>1?'grid':'column',columns,mobileColumns:1,gap:24,padding:0,inset:0,background:'transparent',image:'',minHeight:0,align:'start',design:{desktop:{gap:24,alignItems:'start',...extra},tablet:{columns:Math.min(columns,2)},mobile:{columns:1,gap:20}}});
 const card=(content:ComponentData[])=>box(content,1,{backgroundColor:'#ffffff',borderWidth:1,borderColor:'#e1e7ec',borderRadius:8,paddingTop:24,paddingBottom:24,paddingLeft:24,paddingRight:24});
 const icon=(name:string)=>node('Icon',{icon:name,label:'',design:{desktop:{color:'#426c58',fontSize:28}}});
 const section=(content:ComponentData[])=>node('Container',{content,layout:'column',columns:1,mobileColumns:1,gap:32,padding:64,inset:40,background:'#f7f9fa',image:'',minHeight:0,align:'start',nodeLabel:BUSINESS_BLOCKS.find(b=>b.id===id)!.title,design:{desktop:{gap:32,paddingTop:64,paddingBottom:64,paddingLeft:40,paddingRight:40},mobile:{gap:24,paddingTop:32,paddingBottom:32,paddingLeft:20,paddingRight:20}}});
 switch(id){
  case 'hero':return section([box([box([label('INTRODUCING OUR COMPANY'),heading('Made for your next project.',56),text('Introduce your products, your approach and the customers you serve.'),button('Discuss your project')]),image('/images/interior.jpg',460)],2,{alignItems:'center'})]);
  case 'company':return section([box([image(),box([label('ABOUT US'),heading(state.settings.name||'Meet our company'),text('Tell customers what your company does, where you operate and how you work.'),text('Add a specific, verified reason to choose your team.'),button('Get in touch')])],2,{alignItems:'center'})]);
  case 'advantages':return section([label('WHY WORK WITH US'),heading('A practical approach to every project.'),box(['Understand the requirement','Choose the right solution','Keep the next step clear'].map((title,i)=>card([icon(['team','tool','check'][i]),heading(title,24),text('Replace this text with a specific strength and explain how it helps your customer.')])),3)]);
  case 'factory':return section([label('OUR WORKPLACE'),heading('Show how your products are made.'),text('Replace these illustrative images with your own production photographs.'),box(['/images/studio.jpg','/images/interior.jpg','/images/chair.jpg'].map((src,i)=>box([image(src,250),heading(['Production space','Equipment and process','Quality checks'][i],24),text('Describe what is visible in this photograph.')])),3)]);
  case 'figures':return section([label('COMPANY AT A GLANCE'),heading('The facts behind our work.'),text('Fill in verified figures and include the scope or period where needed.'),box(['Years in business','Production capacity','Markets served','Team members'].map(title=>card([heading('—',44),text(title)])),4)]);
  case 'certificates':return section([label('CREDENTIALS'),heading('Relevant qualifications, clearly explained.'),box(Array.from({length:3},()=>card([icon('safety'),heading('Add a certificate',24),text('Add the issuing organization, applicable products, scope and validity. Replace the icon with your certificate image if needed.')])),3)]);
  case 'partners':return section([label('WORKING TOGETHER'),heading('Our customers and partners.'),text('Replace the placeholders with logos you have permission to display.'),box(Array.from({length:4},()=>card([heading('Your partner logo',20)])),4)]);
  case 'process':return section([label('HOW WE WORK'),heading('A clear path from enquiry to delivery.'),box(['Share your requirements','Confirm the solution','Agree the order details','Arrange production and delivery'].map((title,i)=>card([label(`0${i+1}`),heading(title,22),text('Describe your actual process and what the customer needs to provide.')])),4)]);
  case 'cases':return section([label('PROJECT EXAMPLES'),heading('Show the work that matters.'),text('Replace these examples with completed projects you can share.'),box(['/images/interior.jpg','/images/studio.jpg','/images/sofa.jpg'].map(src=>card([image(src,220),heading('Add a project title',24),text('Describe the requirement, your contribution and the verified result.'),button('Ask about a similar project')])),3)]);
  case 'downloads':{
   const documents=state.media.filter(m=>m.kind==='document').slice(0,3);
   return section([label('RESOURCES'),heading('Useful information for your next decision.'),box(documents.length?documents.map(file=>card([icon('arrow'),heading(file.name,24),text('Add a short description of this document.'),node('Download',{text:'Download PDF',fileUrl:file.url})])):['Product catalogue','Technical information','Project requirements'].map(title=>card([icon('arrow'),heading(title,24),text('Add your document or tell customers how to request it.'),button('Request information')])),3)]);
  }
  case 'faq':return section([label('QUESTIONS & ANSWERS'),heading('Before you get in touch.'),node('Accordion',{panelMode:'free',firstOpen:true,items:['What information should I send?','How do we discuss a custom requirement?','Where can I find product information?'].map((title,i)=>({id:`question-${i+1}`,title,content:[box([text('Add your answer based on your actual products and service.'),button('Contact our team')])]}))})]);
  case 'contact':return section([box([box([label('LET’S TALK'),heading('Tell us what you are looking for.',42),text('Share your product requirements, drawings or project details so we can discuss the next step.')]),card([heading('Contact our team',24),text(state.settings.email||'Add your business email and telephone.'),button('Start a conversation',state.settings.email?`mailto:${state.settings.email}`:contactHref)])],2,{alignItems:'center'})]);
  case 'buying-guide': {
   // 把买家行动和采购政策分开。回答用原生可拖放面板，也可继续配图或加资料下载。
   const questions = [
    { title: 'Is there a minimum order?', answer: 'Include the model, quantity by variant and destination when asking about order requirements.' },
    { title: 'What should I include in a sample request?', answer: 'List the finish, dimensions or other properties you need to check, along with your preferred sample date.' },
    { title: 'How do I request a quote?', answer: 'Send the model numbers, required quantities, delivery location and any drawings or requirements you can share.' },
   ];
   return section([box([
    box([label('BUYING GUIDE'), heading('Prepare your first enquiry.'), text('Use this checklist to collect the information needed for a product enquiry.'), ...inquiry('Discuss your requirements')]),
    node('Accordion', { panelMode: 'free', firstOpen: true, items: questions.map(({ title, answer }, index) => ({ id: `purchase-${index + 1}`, title, content: [text(answer)] })) }),
   ], 2)]);
  }
  case 'quality-dispatch':
   // 时间线负责阶段关系，左栏独立展示证明图片及说明，两部分都可在图层内改动。
   return section([box([
    box([label('QUALITY DOCUMENTATION'), heading('Inspection and dispatch.'), text('Ask which inspections, photographs and sign-off documents can be provided for your order.'), image('/images/studio.jpg', 280)]),
    node('ProjectTimeline', {
     title: 'What to check at each stage',
     items: [
      { label: 'Before production', title: 'Confirm the reference', description: 'Record the approved specification, finish sample and acceptance criteria.' },
      { label: 'Before packing', title: 'Review the checks', description: 'Agree what will be inspected and how differences should be recorded.' },
      { label: 'Before dispatch', title: 'Confirm shipment evidence', description: 'Review the quantity, packing list and any dispatch photographs available.' },
     ],
    }),
   ], 2)]);
  case 'customization': {
   // 标签页只提供讨论起点，每个内容区仍接受原生图片、文字、容器和其他可拖放控件。
   const choices = [
    { title: 'Materials and finishes', image: '/images/chair.jpg', detail: 'Share a reference finish or material and explain what the product needs to withstand.' },
    { title: 'Dimensions and configuration', image: '/images/interior.jpg', detail: 'Include drawings, target dimensions and fitting constraints so the options can be reviewed.' },
    { title: 'Branding and labels', image: '/images/studio.jpg', detail: 'Provide permitted artwork, label placement and any production or packaging requirements.' },
   ];
   const tabs = node('Tabs', {
    panelMode: 'free',
    items: choices.map((choice, index) => ({
     id: `option-${index + 1}`,
     title: choice.title,
     content: [box([image(choice.image, 250), box([heading(choice.title, 24, 'h3'), text(choice.detail)])], 2, { alignItems: 'center' })],
    })),
   });
   return section([label('CUSTOM OPTIONS'), heading('Define what you need to customise.'), tabs, ...inquiry('Share a custom brief')]);
  }
  case 'applications':
   // 单张主图配两个可编辑的场景核对项，手机端按图片、说明、核对项的顺序阅读。
   return section([box([
    image('/images/interior.jpg', 410),
    box([
     label('PRODUCT APPLICATIONS'), heading('See how the product fits.'),
     text('Show a representative setting and explain what the buyer should confirm before selecting a product.'),
     box([
      card([heading('Space and clearances', 22, 'h3'), text('Check available space, access and installation conditions.')]),
      card([heading('Usage and care', 22, 'h3'), text('Check how often the product will be used and how it will be maintained.')]),
     ], 2, { alignItems: 'stretch' }),
    ]),
   ], 2, { alignItems: 'center' })]);
  case 'industry-solutions':
   // 两个买家角色使用交错图文，分别给出不同的项目资料和采购核对重点。
   return section([
    box([label('SOLUTIONS BY BUYER'), heading('Different buyers, different priorities.')]),
    box([
     image('/images/interior.jpg', 300),
     box([heading('Project and design teams', 26, 'h3'), text('Bring your layout, finish direction, installation dates and site requirements to the conversation.')]),
    ], 2, { alignItems: 'center' }),
    box([
     box([heading('Importers and distributors', 26, 'h3'), text('Bring your target assortment, expected order mix, destination and documentation needs.')]),
     image('/images/studio.jpg', 260),
    ], 2, { alignItems: 'center' }),
    ...inquiry('Discuss your purchasing needs'),
   ]);
  case 'packing-logistics':
   // 用有标题的独立清单行承载经确认的包装物流信息，避免插入虚构的包装承诺。
   return section([box([
    box([label('PACKING AND LOGISTICS'), heading('Plan the shipping handover.'), text('Ask about packing and delivery details early so you can compare quotes and prepare for receiving.'), ...inquiry('Ask about packing and delivery')]),
    card([
     heading('What to confirm', 24, 'h3'),
     box([label('PACKING FORMAT'), text('Verify units per carton, outer dimensions, gross weight and protective materials.')]),
     node('Divider', { text: '' }),
     box([label('LABELS AND DOCUMENTS'), text('Agree on item codes, carton marks, packing lists and any required documentation.')]),
     node('Divider', { text: '' }),
     box([label('DELIVERY HANDOVER'), text('Confirm the destination, shipping terms and any unloading or access restrictions.')]),
    ]),
   ], 2)]);
 }
}
