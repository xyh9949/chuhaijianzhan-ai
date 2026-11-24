import type { ComponentData, Data } from '@puckeditor/core';
import protocol from '../protocol.json';
import type { SiteSnapshot } from '../../server/types';
import type { ContentEntry, ContentModel, FieldBinding, PageItem, SharedBlock, SiteTheme } from '../types';
import type { DesignValues, ResponsiveDesign } from '../responsive-style';

/** 制造业整站示例仅组装现有组件；图片、字段、卡片和面板内容都保留在编辑器中。 */
export function createManufacturingStarter(): SiteSnapshot {
  const c = { paper: '#f5f3ed', white: '#ffffff', ink: '#102c3b', muted: '#586a70', line: '#d4dcd9', pale: '#e8eeeb', copper: '#b65028', navy: '#102c3b', light: '#ccd9da' };
  const brand = 'ATLAS WORKS';
  const factory = '/images/showcase-factory.png';
  const components = '/images/showcase-components.png';
  const date = '2026-11-10T00:00:00.000Z';
  let sequence = 0;
  const node = (type: string, props: Record<string, unknown>): ComponentData => ({ type, props: { id: `mfg-${type}-${++sequence}`, ...props } });
  const data = (title: string, content: ComponentData[], chrome = true): Data => ({ root: { props: { title, brand, showChrome: chrome ? 'yes' : 'no' } }, content } as Data);
  const heading = (text: string, size = 42, options: { color?: string; level?: string; maxWidth?: number } = {}) => node('Heading', {
    text, size, mobileSize: size > 52 ? 42 : Math.min(size, 30), color: options.color || c.ink, align: 'left', style: 'sans', spacing: 0, level: options.level || 'h2',
    design: { desktop: { fontWeight: 500, lineHeight: 1.06, letterSpacing: -size / 42, maxWidth: options.maxWidth || 900 }, mobile: { fontSize: size > 52 ? 42 : Math.min(size, 30), letterSpacing: -0.8 } },
  });
  const text = (value: string, color = c.muted, size = 16, maxWidth = 760) => node('Text', { text: value, color, size, align: 'left', maxWidth, design: { desktop: { lineHeight: 1.75 }, mobile: { fontSize: Math.min(size, 16) } } });
  const label = (value: string, color = c.copper) => node('Text', { text: value, color, size: 11, align: 'left', maxWidth: 900, design: { desktop: { fontSize: 11, fontWeight: 600, letterSpacing: 1.8, lineHeight: 1.6 }, mobile: { fontSize: 10, letterSpacing: 1.4 } } });
  const button = (value: string, href: string, outline = false, light = false) => node('ActionButton', {
    text: value, href, kind: outline ? 'outline' : 'theme', align: 'left',
    design: { desktop: { height: 48, paddingLeft: 22, paddingRight: 22, borderRadius: 0, fontSize: 12, fontWeight: 600, letterSpacing: 0.3, color: outline ? light ? c.white : c.ink : c.white, backgroundColor: outline ? 'transparent' : c.copper, borderWidth: 1, borderColor: outline ? light ? '#71838a' : c.line : c.copper }, mobile: { height: 46 } },
    stateStyles: { hover: { desktop: { backgroundColor: outline ? light ? '#294552' : c.pale : '#943c1e', borderColor: outline ? light ? c.light : '#a5b6b4' : '#943c1e' } } },
  });
  // 容器只负责可视布局，手机断点显式收成一列；所有节点每次调用均产生唯一 ID。
  const box = (content: ComponentData[], options: { columns?: number; gap?: number; background?: string; padding?: number; inset?: number; design?: ResponsiveDesign; nodeLabel?: string } = {}) => {
    const { columns = 1, gap = 24, background = 'transparent', padding = 0, inset = 0, design = {}, nodeLabel } = options;
    return node('Container', { content, layout: columns > 1 ? 'grid' : 'column', columns, mobileColumns: 1, gap, padding, inset, background, image: '', minHeight: 0, align: 'start', ...(nodeLabel ? { nodeLabel } : {}),
      design: { desktop: { alignItems: 'start', ...design.desktop }, tablet: { ...design.tablet }, mobile: { columns: 1, gap: Math.min(gap, 24), ...design.mobile } } });
  };
  const section = (content: ComponentData[], options: { background?: string; padding?: number; columns?: number; gap?: number; design?: DesignValues; mobile?: DesignValues; nodeLabel?: string } = {}) => box(content, {
    background: options.background || c.paper, columns: options.columns || 1, gap: options.gap || 28, padding: options.padding ?? 88, inset: 48, nodeLabel: options.nodeLabel,
    design: { desktop: { maxWidth: 1440, marginLeft: 'auto', marginRight: 'auto', ...options.design }, tablet: { paddingLeft: 32, paddingRight: 32, paddingTop: 64, paddingBottom: 64 }, mobile: { paddingLeft: 20, paddingRight: 20, paddingTop: 44, paddingBottom: 44, ...options.mobile } },
  });
  const image = (src: string, alt: string, height = 460, position = 'center') => node('Image', { src, alt, height, fit: 'cover', radius: 0, design: { desktop: { width: '100%', height, objectPosition: position }, tablet: { height: Math.min(height, 420) }, mobile: { height: 300, objectPosition: position } } });
  const rule = () => node('Divider', { color: c.line, thickness: 1, spacing: 0 });
  const page = (id: string, title: string, slug: string, modelId?: string): PageItem => ({ id, title, slug, type: modelId ? '内容详情' : slug === '/products/:slug' ? '产品详情' : '普通页面', status: 'published', updated: date, ...(modelId ? { contentModelId: modelId } : {}), seoTitle: `${title} — Atlas Works`, seoDescription: 'Atlas Works is a fictional manufacturing website demonstration. Product studies and project concepts illustrate an editable company website.' });

  const productModel: ContentModel = { id: 'starter-product-model', name: '产品扩展参数', target: 'product', description: '制造业演示产品参数，可在产品管理中继续增加或修改。', updated: date, fields: [
    { id: 'starter-process', key: 'process', label: '工艺方向', type: 'text', required: false },
    { id: 'starter-finish', key: 'finish', label: '表面处理', type: 'text', required: false },
    { id: 'starter-application', key: 'application', label: '应用方向', type: 'text', required: false },
    { id: 'starter-drawing', key: 'drawing', label: '图纸与技术资料', type: 'textarea', required: false },
  ] };
  const projectModel: ContentModel = { id: 'starter-case-model', name: '工程研究案例', target: 'content', description: '虚构的制造项目研究，用于演示案例栏目、卡片与详情页。', updated: date, fields: [
    { id: 'starter-case-summary', key: 'summary', label: '案例摘要', type: 'textarea', required: false },
    { id: 'starter-case-category', key: 'category', label: '项目类别', type: 'text', required: false },
    { id: 'starter-case-image', key: 'image', label: '封面图片', type: 'image', required: false },
    { id: 'starter-case-challenge', key: 'challenge', label: '设计问题', type: 'textarea', required: false },
    { id: 'starter-case-approach', key: 'approach', label: '工作思路', type: 'textarea', required: false },
    { id: 'starter-case-deliverables', key: 'deliverables', label: '交付资料', type: 'textarea', required: false },
  ] };
  const productBinding = (field: string): FieldBinding => ({ source: 'product', mode: 'current', modelId: productModel.id, field });
  const caseBinding = (field: string): FieldBinding => ({ source: 'entry', mode: 'current', modelId: projectModel.id, field });
  const boundText = (binding: FieldBinding, fallback: string, color = c.muted, size = 16) => node('Text', { text: fallback, size, color, align: 'left', maxWidth: 860, bindings: { text: binding }, design: { desktop: { lineHeight: 1.8 } } });
  const boundHeading = (binding: FieldBinding, fallback: string, size = 42, level = 'h2') => node('Heading', { text: fallback, size, mobileSize: Math.min(size, 38), color: c.ink, align: 'left', style: 'sans', level, bindings: { text: binding }, design: { desktop: { fontWeight: 500, lineHeight: 1.08, letterSpacing: -1.2 }, mobile: { fontSize: Math.min(size, 38) } } });
  const boundImage = (binding: FieldBinding, altBinding: FieldBinding, height = 310) => node('Image', { src: components, alt: 'Demonstration component study', height, fit: 'cover', radius: 0, bindings: { src: binding, alt: altBinding }, design: { desktop: { width: '100%', height }, mobile: { height: Math.min(height, 320) } } });
  const dynamicLink = (binding: FieldBinding, title: string) => node('ActionButton', { text: title, href: '', kind: 'outline', align: 'left', bindings: { href: binding }, design: { desktop: { borderWidth: 0, borderRadius: 0, paddingLeft: 0, paddingRight: 0, color: c.ink, fontSize: 12, fontWeight: 600 } } });

  // 型号、材料与案例均为明确标注的设计演示，不代表实际生产条件、承诺或客户业绩。
  const productStudies = [
    { name: 'Machined housing', category: 'Machined components', material: 'Aluminium · concept material', process: 'Milling concept', finish: 'Bead-blast finish study', application: 'Equipment and instrument housings', description: 'A compact housing study with clearly organised mounting faces and internal pockets. A useful starting point for discussing interfaces, access and surface requirements.' },
    { name: 'Turned connector', category: 'Turned components', material: 'Stainless steel · concept material', process: 'Turning concept', finish: 'Machined finish study', application: 'Mechanical connection assemblies', description: 'A cylindrical connection concept focused on mating surfaces and assembly sequence. Present drawing revisions, material choices and inspection notes together.' },
    { name: 'Mounting bracket', category: 'Structural components', material: 'Steel · concept material', process: 'Forming and machining concept', finish: 'Coated finish study', application: 'Equipment mounting systems', description: 'An angled support concept that brings fixing positions and installation access into one clear product brief. Explore dimensions and finishing requirements before quotation.' },
    { name: 'Precision shaft', category: 'Turned components', material: 'Steel · concept material', process: 'Turning and grinding concept', finish: 'Ground surface study', application: 'Rotating mechanical assemblies', description: 'A stepped-shaft concept for discussing bearing interfaces, alignment and surface requirements. Critical fits belong on an approved technical drawing.' },
    { name: 'Fixture plate', category: 'Machined components', material: 'Aluminium · concept material', process: 'Plate machining concept', finish: 'Anodised finish study', application: 'Assembly and inspection fixtures', description: 'A modular fixture concept with an orderly fixing pattern and accessible datum references. Organise the workholding intent alongside the component geometry.' },
    { name: 'Equipment enclosure', category: 'Structural components', material: 'Sheet metal · concept material', process: 'Sheet-metal fabrication concept', finish: 'Powder-coat finish study', application: 'Equipment protection and access panels', description: 'An enclosure concept that considers ventilation, access and panel assembly. A complete brief connects external appearance with service and installation needs.' },
  ];
  const products: SiteSnapshot['products'] = productStudies.map((p, i) => ({ id: `starter-product-${i + 1}`, slug: `sample-${i + 1}`, name: p.name, sku: `AW-STUDY-0${i + 1}`, category: p.category, status: 'published', image: components, images: [components, factory], description: p.description, material: p.material, modelId: productModel.id, updated: date, sortOrder: i, termIds: [p.category === 'Machined components' ? 'starter-family-machined' : p.category === 'Turned components' ? 'starter-family-turned' : 'starter-family-structural'],
    customFields: { 'starter-process': p.process, 'starter-finish': p.finish, 'starter-application': p.application, 'starter-drawing': 'Send a dimensioned drawing, revision reference, intended use and approximate quantity. Materials, tolerances and finishing requirements are agreed after technical review.' },
    seoTitle: `${p.name} study — Atlas Works`, seoDescription: `${p.name}. A fictional component study from the Atlas Works demonstration catalogue.`,
  }));
  const projects: ContentEntry[] = [
    { id: 'starter-case-1', modelId: projectModel.id, slug: 'housing-design-study', title: 'A clearer brief for a complex housing', status: 'published', updated: date, sortOrder: 0, customFields: {
      'starter-case-category': 'Component development · concept', 'starter-case-image': components,
      'starter-case-summary': 'An illustrative equipment-housing study: turning a collection of interface requirements into a readable component brief.',
      'starter-case-challenge': 'The concept brings mounting faces, internal pockets and access requirements into a single housing. The useful question is how each feature relates to the complete assembly.',
      'starter-case-approach': 'Separate functional interfaces from cosmetic surfaces, identify the drawing revision, and list the features that need further review. Keep material and finishing decisions connected to the intended use.',
      'starter-case-deliverables': 'Example review pack: annotated drawing, open-question register, material and finish notes, and a sample approval checklist. This study is fictional and does not represent completed client work.',
    } },
    { id: 'starter-case-2', modelId: projectModel.id, slug: 'modular-fixture-study', title: 'A modular approach to workholding', status: 'published', updated: date, sortOrder: 1, customFields: {
      'starter-case-category': 'Assembly tooling · concept', 'starter-case-image': factory,
      'starter-case-summary': 'A fixture concept that explores repeatable location, clear access and a considered assembly sequence.',
      'starter-case-challenge': 'A fixture has to locate a component while leaving room for the operation itself. This study organises those competing needs before selecting a detailed layout.',
      'starter-case-approach': 'Map locating points, clamping positions and operator access. Use the drawing review to surface unclear assumptions and record the reasons behind each layout decision.',
      'starter-case-deliverables': 'Example review pack: fixture layout, locating scheme, assembly sequence and points for sample evaluation. This is a design demonstration with no measured performance claim.',
    } },
    { id: 'starter-case-3', modelId: projectModel.id, slug: 'bracket-system-study', title: 'Small details, a more useful assembly', status: 'published', updated: date, sortOrder: 2, customFields: {
      'starter-case-category': 'Mounting systems · concept', 'starter-case-image': components,
      'starter-case-summary': 'A bracket-system study connecting fixing positions, installation space and the appearance of the finished assembly.',
      'starter-case-challenge': 'Mounting components are often defined by the space around them. This fictional study starts with the installation context rather than a single isolated part.',
      'starter-case-approach': 'Review fixing access, surrounding components and the order of assembly. Distinguish structural questions from visual preferences and carry both through the drawing discussion.',
      'starter-case-deliverables': 'Example review pack: application sketch, interface drawing, finish reference and an installation checklist. Actual suitability requires a separate engineering assessment.',
    } },
  ];

  const form = { id: 'starter-inquiry', name: '项目询盘', enabled: true, submitLabel: 'Send project enquiry', successMessage: 'Thank you. Your project enquiry has been received.', fields: [
    { id: 'starter-form-name', label: 'Your name', type: 'text' as const, mapTo: 'name' as const, required: true, maxLength: 150, placeholder: 'Full name' },
    { id: 'starter-form-email', label: 'Work email', type: 'email' as const, mapTo: 'email' as const, required: true, maxLength: 254, placeholder: 'name@example.invalid' },
    { id: 'starter-form-company', label: 'Company', type: 'text' as const, mapTo: 'company' as const, required: false, maxLength: 150, placeholder: 'Company or organisation' },
    { id: 'starter-form-country', label: 'Country / region', type: 'country' as const, mapTo: 'country' as const, required: false, maxLength: 100 },
    { id: 'starter-form-product', label: 'Component of interest', type: 'product' as const, mapTo: 'product' as const, required: false },
    { id: 'starter-form-message', label: 'Tell us about your project', type: 'textarea' as const, mapTo: 'message' as const, required: true, maxLength: 4000, placeholder: 'Application, drawing reference, material, quantity and any questions.' },
  ] };
  const inquiry = () => node('Form', { formId: form.id, wideFields: ['starter-form-product', 'starter-form-message'], buttonAlign: 'left', design: { desktop: { columns: 2, gap: 24, maxWidth: 900 }, mobile: { columns: 1, gap: 20 } }, fieldDesign: { desktop: { borderWidth: 1, borderColor: c.line, borderRadius: 0, backgroundColor: c.white, paddingTop: 12, paddingBottom: 12 } }, submitDesign: { desktop: { backgroundColor: c.copper, color: c.white, borderColor: c.copper, borderRadius: 0, height: 48, fontWeight: 600 } } });
  const cta = (title = 'Bring your next component into focus.') => section([
    box([label('START A CONVERSATION', '#e9aa83'), heading(title, 48, { color: c.white }), text('Start with a drawing, an application or an open question. A good brief makes the next conversation more useful.', c.light, 17, 680)], { gap: 22 }),
    box([button('Discuss a project', '/contact'), button('Read the enquiry guide', '/faq', true, true)], { gap: 14 }),
  ], { columns: 2, background: c.navy, padding: 72, gap: 64, design: { alignItems: 'center' }, nodeLabel: '项目询盘引导' });
  const intro = (eyebrow: string, title: string, copy: string) => section([label(eyebrow), heading(title, 68, { level: 'h1', maxWidth: 1000 }), text(copy, c.muted, 19, 820)], { padding: 80, nodeLabel: '页面标题' });
  const productLoop = (count = 6, controls = false) => node('ContentLoop', { source: 'product', modelId: productModel.id, itemBlockId: 'starter-card', title: '', count, columns: 3, mobileColumns: 1, gap: 30, padding: 0, emptyText: 'New component studies will appear here.', ...(controls ? { query: { controls: true, sort: 'builtin:sortOrder', direction: 'asc' } } : {}), design: { desktop: { paddingLeft: 0, paddingRight: 0 }, mobile: { paddingLeft: 0, paddingRight: 0 } } });
  const projectLoop = (count = 3) => node('ContentLoop', { source: 'entry', modelId: projectModel.id, itemBlockId: 'starter-case-card', title: '', count, columns: 3, mobileColumns: 1, gap: 30, padding: 0, emptyText: 'New project studies will appear here.', design: { desktop: { paddingLeft: 0, paddingRight: 0 }, mobile: { paddingLeft: 0, paddingRight: 0 } } });
  const stages = () => box([
    ['01 / DEFINE', 'Begin with the application.', 'Share what the component needs to do, how it is assembled and which details are already fixed.'],
    ['02 / REVIEW', 'Make the open questions visible.', 'Bring drawings, material preferences and finish references together before a commercial discussion.'],
    ['03 / ALIGN', 'Agree the approval points.', 'Record the drawing revision, sample expectations and information needed for the next decision.'],
    ['04 / HAND OVER', 'Keep the record together.', 'Organise approved information, inspection requirements and packaging notes in a consistent project pack.'],
  ].map(([number, title, copy]) => box([label(number), heading(title, 25), text(copy, c.muted, 15)], { gap: 20, padding: 26, inset: 26, background: c.white, design: { desktop: { borderWidth: 1, borderColor: c.line } } })), { columns: 4, gap: 18, design: { tablet: { columns: 2 }, mobile: { columns: 1 } } });
  const reviewTabs = () => node('Tabs', { panelMode: 'free', items: [
    { id: 'materials', title: 'Material & finish', content: [box([heading('Define the surface as carefully as the shape.', 28), text('Material condition, visible surfaces and finishing references belong in the same conversation. Separate visual preferences from functional requirements.'), box([label('USEFUL INPUTS'), text('Material reference · surface appearance · exposure conditions · areas to protect', c.ink, 15)], { background: c.pale, padding: 24, inset: 24 })], { gap: 22 })] },
    { id: 'drawing', title: 'Drawing review', content: [box([heading('One drawing. One current revision.', 28), text('Identify mating features, inspection references and any requirements that need interpretation. An annotated drawing makes unanswered questions easier to track.'), button('See the review workflow', '/quality', true)], { gap: 22 })] },
    { id: 'handover', title: 'Project handover', content: [box([heading('Give the next person a complete picture.', 28), text('Keep the approved revision, sample notes and agreed documentation together. A project record is most useful when the assumptions are visible.'), button('Prepare an enquiry', '/contact', true)], { gap: 22 })] },
  ] });
  const faqItems = [
    ['What should I include in an enquiry?', 'A drawing or sketch, the intended application, approximate quantity and your destination are useful starting points. Include a revision reference and any known material, finishing or inspection requirements.'],
    ['Can I ask about a part that is not in the catalogue?', 'Use the enquiry form to describe the application and the information you already have. The component studies show how a catalogue can present different kinds of parts; they do not define a real production offer.'],
    ['How are materials and tolerances confirmed?', 'They need to be reviewed against the drawing and the intended use. Catalogue concept materials are illustrative. No tolerance, suitability or material approval is implied by these demonstration pages.'],
    ['What documents can I request?', 'Describe the information your review needs: a product sheet, drawing reference, material information or an inspection plan. Documents should only be supplied when their content and scope have been verified.'],
    ['Are the project studies real client projects?', 'No. Atlas Works is a fictional demonstration brand. Its component concepts, project studies and generated imagery illustrate the website structure and are not evidence of facilities, clients, certification or business results.'],
    ['Can these pages be adapted to a real factory?', 'Yes. Product records, extended parameters, project articles, enquiry fields and every page section are editable. Replace the examples with authorised photography and verified company information before customer use.'],
  ];
  const faq = (count = faqItems.length) => node('Accordion', { panelMode: 'free', firstOpen: false, items: faqItems.slice(0, count).map(([title, answer], index) => ({ id: `enquiry-question-${index + 1}`, title, content: [box([text(answer, c.muted, 16, 960), ...(index === 0 ? [button('Open the enquiry form', '/contact', true)] : [])], { padding: 14, inset: 8, gap: 20 })] })) });

  const sharedBlocks: SharedBlock[] = [
    { id: 'starter-header', name: '全站页眉 · Atlas Works', updated: date, data: data('Main header', [section([
      box([heading(brand, 23, { level: 'h2' }), label('COMPONENTS / CONSIDERED', c.muted)], { gap: 4 }),
      box([node('Navigation', { menuId: 'starter-menu', label: 'Main navigation', design: { desktop: { color: c.ink, fontSize: 12 } } })], { design: { desktop: { columnSpan: 3 }, mobile: { columnSpan: 1 } } }),
    ], { background: c.paper, padding: 26, columns: 4, gap: 30, design: { alignItems: 'center', borderWidth: 1, borderColor: c.line }, mobile: { paddingTop: 22, paddingBottom: 22 }, nodeLabel: '统一导航' })], false) },
    { id: 'starter-footer', name: '全站页脚 · Atlas Works', updated: date, data: data('Main footer', [section([
      box([heading(brand, 28), text('A considered component. A clearer conversation.', c.muted, 16), label('FICTIONAL BRAND / WEBSITE DEMONSTRATION')], { gap: 18 }),
      box([label('EXPLORE', c.ink), box([
        button('Component catalogue', '/catalog', true), button('Quality & process', '/quality', true), button('Project studies', '/projects', true), button('About the concept', '/about', true), button('Enquiry guide', '/faq', true), button('Contact', '/contact', true),
      ], { columns: 2, gap: 10 }), rule(), text('All product concepts, project studies and imagery are demonstrations. They do not represent a real factory, customer relationship, certification or production commitment.', c.muted, 12)], { gap: 22 }),
    ], { columns: 2, background: c.pale, padding: 56, gap: 70, nodeLabel: '统一页脚与演示说明' })], false) },
    { id: 'starter-card', name: '产品列表卡片 · 可自由拖拽', updated: date, data: data('Component card', [box([
      boundImage(productBinding('builtin:image'), productBinding('builtin:name'), 270),
      box([label('COMPONENT STUDY'), boundHeading(productBinding('builtin:name'), 'Component concept', 26, 'h3'), boundText(productBinding('builtin:category'), 'Component family', c.muted, 13), dynamicLink(productBinding('builtin:url'), 'Explore component →')], { gap: 15, padding: 24, inset: 24 }),
    ], { gap: 0, background: c.white, design: { desktop: { borderWidth: 1, borderColor: c.line, height: '100%' } } })], false) },
    { id: 'starter-case-card', name: '案例列表卡片 · 可自由拖拽', updated: date, data: data('Project study card', [box([
      boundImage(caseBinding('field:starter-case-image'), caseBinding('builtin:title'), 260),
      box([boundText(caseBinding('field:starter-case-category'), 'Engineering concept', c.copper, 12), boundHeading(caseBinding('builtin:title'), 'Project concept', 26, 'h3'), boundText(caseBinding('field:starter-case-summary'), 'A conceptual project study.', c.muted, 15), dynamicLink(caseBinding('builtin:url'), 'Read the study →')], { gap: 18, padding: 24, inset: 0 }),
    ], { gap: 0 })], false) },
  ];
  const pages = [page('starter-home', 'Home', '/'), page('starter-about', 'About', '/about'), page('starter-contact', 'Contact', '/contact'), page('starter-list', 'Component catalogue', '/catalog'), page('starter-detail', 'Component details', '/products/:slug'), page('starter-capabilities', 'Capabilities', '/capabilities'), page('starter-quality', 'Quality & process', '/quality'), page('starter-projects', 'Project studies', '/projects'), page('starter-project-detail', 'Project study', '/projects/:slug', projectModel.id), page('starter-faq', 'Enquiry guide', '/faq')];
  const editorData: SiteSnapshot['editorData'] = {
    'starter-home': data('Atlas Works — manufacturing showcase', [
      section([
        box([label('ATLAS WORKS / MANUFACTURING DEMONSTRATION'), heading('Precision, made practical.', 84, { level: 'h1', maxWidth: 650 }), text('Components are only the beginning. Bring drawings, materials and project requirements into one clear conversation.', c.muted, 19, 540), box([button('Explore the components', '/catalog'), button('How the process works', '/quality', true)], { columns: 2, gap: 12, design: { desktop: { maxWidth: 540 }, mobile: { columns: 1 } } }), label('FICTIONAL BRAND · CONCEPT PRODUCTS', c.muted)], { gap: 28, design: { desktop: { paddingTop: 20, paddingBottom: 20 } } }),
        box([image(factory, 'Generated industrial interior for the fictional Atlas Works website', 560, 'center'), box([label('THE INDUSTRIAL PERSPECTIVE', c.ink), text('From the drawing board to the wider assembly.', c.muted, 13)], { padding: 18, inset: 20, background: c.pale, gap: 6 })], { gap: 0 }),
      ], { columns: 2, gap: 56, padding: 54, design: { alignItems: 'center' }, nodeLabel: '首页首屏 · 工业编辑风' }),
      section([box([label('01 / A WELL-DEFINED COMPONENT'), heading('Good work starts with the right questions.', 42), text('What needs to fit? Which surfaces matter? What information makes approval easier? A useful manufacturing website gives those questions a place to begin.', c.muted, 17)], { gap: 22 }), box([
        box([label('DRAWING'), heading('Intent, made visible.', 24), text('Geometry, interfaces and revision references in one place.', c.muted, 14)], { gap: 15 }),
        box([label('MATERIAL'), heading('Context before selection.', 24), text('Connect material and finish choices to the application.', c.muted, 14)], { gap: 15 }),
        box([label('DIALOGUE'), heading('An informed next step.', 24), text('Bring technical questions into a structured enquiry.', c.muted, 14)], { gap: 15 }),
      ], { columns: 3, gap: 30 })], { background: c.white, columns: 2, gap: 70, nodeLabel: '品牌工作理念' }),
      section([box([label('02 / COMPONENT LIBRARY'), heading('A family of possibilities.', 48), text('Six illustrative component studies, each with editable parameters and a dedicated product page.'), button('View the complete catalogue', '/catalog', true)], { gap: 22 }), productLoop(3)], { gap: 40, nodeLabel: '首页动态产品列表' }),
      section([image(components, 'Generated metal component concepts, not actual manufactured products', 490), box([label('03 / THE DETAILS MATTER'), heading('A better brief goes beyond the outline.', 45), reviewTabs(), button('Explore the capability framework', '/capabilities', true)], { gap: 28 })], { columns: 2, gap: 64, background: c.white, nodeLabel: '技术标签页 · 自由编辑面板' }),
      section([label('04 / ENGINEERING THINKING'), heading('Studies in making things clearer.', 48), text('Fictional project studies show how applications, decisions and supporting information can become useful case articles.'), projectLoop()], { gap: 32, nodeLabel: '首页动态案例列表' }),
      cta(),
    ]),
    'starter-list': data('Component catalogue', [
      intro('COMPONENT LIBRARY / CONCEPT CATALOGUE', 'Details worth a closer look.', 'Browse component concepts by family. Each study connects an application, a material direction and the questions needed for a useful technical review.'),
      section([productLoop(6, true), box([label('CATALOGUE NOTE'), text('Concept dimensions, materials and finishes are illustrative. Confirm all technical and commercial requirements against an approved drawing before placing an order.', c.muted, 13)], { padding: 24, inset: 24, background: c.pale, gap: 10 })], { padding: 32, gap: 40 }),
      cta('A different part in mind?'),
    ]),
    'starter-detail': data('Component detail template', [
      section([label('COMPONENT STUDY / DEMONSTRATION'), button('← Back to the catalogue', '/catalog', true)], { padding: 26, gap: 16 }),
      section([
        box([boundImage(productBinding('builtin:image'), productBinding('builtin:name'), 520), label('GENERATED CONCEPT IMAGERY', c.muted)], { gap: 14 }),
        box([boundText(productBinding('builtin:category'), 'Component family', c.copper, 12), boundHeading(productBinding('builtin:name'), 'Component study', 58, 'h1'), boundText(productBinding('builtin:description'), 'An illustrative component concept.'), rule(), box([
          box([label('REFERENCE', c.muted), boundText(productBinding('builtin:sku'), 'Study reference', c.ink, 14)], { gap: 8 }),
          box([label('MATERIAL DIRECTION', c.muted), boundText(productBinding('builtin:material'), 'To be reviewed', c.ink, 14)], { gap: 8 }),
          box([label('PROCESS CONCEPT', c.muted), boundText(productBinding('field:starter-process'), 'To be reviewed', c.ink, 14)], { gap: 8 }),
          box([label('FINISH CONCEPT', c.muted), boundText(productBinding('field:starter-finish'), 'To be reviewed', c.ink, 14)], { gap: 8 }),
        ], { columns: 2, gap: 22 }), button('Discuss this component', '/contact'), text('A fictional product study. This page is not a specification, quotation or statement of production capability.', c.muted, 12)], { gap: 25 }),
      ], { columns: 2, gap: 64, background: c.white, padding: 56, nodeLabel: '产品动态字段与参数' }),
      section([box([label('APPLICATION'), heading('Understand the wider assembly.', 36), boundText(productBinding('field:starter-application'), 'Discuss the intended application.')], { gap: 20 }), box([label('DRAWINGS & TECHNICAL INFORMATION'), heading('Request the information your review needs.', 30), boundText(productBinding('field:starter-drawing'), 'Include a current drawing and your requirements.'), button('Request a technical review', '/contact', true)], { gap: 20 })], { columns: 2, gap: 70 }),
      section([label('BEFORE AN ENQUIRY'), heading('Useful answers, in one place.', 40), faq(3)], { background: c.white, padding: 64 }),
      section([label('EXPLORE THE FAMILY'), heading('More component studies.', 40), productLoop(3)], { padding: 72, gap: 32 }),
    ]),
    'starter-about': data('About Atlas Works', [
      intro('ABOUT / ATLAS WORKS', 'An industrial story, clearly told.', 'A considered manufacturing presentation connects the company, its people and the way information moves through a project.'),
      section([image(factory, 'Generated manufacturing environment used as demonstration imagery', 550), box([label('THE COMPANY PERSPECTIVE'), heading('Start with the work. Explain the thinking.', 46), text('The Atlas Works concept is built around a simple idea: clarity is part of a useful product. A drawing tells one part of the story; material choices, application context and approval decisions complete it.'), text('This fictional company website demonstrates how an independent manufacturer can organise that story without hiding the details behind a generic sales page.'), button('See the capability framework', '/capabilities', true)], { gap: 26 })], { columns: 2, gap: 64, background: c.white, padding: 64 }),
      section([label('PRINCIPLES'), heading('A more considered conversation.', 46), box([
        box([label('01'), heading('Be specific.', 28), text('Give product families, applications and technical references a clear home.')], { gap: 20 }),
        box([label('02'), heading('Make evidence visible.', 28), text('Use authorised facility photography, verified documents and information with a defined scope.')], { gap: 20 }),
        box([label('03'), heading('Keep the next step simple.', 28), text('Help a visitor move from a product idea to a well-prepared enquiry.')], { gap: 20 }),
      ], { columns: 3, gap: 50 })], { gap: 36 }),
      section([label('A NOTE ON THIS DEMONSTRATION'), heading('A fictional brand. A working website.', 36), text('Atlas Works, its product studies and project articles are created to demonstrate the website. Generated images are conceptual, and no production facilities, certification, customer relationships or completed commercial projects are claimed.'), text('A real deployment should introduce the company’s authorised team, address, facilities and evidence only after those details have been verified.')], { background: c.pale, padding: 58, gap: 22 }),
      cta(),
    ]),
    'starter-capabilities': data('Capabilities', [
      intro('CAPABILITY FRAMEWORK', 'The right detail changes the conversation.', 'A useful capability page explains how to discuss a part, which questions need review and what information belongs alongside the drawing.'),
      section([image(components, 'Generated component arrangement illustrating material and process discussions', 430), box([label('FROM APPLICATION TO COMPONENT'), heading('Look at the part in context.', 44), text('Consider mating components, the installation environment, assembly access and visible surfaces. These details help separate fixed requirements from decisions that are still open.'), reviewTabs()], { gap: 26 })], { columns: 2, gap: 64, padding: 64, background: c.white }),
      section([label('PROCESS STUDIES'), heading('Different forms. Different questions.', 46), box([
        box([label('MACHINED COMPONENTS'), heading('Faces, pockets and interfaces.', 28), text('A place to discuss datums, tool access, mating features and the distinction between cosmetic and functional surfaces.'), button('View component studies', '/catalog', true)], { gap: 22, padding: 28, inset: 28, background: c.white, design: { desktop: { borderWidth: 1, borderColor: c.line } } }),
        box([label('TURNED COMPONENTS'), heading('A considered rotational form.', 28), text('A place to organise stepped geometry, connection details, fits and finish references in a readable product brief.'), button('View component studies', '/catalog', true)], { gap: 22, padding: 28, inset: 28, background: c.white, design: { desktop: { borderWidth: 1, borderColor: c.line } } }),
        box([label('FABRICATED COMPONENTS'), heading('Think through the assembly.', 28), text('A place to connect bends, fixing points, panel access and appearance with the complete installation.'), button('View component studies', '/catalog', true)], { gap: 22, padding: 28, inset: 28, background: c.white, design: { desktop: { borderWidth: 1, borderColor: c.line } } }),
      ], { columns: 3, gap: 24 })], { gap: 36 }),
      section([label('PROJECT WORKFLOW / ILLUSTRATIVE'), heading('A clear route from question to handover.', 44), stages()], { background: c.pale, padding: 64, gap: 36 }),
      section([label('CONCEPT IMAGE LIBRARY'), heading('The broader industrial picture.', 40), node('Gallery', { images: [
        { id: 'factory-concept', src: factory, alt: 'Generated manufacturing interior for the fictional Atlas Works concept', caption: 'Facility concept · generated demonstration imagery, not a real factory.' },
        { id: 'component-concept', src: components, alt: 'Generated machined-component concepts', caption: 'Component concepts · generated demonstration imagery, not manufactured samples.' },
      ], ratio: '4/3', fit: 'cover', lightbox: true })], { background: c.white, padding: 64, gap: 28, nodeLabel: '概念图库与大图预览' }),
      cta('Have a drawing to discuss?'),
    ]),
    'starter-quality': data('Quality and process', [
      intro('QUALITY & PROCESS / REVIEW FRAMEWORK', 'Make the important details traceable.', 'Quality information is useful when its scope is clear: the drawing revision, the feature under review, the method used and the record that supports the decision.'),
      section([box([label('A DOCUMENTED CONVERSATION'), heading('Clarity before a commitment.', 45), text('The example workflow below shows the information a manufacturing website can help organise. Actual review, sample, inspection and delivery arrangements must be confirmed for each project.'), button('Prepare your enquiry', '/contact')], { gap: 25 }), image(factory, 'Generated factory scene, presented as fictional demonstration imagery', 430)], { columns: 2, gap: 70, background: c.white, padding: 64 }),
      section([label('EXAMPLE PROJECT WORKFLOW'), heading('Know what has been agreed.', 46), stages()], { gap: 36 }),
      section([box([label('TECHNICAL INFORMATION'), heading('A useful review pack.', 40), text('Request the documents your application needs. A download should describe what it covers, which revision it relates to and who has reviewed it.'), button('Request product information', '/contact', true)], { gap: 24 }), box([
        box([label('DRAWING REGISTER'), text('Part reference · revision · open questions · approval record', c.ink, 16)], { gap: 10 }), rule(),
        box([label('MATERIAL & FINISH'), text('Agreed requirement · reference information · relevant limitations', c.ink, 16)], { gap: 10 }), rule(),
        box([label('INSPECTION & HANDOVER'), text('Features to review · agreed records · packaging and identification notes', c.ink, 16)], { gap: 10 }),
      ], { background: c.pale, padding: 34, inset: 34, gap: 22 })], { columns: 2, gap: 70, background: c.white, padding: 64 }),
      section([label('TRANSPARENCY'), heading('Evidence should say exactly what it supports.', 36), text('This demo intentionally includes no certification badges or downloadable technical claims. Add current, authorised documents to the media library and connect them to the relevant products when they are available.')], { background: c.pale, padding: 56, gap: 24 }),
      cta(),
    ]),
    'starter-projects': data('Project studies', [
      intro('PROJECT NOTEBOOK / FICTIONAL STUDIES', 'The thinking behind the component.', 'Conceptual studies explore how a clearer brief connects the application, the drawing and the decisions that follow. These are fictional examples, not client case histories.'),
      section([projectLoop()], { padding: 32 }),
      section([box([label('A CASE ARTICLE CAN DO MORE'), heading('Explain decisions, not just the finished part.', 42), text('Describe the context, surface the questions and show which information made the next decision possible. A useful project story gives the reader something concrete to discuss.')], { gap: 24 }), image(components, 'Generated component concepts for the Atlas Works project notebook', 360)], { columns: 2, gap: 70, background: c.white, padding: 64 }),
      cta('What is your next design question?'),
    ]),
    'starter-project-detail': data('Project study detail template', [
      section([button('← Back to the project notebook', '/projects', true), boundText(caseBinding('field:starter-case-category'), 'Engineering concept', c.copper, 12), boundHeading(caseBinding('builtin:title'), 'Project study', 66, 'h1'), boundText(caseBinding('field:starter-case-summary'), 'A fictional engineering study.', c.muted, 19), label('FICTIONAL STUDY / NO CLIENT CLAIM', c.muted)], { padding: 70, gap: 24, nodeLabel: '案例动态标题与摘要' }),
      section([boundImage(caseBinding('field:starter-case-image'), caseBinding('builtin:title'), 560)], { padding: 0, mobile: { paddingTop: 0, paddingBottom: 0 } }),
      section([
        box([label('01 / THE QUESTION'), heading('Understand the context.', 34)], { gap: 18 }),
        box([boundText(caseBinding('field:starter-case-challenge'), 'Describe the design question.'), rule(), label('02 / THE APPROACH'), heading('Make the decisions readable.', 32), boundText(caseBinding('field:starter-case-approach'), 'Describe the approach.'), rule(), label('03 / THE INFORMATION'), heading('Prepare the next conversation.', 32), boundText(caseBinding('field:starter-case-deliverables'), 'Describe the supporting information.')], { gap: 28 }),
      ], { columns: 2, gap: 90, background: c.white, padding: 80, nodeLabel: '案例正文 · 动态内容模型字段' }),
      section([label('MORE FROM THE NOTEBOOK'), heading('Another perspective.', 40), projectLoop()], { padding: 72, gap: 32 }),
      cta(),
    ]),
    'starter-faq': data('Enquiry guide', [
      intro('ENQUIRY GUIDE', 'A useful starting point.', 'A little context makes a technical enquiry easier to understand. Gather what you know, highlight what is uncertain and include the questions that matter to your project.'),
      section([box([label('BEFORE YOU SEND'), heading('Bring the essentials together.', 36), text('Drawing or sketch. Application. Approximate quantity. Material or finish references. Destination. A note about the decision you need to make next.'), button('Start an enquiry', '/contact')], { gap: 24 }), faq()], { columns: 2, gap: 70, background: c.white, padding: 64, nodeLabel: '自由拖拽常见问题' }),
      section([label('CONFIDENTIAL INFORMATION'), heading('Share a clear brief before sharing sensitive files.', 34), text('This demonstration form accepts text only. For an actual project, first agree how confidential drawings and supporting files should be exchanged. Add the organisation’s own contact and privacy information before public use.')], { background: c.pale, padding: 56, gap: 24 }),
    ]),
    'starter-contact': data('Contact Atlas Works', [
      intro('START A PROJECT CONVERSATION', 'Good questions lead somewhere.', 'Tell us about the application, the component and the information you already have. Use the enquiry to make the next discussion more specific.'),
      section([box([label('PROJECT ENQUIRY'), heading('Make the brief your own.', 36), text('You can begin with a drawing reference, an application or a part in the catalogue. Include approximate quantities and any requirements that need further review.'), rule(), label('HELPFUL TO INCLUDE', c.ink), text('Application and assembly context\nDrawing reference and revision\nMaterial and finish direction\nQuantity and destination\nQuestions that need a decision', c.muted, 15), button('Read the enquiry guide', '/faq', true), text('This is a working website demonstration. Public preview submissions are disabled; an installed site can store enquiries after configuration. No real Atlas Works contact address is implied.', c.muted, 12)], { gap: 24 }), box([inquiry(), text('Do not include sensitive or confidential information in this demonstration. Configure the organisation’s privacy wording and notification settings before real use.', c.muted, 12)], { gap: 22, padding: 32, inset: 32, background: c.paper, design: { desktop: { borderWidth: 1, borderColor: c.line }, mobile: { paddingLeft: 20, paddingRight: 20, paddingTop: 24, paddingBottom: 24 } } })], { columns: 2, gap: 70, background: c.white, padding: 64, nodeLabel: '网站询盘表单' }),
      section([label('THE PROJECT NOTEBOOK'), heading('Still shaping the brief?', 38), text('Explore a component study or an example project to see how the information can be organised.'), box([button('Browse component studies', '/catalog', true), button('Read project studies', '/projects', true)], { columns: 2, gap: 16, design: { desktop: { maxWidth: 550 } } })], { padding: 58, gap: 24 }),
    ]),
  };
  const theme: SiteTheme = { primary: c.copper, background: c.paper, text: c.ink, radius: 0, font: 'Arial', headingFont: 'Arial' };
  return {
    schemaVersion: protocol.snapshot, pages, editorData, products,
    // 分发依赖必须登记在素材清单中，导入时统一映射为目标实例的私有媒体。
    media: [
      { id: 'starter-factory-image', name: 'showcase-factory.png', url: factory, kind: 'image', folder: 'Atlas Works concept', size: '', alt: 'AI-generated fictional precision manufacturing facility' },
      { id: 'starter-components-image', name: 'showcase-components.png', url: components, kind: 'image', folder: 'Atlas Works concept', size: '', alt: 'AI-generated generic machined component concept' },
    ], theme,
    settings: { name: 'Atlas Works', description: 'Atlas Works is a fictional manufacturing website demonstration with editable component studies, engineering articles and a structured enquiry flow.', email: '', language: 'en' },
    sharedBlocks, contentModels: [productModel, projectModel], contentEntries: projects, forms: [form], pageTemplates: [],
    taxonomies: [{ id: 'starter-product-families', name: '产品分类', source: 'product', modelId: productModel.id, terms: [
      { id: 'starter-family-machined', label: 'Machined components', slug: 'machined' }, { id: 'starter-family-turned', label: 'Turned components', slug: 'turned' }, { id: 'starter-family-structural', label: 'Structural components', slug: 'structural' },
    ] }], redirects: [], customCode: { global: { css: '', js: '', cssEnabled: false, jsEnabled: false }, pages: {} },
    siteLayout: { header: { mode: 'block', blockId: 'starter-header', menuId: 'starter-menu' }, footer: { mode: 'block', blockId: 'starter-footer', menuId: 'starter-footer-menu' }, menus: [
      { id: 'starter-menu', name: '主导航', items: [
        { id: 'starter-menu-home', label: 'Home', target: { kind: 'page', id: 'starter-home' } },
        { id: 'starter-menu-products', label: 'Components', target: { kind: 'page', id: 'starter-list' } },
        { id: 'starter-menu-capabilities', label: 'Capabilities', target: { kind: 'page', id: 'starter-capabilities' } },
        { id: 'starter-menu-projects', label: 'Projects', target: { kind: 'page', id: 'starter-projects' } },
        { id: 'starter-menu-about', label: 'About', target: { kind: 'page', id: 'starter-about' } },
        { id: 'starter-menu-contact', label: 'Contact', target: { kind: 'page', id: 'starter-contact' } },
      ] },
      { id: 'starter-footer-menu', name: '页脚导航', items: [
        { id: 'starter-footer-catalog', label: 'Component catalogue', target: { kind: 'page', id: 'starter-list' } },
        { id: 'starter-footer-process', label: 'Quality & process', target: { kind: 'page', id: 'starter-quality' } },
        { id: 'starter-footer-projects', label: 'Project studies', target: { kind: 'page', id: 'starter-projects' } },
        { id: 'starter-footer-about', label: 'About the concept', target: { kind: 'page', id: 'starter-about' } },
        { id: 'starter-footer-faq', label: 'Enquiry guide', target: { kind: 'page', id: 'starter-faq' } },
        { id: 'starter-footer-contact', label: 'Contact', target: { kind: 'page', id: 'starter-contact' } },
      ] },
    ] },
  };
}
