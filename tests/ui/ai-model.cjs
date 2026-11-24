// 仅由隔离UI包装器启动的确定模型；不读取真实模型配置，也不向任何服务发送请求。
const { createServer } = require('node:http');
const { once } = require('node:events');

async function startUiAiModel() {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; if (raw.length > 8 * 1024 * 1024) request.destroy(); });
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer ui-design-synthetic') { response.writeHead(403); response.end('{"error":"Synthetic model request not allowed"}'); return; }
      try {
        const body = JSON.parse(raw), userContent = body.messages.at(-1).content;
        const prompt = JSON.parse(typeof userContent === 'string' ? userContent : userContent.find(part => part.type === 'text')?.text), instruction = prompt.instruction;
        // 精确公司标记仅供隔离服务站闭环；固定回复验证原生预览/确认/撤销，不是真实AI设计质量样本。
        if (prompt.brief?.companyName === 'UI_AI_INDUSTRY_SERVICES') {
          const services = [{ title: 'Market exploration', body: 'Organise supplied questions into a discussion brief.' }, { title: 'Offer clarity', body: 'Clarify the supplied offer and buyer questions.' }, { title: 'Workflow review', body: 'Map supplied enquiry handoffs for internal review.' }];
          const hero = (heading) => ({ kind: 'hero', heading, body: 'Fictional service demonstration. Supplied scope only; no results or credentials are claimed.', ...(prompt.images?.[0] ? { mediaId: prompt.images[0].id } : {}), cta: { label: 'Discuss your brief', pageKey: 'contact' } });
          const page = (key, title, path, sections) => ({ key, title, path, purpose: `${title} for the supplied professional-service buyer task`, seoTitle: `${title} | Fictional advisory service`, seoDescription: `Read the supplied ${title.toLowerCase()} information for this fictional advisory service demonstration.`, sections });
          const value = {
            summary: '以服务范围、工作方法与沟通为主的虚构零产品站点。',
            intent: { siteType: 'professional-services', primaryGoal: '让潜在客户明确服务范围并发起需求沟通', audienceTasks: ['了解三项服务', '核对工作方法', '找到沟通入口'], constraints: ['不创建商品目录', '不编造客户、资质和商业结果'], missingFacts: ['真实联系资料与团队信息待补'] },
            pages: [
              page('home', 'Home', '/', [hero('Clarity before your next move.'), { kind: 'features', heading: 'Three useful starting points.', body: 'Illustrative services, not products.', items: services }]),
              page('services', 'Services', '/services', [hero('Services with a clear scope.'), { kind: 'features', heading: 'Find the scope for your question.', body: 'Each engagement starts with supplied information.', items: services }]),
              page('approach', 'Our approach', '/approach', [hero('A practical way to begin.'), { kind: 'features', heading: 'Four steps for a clearer brief.', body: 'An illustrative working approach.', items: [{ title: 'Clarify', body: 'Agree the question.' }, { title: 'Review', body: 'Review supplied information.' }, { title: 'Organise', body: 'Organise the options.' }, { title: 'Discuss', body: 'Discuss the next step.' }] }]),
              page('contact', 'Contact', '/contact', [hero('Discuss your brief.'), { kind: 'contact', heading: 'Start with your question.', body: 'Fictional demonstration. Contact details and fees require confirmation.' }]),
            ],
            directions: [
              { id: 'service-split', name: '服务导读', rationale: '以交错图文引导客户理解服务范围。', layout: 'split' },
              { id: 'service-bento', name: '服务模块', rationale: '以不同宽度的原生服务卡组织信息。', layout: 'bento' },
              { id: 'service-minimal', name: '编号方法', rationale: '以大标题和编号信息行呈现工作方式。', layout: 'minimal' },
            ].map(direction => ({ ...direction, primary: '#234256', background: '#f7f8fa', text: '#172a36', headingFont: 'sans' })),
          };
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })); return;
        }
        // 正文优化只引用明确发送的真实行与link key；合成内容只验证组合预览/采用/撤销。
        if (String(body.messages[0]?.content).includes('SEO_CONTENT_OPTIMIZATION') && String(instruction).startsWith('UI_AI_SEO_CONTENT')) {
          const report=prompt.reports?.[0], row=report?.rows?.[0], link=prompt.linkTargets?.[0];
          const value={summary:'UI supplied data content improvement',body:[{kind:'heading',text:'Choosing a supplied steel sample'},{kind:'paragraph',text:'Review the supplied sample information with your project requirements before requesting details.'}],faq:[{question:'How can I discuss the supplied sample?',answer:'Contact the company with your project requirements and confirm available information.'}],links:link?[{key:link.key,label:link.label}]:[],metadata:{seoTitle:'Supplied steel sample information',seoDescription:'Read supplied information and discuss project requirements with the company.'},evidence:report&&row?[{reportId:report.id,rowNumbers:[row.rowNumber]}]:[],warnings:[],missingFacts:[]};
          response.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]}));return;
        }
        // 翻译只替换受保护槽位文本，保留系统注入的品牌/数字/图片链接锚点；不是实际语言质量样本。
        if (String(body.messages[0]?.content).includes('Translate only supplied text slots') && Array.isArray(prompt.slots)) {
          response.end(JSON.stringify({ ...(String(instruction).includes('UI_AI_BATCH_FLOW')?{usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}:{}), choices: [{ message: { content: JSON.stringify({ translations: prompt.slots.map(slot => ({ id: slot.id, text: `${String(prompt.targetLanguage || 'de').toUpperCase()} ${slot.text}` })) }) }, finish_reason: 'stop' }] })); return;
        }
        // 批次首条/后续都走原生编译器；真实usage计数仅来自这个合成HTTP提供方。
        if (String(body.messages[0]?.content).includes('AI_CONTENT_WRITING') && String(instruction).includes('UI_AI_BATCH_FLOW')) {
          const fields=prompt.fields.map(field=>{const current=field.current??field.before, after=field.kind==='richtext'?(current&&typeof current==='object'?structuredClone(current):{type:'doc',content:[]}):`UI batch generated ${field.key}`;if(field.kind==='richtext'){after.content||=[];after.content.push({type:'paragraph',content:[{type:'text',text:'UI batch generated editable detail'}]});}return{key:field.key,after};});
          const send=()=>response.end(JSON.stringify({usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20},choices:[{message:{content:JSON.stringify({fields,warnings:[],missingFacts:[],evidenceIds:[]})},finish_reason:'stop'}]}));if(String(instruction).includes('UI_AI_BATCH_FLOW_PAUSE'))setTimeout(send,1200);else send();return;
        }
        // 长详情沿原生RichNode保留全部既有图片/链接；确定文案只用于测试预览、采用和撤销。
        if (String(body.messages[0]?.content).includes('AI_CONTENT_WRITING') && instruction === 'UI_AI_PRODUCT_DETAIL' && prompt.fields?.length === 1 && prompt.fields[0].key === 'detailContent') {
          const field = prompt.fields[0], after = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'UI generated product details' }] }, ...(field.current?.content || []), { type: 'paragraph', content: [{ type: 'text', text: 'Synthetic long detail generated from supplied data.' }] }] };
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ fields: [{ key: 'detailContent', after }], warnings: [], missingFacts: [], evidenceIds: [] }) }, finish_reason: 'stop' }] })); return;
        }
        // 视觉分支必须真正收到图片输入；文本说明不能冒充已看过截图。
        if (Array.isArray(userContent) && Array.isArray(prompt.screenshots) && instruction === 'UI_AI_VISUAL_FLOW') {
          const images = userContent.filter(part => part.type === 'image_url');
          if (!images.length || images.length !== prompt.screenshots.length || images.some(part => !/^data:image\/jpeg;base64,/.test(part.image_url?.url || ''))) throw Error('Synthetic visual images missing');
          const device = prompt.screenshots[0].device;
          const node = prompt.nativeNodes?.find(item => item.id === 'ui-visual-heading') || prompt.nativeNodes?.[0];
          const value = { summary: 'UI视觉检查：当前首屏层级可以继续改善，请人工核对截图。', issues: [{ device, severity: 'suggestion', title: 'UI视觉：标题层级需要核对', description: '这是基于真实首屏截图的合成建议，仅用于验证软件流程。', ...(node ? { nodeId: node.id } : {}), suggestion: '保留现有内容，核对标题和按钮的层级与间距。' }], suggestedInstruction: 'UI_AI_VISUAL_ADJUST：请保留现有内容，根据视觉建议核对手机标题的层级与间距。', warnings: ['合成模型不代表实际视觉质量评审通过。'] };
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })); return;
        }
        if (typeof instruction === 'string' && instruction.includes('UI_AI_VISUAL_ADJUST')) {
          const home = prompt.pages?.find(page => page.nodes?.some(node => node.id === 'ui-visual-heading')); if (!home) throw Error('Synthetic visual adjustment context missing');
          const value = { summary: 'UI visual feedback refined into editable native layout', intent: { goal: '按照视觉反馈微调手机标题', decisions: ['保留业务内容，仅修改已有节点的手机字号'], preserve: ['已有文字、图片与原生编辑能力'], assumptions: ['合成模型只验证流程'] }, operations: [{ kind: 'page', pageId: home.pageId, operations: [{ kind: 'design', id: 'ui-visual-heading', design: { mobile: { fontSize: 27 } } }] }], warnings: [] };
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })); return;
        }
        if (typeof instruction !== 'string' || !/UI_AI_DESIGN_FLOW|UI_AI_CONTINUE|UI_AI_SITE_DESIGN_FLOW|UI_AI_SITE_CONTINUE|UI_AI_DETAIL_FLOW|UI_AI_DETAIL_CONTINUE/.test(instruction)) throw Error('Unexpected synthetic instruction');
        if (/UI_AI_DETAIL_FLOW|UI_AI_DETAIL_CONTINUE/.test(instruction)) {
          // 模型仅提供确定回答；详情选择、真实样本、动态绑定和冻结预览仍走完整业务服务。
          const frame = prompt.nodes?.find(node => node.type === 'Container');
          if (prompt.template?.id !== 'ui-native-detail-template' || !frame || !prompt.sample?.id) throw Error('Synthetic detail context missing');
          const continuing = instruction.includes('UI_AI_DETAIL_CONTINUE');
          const value = {
            summary: continuing ? '保留产品详情动态内容，进一步收紧手机首屏间距。' : '重新整理产品详情的三端留白，继续使用真实动态产品资料。',
            intent: { goal: '让普通用户通过描述完成可继续拖拽的详情设计', decisions: ['电脑与手机分别调整原生容器', '保留产品资料和当前记录绑定'], preserve: ['真实产品内容、详情地址和模板规则'], assumptions: ['仅使用本机合成模型验证交互，设计效果由用户核对'] },
            operations: [{ kind: 'design', id: frame.id, design: continuing ? { mobile: { paddingTop: 12, paddingBottom: 12, gap: 16 } } : { desktop: { paddingTop: 54, paddingBottom: 54 }, tablet: { paddingTop: 32 }, mobile: { paddingTop: 20, paddingBottom: 20 } } }], warnings: [],
          };
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })); return;
        }
        if (/UI_AI_SITE_DESIGN_FLOW|UI_AI_SITE_CONTINUE/.test(instruction)) {
          // 整站用例仍通过真正的业务编译器、冻结预览和确认事务，只把模型回答固定为可重复样本。
          const home = prompt.pages.find(page => page.nodes?.some(node => node.id === 'ui-site-home-heading'));
          const about = prompt.pages.find(page => page.pageId === 'ui-site-about');
          const header = prompt.chrome.header.nodes.find(node => node.type === 'Container');
          const footer = prompt.chrome.footer.nodes.find(node => node.type === 'Container');
          if (!home || !about || !header || !footer) throw Error('Synthetic site context missing');
          const continuing = instruction.includes('UI_AI_SITE_CONTINUE');
          const value = {
            summary: continuing ? '保留整站方向，收紧手机页脚，并让独立页面跟随新页眉。' : '统一页眉页脚、导航与跨页品牌排版。',
            intent: { goal: '让海外采购在同一风格的网站中了解企业并找到页面', decisions: ['用原生区块设计统一头尾', '整理真实页面导航并调整首页与关于页的层级'], preserve: ['真实企业资料、既有产品与页面路径'], assumptions: ['本机合成模型只验证软件流程，实际设计需要用户核对'] },
            operations: continuing ? [
              { kind: 'chrome', slot: 'footer', operations: [{ kind: 'design', id: footer.id, design: { mobile: { paddingTop: 24, paddingBottom: 24 } } }] },
              { kind: 'pageChrome', pageId: 'ui-site-standalone', header: 'inherit' },
            ] : [
              { kind: 'theme', theme: { primary: '#2456a6', font: 'system', headingFont: 'system', radius: 8, defaults: { desktop: { lineHeight: 1.65 }, mobile: { fontSize: 16 } } } },
              { kind: 'chrome', slot: 'header', operations: [{ kind: 'design', id: header.id, design: { desktop: { paddingTop: 24, paddingBottom: 24, gap: 32 }, mobile: { gap: 12 } } }] },
              { kind: 'chrome', slot: 'footer', operations: [{ kind: 'design', id: footer.id, design: { desktop: { paddingTop: 48, paddingBottom: 48 }, mobile: { paddingTop: 32, paddingBottom: 32 } } }] },
              { kind: 'navigation', slot: 'header', items: [{ label: 'Company', pageId: home.pageId }, { label: 'About our factory', pageId: about.pageId }] },
              { kind: 'page', pageId: home.pageId, operations: [{ kind: 'design', id: 'ui-site-home-heading', design: { desktop: { fontSize: 36 }, mobile: { fontSize: 28 } } }] },
              { kind: 'page', pageId: about.pageId, operations: [{ kind: 'design', id: 'ui-site-about-heading', design: { desktop: { fontSize: 32 }, mobile: { fontSize: 26 } } }] },
            ], warnings: [],
          };
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })); return;
        }
        const continuing = instruction.includes('UI_AI_CONTINUE');
        const value = {
          summary: continuing ? '保留首页与产品卡片，进一步收紧手机端间距。' : '调整首页的层级与留白，并设计可自由拖拽的动态产品卡片。',
          intent: { goal: '帮助海外买家了解企业并浏览真实产品', decisions: ['首页采用清晰的信息层级', '产品使用动态字段卡片，手机保持单列'], preserve: ['真实产品信息与图片'], assumptions: ['本次仅使用合成资料验证流程，设计质量由真实用户复核'] },
          operations: continuing ? [{ kind: 'design', id: 'ui-ai-hero', design: { mobile: { paddingTop: 18, paddingBottom: 18, gap: 16 } } }] : [
            { kind: 'design', id: 'ui-ai-hero', design: { desktop: { paddingTop: 64, paddingBottom: 64, gap: 32 }, mobile: { paddingTop: 24, paddingBottom: 24, gap: 20 } } },
            { kind: 'productCard', id: 'ui-ai-loop', operations: [
              { kind: 'design', id: 'card-ui-ai-loop-frame', design: { desktop: { paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, borderWidth: 1, borderColor: '#d9e2ef', borderStyle: 'solid', borderRadius: 8 }, mobile: { paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 } } },
              { kind: 'design', id: 'card-ui-ai-loop-title', design: { desktop: { fontSize: 24, lineHeight: 1.4 }, mobile: { fontSize: 20 } } },
            ] },
          ], warnings: [],
        };
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }));
      } catch { response.writeHead(422); response.end('{"error":"Synthetic model fixture mismatch"}'); }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
module.exports = { startUiAiModel };
