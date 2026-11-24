import 'server-only';
import { cache } from 'react';
import { connection } from 'next/server';
import { getActiveSiteSnapshot, getDraftSiteSnapshot } from '@/server/publication';
import { requireActor } from '@/server/permissions';
import { ApiError } from '@/server/http';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

// React cache 仅在本次服务端请求内去重，让 metadata 与页面读取同一个版本。
// 不使用跨请求缓存；同步 SQLite 查询在 connection() 之后执行。
export const readActiveSite = cache(async () => {
  await connection();
  return getActiveSiteSnapshot();
});

export const readPreviewSite = cache(async () => {
  await connection();
  try { await requireActor(); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // 内嵌预览就地提示会话失效，由用户在顶层打开登录；直接打开预览保留原登录跳转。
      const destination = (await headers()).get('sec-fetch-dest');
      if (destination === 'iframe' || destination === 'frame') return null;
      redirect('/admin');
    }
    throw error;
  }
  return getDraftSiteSnapshot();
});
