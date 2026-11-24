import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { getDatabase, getDataDirectory } from './database';
import { ApiError } from './http';

const MAX_PRIVATE_BYTES = 80 * 1024 * 1024;
/** 路径只接受服务端签发的UUID；目录名不包含用户邮箱、原文件名或客户端路径。 */
function location(actorId: string, sourceId?: string) {
  const owner = createHash('sha256').update(actorId).digest('hex'), root = resolve(getDataDirectory(), 'private', 'ai-sources', owner);
  if (sourceId !== undefined && !/^ais-[a-f0-9-]{36}$/.test(sourceId)) throw new ApiError(422, '资料标识无效');
  const target = sourceId ? resolve(root, sourceId) : root;
  if (target !== root && !target.startsWith(root + sep)) throw new ApiError(422, '私有资料路径无效'); return target;
}
function removeDirectory(actorId: string, id: string) { const target = location(actorId, id), root = location(actorId); if (target.startsWith(root + sep)) rmSync(target, { recursive: true, force: true }); }
/** 主动写操作才回收过期资料；目录归属与UUID均验证后再递归删除，不触碰公开素材目录。 */
export function cleanAiSourcePrivate(actorId: string) {
  const root = location(actorId); if (!existsSync(root)) return;
  for (const id of readdirSync(root)) if (/^ais-[a-f0-9-]{36}$/.test(id) && !getDatabase().prepare("SELECT 1 FROM cms_ai_source WHERE id=? AND actor_id=? AND kind='source' AND expires_at>?").get(id, actorId, new Date().toISOString())) removeDirectory(actorId, id);
}
export function deleteAiSourcePrivate(actorId: string, sourceId: string) { removeDirectory(actorId, sourceId); }
export function writeAiSourcePrivate(actorId: string, sourceId: string, file: 'original.bin' | `${string}.webp`, bytes: Uint8Array) {
  if (file !== 'original.bin' && !/^img-[a-f0-9]{24}\.webp$/.test(file)) throw new ApiError(422, '私有图片标识无效');
  const root = location(actorId), directory = location(actorId, sourceId), path = join(directory, file); let total = 0;
  if (existsSync(root)) for (const id of readdirSync(root)) if (/^ais-[a-f0-9-]{36}$/.test(id)) { const folder = location(actorId, id); if (statSync(folder).isDirectory()) for (const name of readdirSync(folder)) if (name === 'original.bin' || /^img-[a-f0-9]{24}\.webp$/.test(name)) total += statSync(join(folder, name)).size; }
  if (total - (existsSync(path) ? statSync(path).size : 0) + bytes.byteLength > MAX_PRIVATE_BYTES) throw new ApiError(429, '本人暂存原文件与图片已达80 MB，请先移除不用的资料');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600 });
}
export function readAiSourcePrivate(actorId: string, sourceId: string, imageId?: string) {
  if (imageId !== undefined && !/^img-[a-f0-9]{24}$/.test(imageId)) throw new ApiError(422, '私有图片标识无效');
  const path = join(location(actorId, sourceId), imageId ? `${imageId}.webp` : 'original.bin');
  if (!existsSync(path)) throw new ApiError(410, '私有原文件或图片已清理，请重新上传资料'); return readFileSync(path);
}
