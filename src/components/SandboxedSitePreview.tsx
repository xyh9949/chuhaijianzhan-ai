'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Spin } from 'antd';
import { readPreviewMediaBlob } from '@/lib/preview-media';
import { createSandboxDocument, safePreviewNavigation } from '@/lib/site-code-render';
import { MAX_PREVIEW_LOCATE_ID, normalizeAiPreviewFeedback } from '@/lib/ai-preview-inspection';

type Props = { children: ReactNode; css: string[]; scripts: string[]; language: string; navigationPrefix?: string; viewport?: boolean; inspect?: boolean; focusFromAddress?: boolean };
const PREVIEW_ANCHOR_POSITION = 'formStudioPreviewAnchorPosition';
const validScroll = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

async function readStyles(): Promise<string[]> {
  return Promise.all(Array.from(document.styleSheets).map(async (sheet) => {
    try { return Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n'); }
    catch {
      // Next 的独立 CSS 可能尚未完成加载；只读取本站样式，不转发认证给其他主机。
      if (sheet.href && new URL(sheet.href).origin === location.origin) {
        const response = await fetch(sheet.href, { credentials: 'same-origin' });
        if (response.ok) return response.text();
      }
      return '';
    }
  }));
}

async function privateMediaData(url: string, reserve: (bytes: number) => void): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  const blob = await readPreviewMediaBlob(response, reserve);
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('草稿素材读取失败')); reader.readAsDataURL(blob); });
}

