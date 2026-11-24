import { randomUUID } from 'node:crypto';
import type { ContentEntry } from '../lib/types';
import { getContentEntryPath } from '../lib/content-routes';
import { resolveSitePage } from '../lib/site-routing';
import { getDataDirectory } from './database';
import { getDraftSiteSnapshot } from './publication';
import { getDraftRecord } from './studio';
import { validateDraft } from './validation';
import { requirePermission, type Actor } from './permissions';
import { ApiError } from './http';

const lifetime = 20 * 60 * 1000;
const maxCandidates = 20;
type Preview = { id: string; revision: number; entry: ContentEntry; expires: number };
const storage = globalThis as typeof globalThis & { formStudioEntryPreviews?: Map<string, Preview> };
const previews = storage.formStudioEntryPreviews ??= new Map<string, Preview>();
const key = (actor: Actor) => `${getDataDirectory()}\0${actor.id}`;

/** 一人仅保留最近一次私有稿。只暂存这一条编辑输入，真实详情模板仍来自同版本草稿。 */
export function createContentEntryPreview(actor: Actor, value: Record<string, unknown>) {
  requirePermission(actor, 'edit');
  const draft = getDraftRecord();
  if (Object.keys(value).length !== 1 || !value.entry || typeof value.entry !== 'object' || Array.isArray(value.entry)) throw new ApiError(422, '需要一条预览内容');
  const entry = value.entry as ContentEntry;
  const entries = (draft.content.contentEntries || []).filter(item => item.id !== entry.id);
  const checked = validateDraft({ ...draft.content, contentEntries: [...entries, { ...entry, status: 'draft' }] });
  const candidate = checked.contentEntries!.at(-1)!;
  const path = getContentEntryPath(checked, candidate);
  if (!path) throw new ApiError(422, '此栏目还没有可用的详情页，请先在栏目设置中设置');
  const now = Date.now(), owner = key(actor);
  for (const [entryKey, preview] of previews) if (preview.expires <= now) previews.delete(entryKey);
  previews.delete(owner);
  if (previews.size >= maxCandidates) previews.delete(previews.keys().next().value!);
  const id = randomUUID();
  previews.set(owner, { id, revision: draft.revision, expires: now + lifetime, entry: candidate });
  return { href: `/preview/~entry/${id}${path}` };
}

export function resolveContentEntryPreview(actor: Actor, id: string, segments: string[]) {
  requirePermission(actor, 'edit');
  const draft = previews.get(key(actor));
  if (!draft || draft.id !== id || draft.expires <= Date.now() || draft.revision !== getDraftRecord().revision) return null;
  const snapshot = getDraftSiteSnapshot();
  const path = getContentEntryPath(snapshot, draft.entry);
  if (path !== `/${segments.join('/')}`) return null;
  snapshot.contentEntries = [...(snapshot.contentEntries || []).filter(entry => entry.id !== draft.entry.id), { ...draft.entry, status: 'published' }];
  const resolved = resolveSitePage(snapshot, segments);
  return resolved?.entry?.id === draft.entry.id ? { snapshot, resolved } : null;
}
