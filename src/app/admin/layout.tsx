import type { Metadata } from 'next';
import { adminCssVars } from '@/lib/admin-theme';
import { PRODUCT_NAME } from '@/lib/product-brand';
import '../globals.css';

export const metadata: Metadata = { title: `${PRODUCT_NAME} · 网站管理`, robots: { index: false, follow: false } };
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // 管理令牌只在 /admin 内继承；对外站点与草稿预览使用客户主题。
  return <div className="admin-scope" lang="zh-CN" style={adminCssVars}><style>{`.admin-app{${Object.entries(adminCssVars).map(([key, value]) => `${key}:${value}`).join(';')}}`}</style>{children}</div>;
}
