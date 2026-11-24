import type { Locator } from 'playwright-core';

export interface PreviewImageObservation { index: number; observed: boolean; intersecting: boolean; complete: boolean; naturalWidth: number; loading: string; }
/** 浏览器原生IntersectionObserver会计入滚动祖先与外层iframe裁剪；不把自己的rect误当实际可见范围。 */
export function observePreviewImages(images: Locator): Promise<PreviewImageObservation[]> {
  return images.evaluateAll(elements => new Promise<PreviewImageObservation[]>(resolve => {
    if (!elements.length) { resolve([]); return; }
    const ratios = new Map<Element, number>(); let timer: ReturnType<typeof setTimeout>;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) ratios.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0);
      if (ratios.size === elements.length) {
        clearTimeout(timer); observer.disconnect();
        resolve(elements.map((element, index) => ({ index, observed: true, intersecting: (ratios.get(element) || 0) > 0, complete: (element as HTMLImageElement).complete, naturalWidth: (element as HTMLImageElement).naturalWidth, loading: (element as HTMLImageElement).loading })));
      }
    });
    timer = setTimeout(() => {
      observer.disconnect();
      resolve(elements.map((element, index) => ({ index, observed: ratios.has(element), intersecting: (ratios.get(element) || 0) > 0, complete: (element as HTMLImageElement).complete, naturalWidth: (element as HTMLImageElement).naturalWidth, loading: (element as HTMLImageElement).loading })));
    }, 1000);
    elements.forEach(element => observer.observe(element));
  }));
}
