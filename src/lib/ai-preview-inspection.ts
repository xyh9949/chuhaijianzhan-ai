/** 只传布局计数和节点标识，不把页面正文、素材地址或浏览器凭据带回模型。 */
export const AI_PREVIEW_ISSUE_CODES = ['horizontal-overflow', 'broken-image', 'pending-image', 'small-text', 'small-target', 'heading-count', 'inspection-limit'] as const;
// 同步区块实例会附加路径前缀；定位允许更长的渲染标识，报告给模型的原节点限制保持。
export const MAX_PREVIEW_LOCATE_ID = 512;
export type AiPreviewIssueCode = typeof AI_PREVIEW_ISSUE_CODES[number];
export interface AiPreviewIssue { code: AiPreviewIssueCode; count: number; nodeId?: string; }
export interface AiPreviewFeedback {
  viewport: 'desktop' | 'tablet' | 'mobile'; width: number;
  horizontalOverflow: boolean; brokenImages: number; pendingImages: number;
  smallText: number; smallTargets: number; headingCount: number;
  inspectedElements: number; truncated: boolean; issues: AiPreviewIssue[];
}
const fields = ['viewport', 'width', 'horizontalOverflow', 'brokenImages', 'pendingImages', 'smallText', 'smallTargets', 'headingCount', 'inspectedElements', 'truncated', 'issues'];

/** 浏览器回报是不可信测量；严格限制结构和体积，仅用于建议，不能作为应用授权。 */
export function normalizeAiPreviewFeedback(value: unknown): AiPreviewFeedback[] {
  const object = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw Error('页面检查结果格式无效');
    return input as Record<string, unknown>;
  };
  const count = (input: unknown, max = 10000): number => {
    if (!Number.isSafeInteger(input) || Number(input) < 0 || Number(input) > max) throw Error('页面检查计数无效');
    return Number(input);
  };
  if (!Array.isArray(value) || value.length > 3) throw Error('每次最多携带三个设备的页面检查');
  const seen = new Set<string>();
  return value.map(raw => {
    const report = object(raw), viewport = String(report.viewport);
    if (Object.keys(report).some(key => !fields.includes(key)) || !['desktop', 'tablet', 'mobile'].includes(viewport) || seen.has(viewport)) throw Error('页面检查设备或字段无效');
    seen.add(viewport);
    const width = count(report.width, 1920);
    if (width < 240 || typeof report.horizontalOverflow !== 'boolean' || typeof report.truncated !== 'boolean' || !Array.isArray(report.issues) || report.issues.length > 10) throw Error('页面检查范围无效');
    const issues = report.issues.map(rawIssue => {
      const issue = object(rawIssue);
      if (Object.keys(issue).some(key => !['code', 'count', 'nodeId'].includes(key)) || !AI_PREVIEW_ISSUE_CODES.includes(issue.code as AiPreviewIssueCode)) throw Error('页面检查项目无效');
      if (issue.nodeId !== undefined && (typeof issue.nodeId !== 'string' || !issue.nodeId.length || issue.nodeId.length > 100 || /[\u0000-\u001f<>]/.test(issue.nodeId))) throw Error('页面检查节点无效');
      return { code: issue.code as AiPreviewIssueCode, count: count(issue.count), ...(issue.nodeId ? { nodeId: issue.nodeId as string } : {}) };
    });
    return { viewport: viewport as AiPreviewFeedback['viewport'], width, horizontalOverflow: report.horizontalOverflow,
      brokenImages: count(report.brokenImages), pendingImages: count(report.pendingImages), smallText: count(report.smallText), smallTargets: count(report.smallTargets),
      headingCount: count(report.headingCount), inspectedElements: count(report.inspectedElements, 1500), truncated: report.truncated, issues };
  });
}

