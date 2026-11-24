import type { MediaItem } from './types';
import { bundledImage } from './bundled-media';
import { safeImageSrc } from './site-safety';
export const IMAGE_WIDTHS = [320, 768, 1440] as const;
export type ImageSize = 'auto' | 'original' | '320' | '768' | '1440';
/** 只给已验证本地图片生成衍生地址；原URL始终保留，旧资料缺尺寸时自然沿用原图。 */
export function imageAttributes(source: string, media: MediaItem[] = [], size: ImageSize = 'auto', derived = true) {
  const src = safeImageSrc(source), item = media.find(m => m.url === src && m.kind === 'image');
  const bundled = bundledImage(src);
  const local = /^\/api\/media\/[a-zA-Z0-9_-]+$/.test(src || '');
  const variants = derived ? item?.variants || [] : [];
  const selected = size !== 'auto' && size !== 'original' ? variants.find(v => String(v.width) === size) : undefined;
  return { src: local && selected ? `${src}?width=${selected.width}` : src || undefined, width: item?.width || bundled?.width, height: item?.height || bundled?.height, loading: 'lazy' as const, decoding: 'async' as const,
    ...(local && size === 'auto' && variants.length ? { srcSet: [...variants.map(v => `${src}?width=${v.width} ${v.width}w`), `${src} ${item!.width}w`].join(', '), sizes: '(max-width: 700px) 100vw, (max-width: 1024px) 50vw, 50vw' } : {}) };
}
