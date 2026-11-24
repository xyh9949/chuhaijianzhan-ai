'use client';
import { useEffect } from 'react';
import { captureBrowserAttribution } from '@/lib/inquiry-attribution';

/** 仅公开页面挂载；留存同标签页有限来源，不发请求、不计访客或浏览轨迹。 */
export default function SiteAttributionCapture({ pageKey }: { pageKey: string }) {
  useEffect(() => { captureBrowserAttribution(); }, [pageKey]);
  return null;
}
