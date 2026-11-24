import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { readActiveSite } from '@/lib/site-request';
import { localeAtPath } from '@/lib/localization';
export const metadata: Metadata = { title: 'Website' };
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [snapshot, requestHeaders] = await Promise.all([readActiveSite(), headers()]);
  const pathname = requestHeaders.get('x-form-studio-pathname') || '/';
  // 已发布语言路径决定公开文档的 lang；后台和私有预览保留站点默认，隔离画布独立标注自己的语言。
  const language = snapshot ? localeAtPath(snapshot.settings, pathname) : 'zh-CN';
  // 根布局不加载后台字体、Puck UI 或管理主题；Ant 仅收集实际渲染控件的首屏样式。
  return <html lang={language}><body style={{ margin: 0 }}><AntdRegistry>{children}</AntdRegistry></body></html>;
}
