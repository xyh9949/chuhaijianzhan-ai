// 展示层的最后一道校验；服务端保存、上传和发布仍须独立验证输入。
const unsafeCharacters = /[\u0000-\u0020\u007f\\]/;

export function safeLinkHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const href = value.trim();
  if (!href || unsafeCharacters.test(href) || href.startsWith('//')) return undefined;
  if (href.startsWith('#') || (href.startsWith('/') && !href.startsWith('/\\'))) return href;
  try {
    const url = new URL(href);
    if (['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol)) return href;
  } catch { /* 相对路径必须以 / 开始，避免协议与编码歧义。 */ }
  return undefined;
}

export function safeImageSrc(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8_000_000) return undefined;
  const src = value.trim();
  // 兼容已有栅格上传，但不接受 SVG、HTML 或任意 data URL。
  const data = /^data:image\/(png|jpeg|webp|avif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(src);
  if (data) {
    try {
      const prefix = atob(data[2].slice(0, 64));
      const valid = data[1] === 'png' ? prefix.startsWith('\x89PNG\r\n\x1a\n')
        : data[1] === 'jpeg' ? prefix.startsWith('\xff\xd8\xff')
        : data[1] === 'webp' ? prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP'
        : prefix.slice(4, 8) === 'ftyp' && /avif|avis/.test(prefix.slice(8, 32));
      return valid ? src : undefined;
    } catch { return undefined; }
  }
  const href = safeLinkHref(src);
  if (!href || href.startsWith('#')) return undefined;
  try {
    const url = new URL(href, 'https://site.invalid');
    if (!['http:', 'https:'].includes(url.protocol) || /\.svgz?$/i.test(url.pathname)) return undefined;
    return href;
  } catch { return undefined; }
}

export function safeBackgroundImage(value: unknown): string | undefined {
  const image = safeImageSrc(value);
  // JSON 引号转义防止 URL 中的引号终止 CSS url() 字符串。
  return image ? `linear-gradient(90deg,rgba(19,25,21,.46),rgba(19,25,21,.04)),url(${JSON.stringify(image)})` : undefined;
}

export function safeEmailHref(email: unknown, subject?: string): string | undefined {
  if (typeof email !== 'string' || !/^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(email)) return undefined;
  return `mailto:${email}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
}
