import type { ReactNode } from 'react';
export interface NavigationItem { key: string; label: string; href?: string; newTab?: boolean; children?: NavigationItem[]; }

/** 原生details在无JS及隔离SSR预览中均可开合；Ant Drawer需要React水合，无法满足此边界。 */
export default function SiteNavigation({ items, label = 'Website navigation', editing = false, mobileMode = 'collapse',openLabel='Open' }: { items: NavigationItem[]; label?: string; editing?: boolean; mobileMode?: 'collapse' | 'inline';openLabel?:string }) {
  const link = (item: NavigationItem) => item.href ? <a href={editing ? undefined : item.href} target={item.newTab ? '_blank' : undefined} rel={item.newTab ? 'noopener noreferrer' : undefined}>{item.label}</a> : <span>{item.label}</span>;
  const list = (items: NavigationItem[]): ReactNode => <ul>{items.map(item => <li key={item.key}>{item.children?.length ? <details><summary>{item.label}</summary>{item.href && link(item)}{list(item.children)}</details> : link(item)}</li>)}</ul>;
  // 展示模式由原生控件显式设置；品牌链接始终可见，不按标签或菜单项数量猜测手机行为。
  if (mobileMode === 'inline') return <nav aria-label={label} className="site-managed-navigation site-managed-navigation-inline"><div className="site-menu-desktop">{list(items)}</div><div className="site-menu-inline">{list(items)}</div></nav>;
  return <nav aria-label={label} className="site-managed-navigation"><div className="site-menu-desktop">{list(items)}</div><details className="site-menu-mobile"><summary aria-label={`${openLabel} ${label}`}>☰</summary><div className="site-menu-panel">{list(items)}</div></details></nav>;
}