/** SSR 只生成可信组件树；自定义代码仅写入无同源权限的沙箱，不插入后台/预览父文档。 */
export function SandboxedSitePreview({ children, css, scripts, language, navigationPrefix = '/preview', viewport = false, inspect = false, focusFromAddress = false }: Props) {
  const source = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [documentHtml, setDocumentHtml] = useState('');
  const [error, setError] = useState('');
  const [scriptError, setScriptError] = useState(false);
  const [focusStatus, setFocusStatus] = useState('');
  const [height, setHeight] = useState(800);
  useEffect(() => {
    let active = true;
    const prepare = async () => {
      if (!source.current) return;
      const copy = source.current.cloneNode(true) as HTMLElement;
      // 附件只在公开站点下载；沙箱不接收PDF资料，也不把附件误当图片转为data URL。
      for (const anchor of copy.querySelectorAll('a[href^="/api/media/"]')) { anchor.removeAttribute('href'); anchor.setAttribute('aria-disabled', 'true'); anchor.setAttribute('title', '附件请在公开网站下载，预览不触发下载'); }
      const markup = copy.innerHTML;
      const styles = await readStyles();
      // 私有素材由已登录父层读取并转为受控媒体数据；沙箱不收到 cookie、token 或读取任意 URL 的代理。
      const urls = [...new Set((markup + css.join('\n')).match(/\/api\/media\/[a-zA-Z0-9_-]+/g) || [])];
      let totalBytes = 0;
      const reserve = (bytes: number) => { totalBytes += bytes; if (totalBytes > 64 * 1024 * 1024) throw new Error('当前预览媒体合计超过64 MB，请减少同页视频或压缩素材'); };
      const media = await Promise.all(urls.map(async (url) => [url, await privateMediaData(url, reserve)] as const));
      const replaceMedia = (value: string) => value.replace(/\/api\/media\/[a-zA-Z0-9_-]+/g, (url) => media.find(([path]) => path === url)?.[1] || url);
      const next = createSandboxDocument({ markup: replaceMedia(markup), styles, css: css.map(replaceMedia), scripts, baseUrl: location.href, language, inspect });
      if (active) { setDocumentHtml(next); setError(''); }
    };
    prepare().catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '预览初始化失败'); });
    return () => { active = false; };
  }, [children, css, scripts, language, inspect]);
  useEffect(() => {
    let requestedFocus = false;
    // 只对明确启用的私有检查读取定位标识，等隔离画布上报实测后定位，不依赖固定延时。
    const nodeId = focusFromAddress ? new URLSearchParams(location.hash.slice(1)).get('locate') : null;
    const syncAnchor = () => {
      // 已有锚点的历史条目按地址重新定位；无片段条目才恢复此前的自由滚动。
      const position = !location.hash && history.state?.[PREVIEW_ANCHOR_POSITION];
      const restore = position?.url === location.href && validScroll(position.outer) && validScroll(position.inner);
      if (restore) window.scrollTo({ top: position.outer, behavior: 'instant' });
      frame.current?.contentWindow?.postMessage({ source: 'form-studio-preview-anchor', hash: location.hash, ...(restore ? { scrollY: position.inner } : {}) }, '*');
    };
    const receive = (event: MessageEvent) => {
      // 检查请求仅来自同源嵌入者；沙箱回报只投影固定测量字段，再交给AI比较界面。
      if (inspect && event.source === window.parent && event.origin === location.origin && event.data?.source === 'form-studio-inspection') {
        if (event.data.type === 'inspect') frame.current?.contentWindow?.postMessage({ source: 'form-studio-inspection', type: 'inspect' }, '*');
        // 定位只接受短节点标识；不转发选择器、脚本或其他任意沙箱操作。
        if (event.data.type === 'locate' && typeof event.data.nodeId === 'string' && event.data.nodeId.length > 0 && event.data.nodeId.length <= MAX_PREVIEW_LOCATE_ID && !/[\u0000-\u001f<>]/.test(event.data.nodeId)) frame.current?.contentWindow?.postMessage({ source: 'form-studio-inspection', type: 'locate', nodeId: event.data.nodeId }, '*');
        return;
      }
      if (event.source !== frame.current?.contentWindow || event.data?.source !== 'form-site-sandbox') return;
      if (inspect && event.data.type === 'layout-inspection') {
        try {
          const [report] = normalizeAiPreviewFeedback([event.data.report]);
          if (!requestedFocus && nodeId && nodeId.length <= MAX_PREVIEW_LOCATE_ID && !/[\u0000-\u001f<>]/.test(nodeId)) {
            requestedFocus = true;
            frame.current?.contentWindow?.postMessage({ source: 'form-studio-inspection', type: 'locate', nodeId }, '*');
          }
          if (window.parent !== window) window.parent.postMessage({ source: 'form-studio-preview-inspection', path: location.pathname, report }, location.origin);
        } catch { /* 不转发不符合测量契约的沙箱消息。 */ }
      }
      if (inspect && event.data.type === 'node-location' && typeof event.data.found === 'boolean') {
        if (requestedFocus) setFocusStatus(event.data.found ? '已在页面中标出问题区块' : '当前预览未找到该区块，请重新检查');
        if (window.parent !== window) window.parent.postMessage({ source: 'form-studio-preview-inspection', path: location.pathname, type: 'node-location', found: event.data.found }, location.origin);
      }
      if (event.data.type === 'height' && typeof event.data.height === 'number' && Number.isFinite(event.data.height)) setHeight(Math.min(30000, Math.max(400, Math.ceil(event.data.height))));
      if (event.data.type === 'script-error') setScriptError(true);
      if (event.data.type === 'navigate') {
        const href = safePreviewNavigation(event.data.href, location.origin, navigationPrefix);
        if (!href) return;
        const next = new URL(href, location.origin);
        if (next.pathname !== location.pathname || next.search !== location.search || !validScroll(event.data.scrollY)) {
          location.assign(href);
          return;
        }
        // 从无片段位置离开时，先记录外层和画布滚动，再定位锚点。
        if (next.href !== location.href) {
          const state = history.state;
          if (!location.hash) history.replaceState({ ...state, [PREVIEW_ANCHOR_POSITION]: { url: location.href, outer: window.scrollY, inner: event.data.scrollY } }, '');
          history.pushState({ ...state, [PREVIEW_ANCHOR_POSITION]: null }, '', href);
        } else if (next.hash) {
          frame.current?.contentWindow?.postMessage({ source: 'form-studio-preview-anchor', hash: next.hash }, '*');
          return;
        }
        syncAnchor();
      }
    };
    window.addEventListener('message', receive);
    window.addEventListener('hashchange', syncAnchor);
    return () => { window.removeEventListener('message', receive); window.removeEventListener('hashchange', syncAnchor); };
  }, [navigationPrefix, inspect, focusFromAddress]);
  // 整站案例在真实视口内滚动，原生灯箱与固定菜单才不会按数千像素的文档高度定位。
  return <div className="site-sandbox-preview" style={viewport ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : undefined}>
    <div ref={source} hidden aria-hidden="true" data-preview-source="true">{children}</div>
    {focusStatus && <Alert type="info" title={focusStatus} />}
    {error && <Alert type="error" showIcon title={error} />}
    {scriptError && <Alert type="warning" showIcon title="自定义 JavaScript 运行出错，请在开发者工具中检查；页面仍可预览。" />}
    {!documentHtml && !error && <div style={{ padding: 48, textAlign: 'center' }}><Spin description="正在准备隔离预览"><div style={{ height: 64 }} /></Spin></div>}
    {documentHtml && <iframe ref={frame} title="网站草稿隔离预览" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={documentHtml} style={{ display: 'block', width: '100%', height: viewport ? '100%' : height, ...(viewport ? { flex: '1 1 auto', minHeight: 0 } : {}), border: 0, background: '#fff' }} />}
  </div>;
}
