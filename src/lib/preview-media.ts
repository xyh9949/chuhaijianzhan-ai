/** 私有预览按实际分块字节读取；媒体来自已鉴权的父层，不把认证交给沙箱。
 * Content-Length可能被Next流式响应省略。单文件40MB，单页总预算由调用方共享。 */
export async function readPreviewMediaBlob(response: Response, reserve: (bytes: number) => void): Promise<Blob> {
  if (!response.ok) throw new Error('草稿素材读取失败，请刷新后重试');
  const mime = response.headers.get('content-type')?.split(';')[0] || '';
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'video/mp4', 'video/webm'].includes(mime)) { await response.body?.cancel(); throw new Error('草稿素材格式不受支持'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('草稿素材内容为空');
  const chunks: ArrayBuffer[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 40 * 1024 * 1024) throw new Error('草稿素材超过40 MB'); reserve(value.byteLength); chunks.push(new Uint8Array(value).buffer); }
  } catch (error) { await reader.cancel(); throw error; }
  return new Blob(chunks, { type: mime });
}
