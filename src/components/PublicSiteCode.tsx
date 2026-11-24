'use client';

import Script from 'next/script';
import { useState } from 'react';

/** Next Script 按 src 去重；先运行全站代码再运行本页代码，单个下载失败仍继续。 */
export function PublicSiteCode({ sources }: { sources: string[] }) {
  const [ready, setReady] = useState(0);
  return <>{sources.slice(0, ready + 1).map((src, index) => <Script key={src} id={`site-code-${src}`} src={src} strategy="afterInteractive" onReady={() => setReady((value) => Math.max(value, index + 1))} onError={() => setReady((value) => Math.max(value, index + 1))} />)}</>;
}
