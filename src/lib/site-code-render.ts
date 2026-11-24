import type { CodeSnippet, SiteCustomCode } from './types';
import { AI_PREVIEW_INSPECTION_SCRIPT } from './ai-preview-inspection';

export function enabledSiteCode(code: SiteCustomCode | undefined, pageId: string): { target: string; snippet: CodeSnippet }[] {
  return [{ target: 'global', snippet: code?.global }, { target: pageId, snippet: code?.pages?.[pageId] }].filter((entry): entry is { target: string; snippet: CodeSnippet } => Boolean(entry.snippet));
}

export function siteCodeAssetUrl(releaseId: string, target: string, kind: 'css' | 'js') {
  return `/api/site-code/${encodeURIComponent(releaseId)}/${encodeURIComponent(target)}/${kind}`;
}

export interface PreviewDocumentInput {
  markup: string; styles: string[]; css: string[]; scripts: string[]; baseUrl: string; language: string; inspect?: boolean;
}

/** JSON 置于唯一受控脚本中；用户 CSS/JS 通过 textContent/Function 使用，不能闭合 HTML 标签逃逸。 */
export function createSandboxDocument(input: PreviewDocumentInput): string {
  const payload = JSON.stringify(input).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"></head><body style="margin:0"><script>
(() => {
  const payload = ${payload};
  document.documentElement.lang = payload.language;
  const base = document.createElement('base'); base.href = payload.baseUrl; document.head.appendChild(base);
  for (const text of [...payload.styles, ...payload.css]) { const style = document.createElement('style'); style.textContent = text; document.head.appendChild(style); }
  const root = document.createElement('div'); root.innerHTML = payload.markup; document.body.appendChild(root);
  const send = (data) => parent.postMessage({ source: 'form-site-sandbox', ...data }, '*');
  const baseUrl = new URL(payload.baseUrl);
  // 首次打开带片段的预览也要定位到沙箱中的元素；AI 的 #locate= 仍走独立检查通道。
  const scrollToAnchor = (hash) => {
    if (!hash) { window.scrollTo({ top: 0, behavior: 'instant' }); return; }
    if (hash.startsWith('#locate=')) return;
    try { const id = decodeURIComponent(hash.slice(1)); if (id) document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'instant' }); } catch {}
  };
  let anchorSynced = false;
  if (baseUrl.hash && !baseUrl.hash.startsWith('#locate=')) {
    // 自适应高度画布会在首个尺寸回报后调整 iframe；只在初始布局阶段补齐一次定位。
    const initial = () => { if (!anchorSynced) scrollToAnchor(baseUrl.hash); };
    requestAnimationFrame(() => requestAnimationFrame(initial));
    window.addEventListener('load', initial, { once: true });
    window.addEventListener('resize', initial, { once: true });
    setTimeout(() => window.removeEventListener('resize', initial), 1200);
  }
  // 地址历史由同源预览父页持有；浏览器前进/后退时只同步定位，不重新创建沙箱。
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== baseUrl.origin || event.data?.source !== 'form-studio-preview-anchor' || typeof event.data.hash !== 'string') return;
    anchorSynced = true;
    const { hash, scrollY } = event.data;
    if (typeof scrollY === 'number' && Number.isFinite(scrollY)) window.scrollTo({ top: scrollY, behavior: 'instant' });
    else scrollToAnchor(hash);
  });
  // 沙箱只请求父层在私有预览范围导航，不能触发后台操作或任意跨站跳转。
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    event.preventDefault();
    try {
      const url = new URL(href, baseUrl);
      if (url.origin !== baseUrl.origin) return;
      if (!/^\\/preview(?:\\/|$)/.test(url.pathname)) return;
      const sameDocumentAnchor = url.hash && url.pathname === baseUrl.pathname && url.search === baseUrl.search;
      if (sameDocumentAnchor && url.hash.startsWith('#locate=')) return;
      // 由父页先记录当前历史位置，再命令画布滚动，避免把跳转后的位置记入原条目。
      send({ type: 'navigate', href: url.pathname + url.search + url.hash, ...(sameDocumentAnchor ? { scrollY: window.scrollY } : {}) });
    } catch {}
  });
  // 沙箱会在触发submit事件前拦截原生提交，因此提前接管点击/回车；仍不授予allow-forms。
  const navigateQuery = (form, event) => {
    if (!(form instanceof HTMLFormElement) || !form.matches('.site-loop-filters')) return;
    event.preventDefault();
    if (form.method.toLowerCase() !== 'get') return;
    try {
      const url = new URL(form.getAttribute('action') || payload.baseUrl, payload.baseUrl);
      if (url.origin !== new URL(payload.baseUrl).origin || !/^\\/preview(?:\\/|$)/.test(url.pathname)) return;
      url.search = ''; let count = 0;
      for (const [key, value] of new FormData(form)) { if (++count > 100 || typeof value !== 'string' || key.length > 240 || value.length > 2000) return; url.searchParams.append(key, value); }
      if (url.href.length < 12000) send({ type: 'navigate', href: url.pathname + url.search });
    } catch {}
  };
  // 预览表单仅执行本地校验并展示演示回执，绝不创建真实询盘或通知任务。
  const submitDemo = (form, event) => {
    if (!(form instanceof HTMLFormElement) || !form.matches('.site-contact-form[data-form-demo="true"]')) return false;
    event.preventDefault();
    if (!form.reportValidity()) return true;
    let status = form.querySelector('.site-form-demo-status');
    if (!status) { status = document.createElement('p'); status.className = 'site-form-demo-status'; status.setAttribute('role', 'status'); form.appendChild(status); }
    status.textContent = 'Preview only — no inquiry was sent.';
    return true;
  };
  document.addEventListener('click', event => {
    const submit = event.target instanceof Element ? event.target.closest('button[type="submit"],input[type="submit"]') : null;
    if (submit) { const form = submit.closest('form'); if (!submitDemo(form, event)) navigateQuery(form, event); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { const form = event.target.closest('form'); if (!submitDemo(form, event)) navigateQuery(form, event); }
  });
  document.addEventListener('submit', event => { event.preventDefault(); if (!submitDemo(event.target, event)) navigateQuery(event.target, event); });
  let queued = false;
  const resize = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; send({ type: 'height', height: Math.max(root.scrollHeight, root.getBoundingClientRect().height) }); }); };
  new ResizeObserver(resize).observe(root); window.addEventListener('load', resize); resize();
  ${input.inspect ? AI_PREVIEW_INSPECTION_SCRIPT : ''}
  // 单个片段报错不阻断页面或后续片段；每次创建预览文档只运行一次。
  for (const source of payload.scripts) { try { new Function(source.replace(/^#!/, '//')).call(window); } catch (error) { console.error('Website preview script failed', error); send({ type: 'script-error' }); } }
})();
</script></body></html>`;
}

/** 父页面重复验证沙箱导航，忽略自定义 JS 伪造的后台、跨站或编码绕过目标。 */
export function safePreviewNavigation(input: unknown, origin: string, prefix = '/preview'): string | null {
  // 完整站点案例只允许在自身命名空间导航；普通草稿和模板仍沿用原有 /preview 范围。
  if (!/^\/preview(?:\/[a-zA-Z0-9_~-]+)*$/.test(prefix)) return null;
  if (typeof input !== 'string' || input.length > 12000 || !input.startsWith('/preview') || /[\\\u0000-\u0020\u007f]/.test(input)) return null;
  try {
    const url = new URL(input, origin);
    if (url.origin !== origin || !/^\/preview(?:\/|$)/.test(url.pathname)) return null;
    const path = decodeURIComponent(url.pathname);
    if (!/^\/preview(?:\/|$)/.test(path) || /\\/.test(path) || path.split('/').some((part) => part === '..' || part === '.')) return null;
    if (!(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) || !(path === prefix || path.startsWith(`${prefix}/`))) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}