/** 在无同源权限的真实预览沙箱中运行；仅测量DOM，不执行客户代码或主动请求资源。 */
export const AI_PREVIEW_INSPECTION_SCRIPT = String.raw`
  let inspectionTimer;
  const inspectLayout = () => {
    clearTimeout(inspectionTimer);
    inspectionTimer = setTimeout(() => {
      const width = window.innerWidth, layoutWidth = document.documentElement.clientWidth;
      if (width < 240 || width > 1920) return;
      const viewport = width < 768 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop';
      const all = Array.from(root.querySelectorAll('.editor-design-node,p,h1,h2,h3,h4,h5,h6,a,button,label,img,input,select,textarea'));
      const elements = all.slice(0, 1500), issues = [];
      let brokenImages = 0, pendingImages = 0, smallText = 0, smallTargets = 0, headingCount = 0;
      const add = (code, element) => {
        const old = issues.find(issue => issue.code === code);
        if (old) { old.count++; return; }
        const nodeId = element && element.closest('.editor-design-node')?.getAttribute('data-site-node-id');
        issues.push({ code, count: 1, ...(nodeId && nodeId.length <= 100 ? { nodeId } : {}) });
      };
      for (const element of elements) {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
        if (element.tagName === 'IMG' && element.getAttribute('src')) {
          if (!element.complete) { pendingImages++; add('pending-image', element); }
          else if (!element.naturalWidth) { brokenImages++; add('broken-image', element); }
        }
        if (element.tagName === 'H1') headingCount++;
        if (element.matches('p,h1,h2,h3,h4,h5,h6,a,button,label') && element.textContent.trim() && parseFloat(style.fontSize) < 12) { smallText++; add('small-text', element); }
        if (viewport === 'mobile' && element.matches('button,input:not([type="hidden"]),select,textarea,nav a,.site-button') && (rect.width < 32 || rect.height < 32)) { smallTargets++; add('small-target', element); }
      }
      const horizontalOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > layoutWidth + 2;
      if (horizontalOverflow) add('horizontal-overflow', null);
      if (headingCount !== 1) add('heading-count', null);
      if (all.length > elements.length) add('inspection-limit', null);
      send({ type: 'layout-inspection', report: { viewport, width, horizontalOverflow, brokenImages, pendingImages, smallText, smallTargets, headingCount, inspectedElements: elements.length, truncated: all.length > elements.length, issues } });
    }, 160);
  };
  const locatedNodes = new WeakMap();
  window.addEventListener('message', event => {
    if (!(event.source === parent && event.origin === new URL(payload.baseUrl).origin && event.data?.source === 'form-studio-inspection')) return;
    if (event.data.type === 'inspect') inspectLayout();
    // 定位使用真实节点白名单的精确匹配，不解析模型选择器；滚动和短暂描边不会写入布局数据。
    if (event.data.type === 'locate' && typeof event.data.nodeId === 'string' && event.data.nodeId.length > 0 && event.data.nodeId.length <= ${MAX_PREVIEW_LOCATE_ID} && !/[\u0000-\u001f<>]/.test(event.data.nodeId)) {
      const node = Array.from(root.querySelectorAll('[data-site-node-id]')).find(element => element.getAttribute('data-site-node-id') === event.data.nodeId);
      if (node) {
        const previous = locatedNodes.get(node), outline = previous ? previous.outline : node.style.outline, offset = previous ? previous.offset : node.style.outlineOffset;
        if (previous) clearTimeout(previous.timer);
        node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        node.style.outline = '2px solid #d97706'; node.style.outlineOffset = '3px';
        const timer = setTimeout(() => { node.style.outline = outline; node.style.outlineOffset = offset; locatedNodes.delete(node); }, 1800);
        locatedNodes.set(node, { outline, offset, timer });
      }
      send({ type: 'node-location', found: !!node });
    }
  });
  window.addEventListener('resize', inspectLayout);
  root.addEventListener('load', inspectLayout, true); root.addEventListener('error', inspectLayout, true);
  document.fonts?.ready.then(inspectLayout); inspectLayout();
`;
