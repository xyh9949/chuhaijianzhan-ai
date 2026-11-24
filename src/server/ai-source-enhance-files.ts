import { createRequire } from 'node:module';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AiSourceEnhanceRequest, AiSourceImage } from '../lib/ai-source-types';
import { getDataDirectory } from './database';
import { ApiError } from './http';
import { SOURCE_ENHANCE_WORKER } from './ai-source-enhance-worker';

export type EnhancedSourceFiles = { pages: { pageNumber: number; text: string; confidence: number }[]; images: (AiSourceImage & { data: Uint8Array })[]; warnings: string[] };
const runtime = globalThis as typeof globalThis & { formStudioSourceParsers?: Set<string> };
/** 只处理已经过原上传解析器验证的原文件；外层服务另核对私有归属、原件hash和所选页码。 */
export async function enhanceAiSourceFile(bytes: Uint8Array, kind: 'pdf' | 'xlsx', options: AiSourceEnhanceRequest, signal?: AbortSignal): Promise<EnhancedSourceFiles> {
  if (!bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024) throw new ApiError(413, '资料大小超出处理范围');
  if (typeof options.ocr !== 'boolean' || typeof options.images !== 'boolean' || !options.ocr && !options.images || !['eng', 'chi_sim', 'eng+chi_sim'].includes(options.language)) throw new ApiError(422, '请选择本地识别语言及处理方式');
  if (kind === 'xlsx' && (options.ocr || !options.images)) throw new ApiError(422, 'Excel支持提取真实锚定图片，OCR请选择PDF');
  if (kind === 'pdf' && (!Array.isArray(options.pageNumbers) || !options.pageNumbers.length || options.pageNumbers.length > 5 || options.pageNumbers.some(page => !Number.isInteger(page) || page < 1 || page > 100) || new Set(options.pageNumbers).size !== options.pageNumbers.length)) throw new ApiError(422, '每次请选择1–5个PDF页码');
  if (signal?.aborted) throw new ApiError(499, '资料增强已取消');
  const key = getDataDirectory(), busy = runtime.formStudioSourceParsers ??= new Set(); if (busy.has(key)) throw new ApiError(429, '正在处理另一份资料，请完成或取消后重试'); busy.add(key);
  let langDir = '';
  try {
    const require = createRequire(join(process.cwd(), 'package.json'));
    // 训练数据由固定版本依赖提供，复制到本次私有临时目录；从不接受用户路径或CDN地址。
    if (options.ocr) { langDir = mkdtempSync(join(tmpdir(), 'form-studio-ocr-')); for (const language of options.language.split('+')) copyFileSync(join(dirname(require.resolve(/* turbopackIgnore: true */ `@tesseract.js-data/${language}/package.json`)), '4.0.0_best_int', `${language}.traineddata.gz`), join(langDir, `${language}.traineddata.gz`)); }
    const paths = { pdfLibrary: kind === 'pdf' ? require.resolve(/* turbopackIgnore: true */ 'pdfjs-dist/legacy/build/pdf.mjs') : '', canvasLibrary: kind === 'pdf' ? require.resolve(/* turbopackIgnore: true */ '@napi-rs/canvas') : '', excelLibrary: kind === 'xlsx' ? require.resolve(/* turbopackIgnore: true */ 'exceljs') : '', sharpLibrary: require.resolve(/* turbopackIgnore: true */ 'sharp'), tessLibrary: options.ocr ? require.resolve(/* turbopackIgnore: true */ 'tesseract.js') : '', tessWorker: options.ocr ? require.resolve(/* turbopackIgnore: true */ 'tesseract.js/src/worker-script/node/index.js') : '' };
    return await new Promise<EnhancedSourceFiles>((done, reject) => {
      const baseRss = process.memoryUsage().rss, copy = Uint8Array.from(bytes), worker = new Worker(SOURCE_ENHANCE_WORKER, { eval: true, workerData: { ...paths, bytes: copy, kind, options, langDir }, transferList: [copy.buffer], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } }); worker.stdout.resume(); worker.stderr.resume(); let settled = false;
      const finish = (value?: EnhancedSourceFiles, error?: ApiError) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(memoryTimer); signal?.removeEventListener('abort', cancel); worker.postMessage({ cancel: true }); void worker.terminate().finally(() => { if (error) reject(error); else done(value!); }); };
      const cancel = () => finish(undefined, new ApiError(499, '资料增强已取消，网站保持不变'));
      const timer = setTimeout(() => finish(undefined, new ApiError(504, '离线识别超过90秒，请减少页数或拆分资料')), 90_000);
      // native画布/WASM不计入V8堆限制；观察进程增量超512MiB时保守终止本任务，繁忙实例可稍后重试。
      const memoryTimer = setInterval(() => { if (process.memoryUsage().rss - baseRss > 512 * 1024 * 1024) finish(undefined, new ApiError(413, '本地识别内存增量超过512 MiB，请减少页数或稍后重试')); }, 200);
      signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
      worker.once('message', (result: { ok: boolean; value?: EnhancedSourceFiles; code?: string }) => { if (result.ok && result.value) finish(result.value); else finish(undefined, new ApiError(422, result.code === 'page' ? '所选页码不在原文件范围' : result.code === 'pixels' ? '页面尺寸超过本地识别限制' : result.code === 'text' ? '单页识别超过30000字符，请拆分资料' : '资料增强未完成，可能是损坏文件或不支持的嵌入格式，请重新导出后重试')); });
      worker.once('error', () => finish(undefined, new ApiError(422, '本地资料处理超出资源或格式限制'))); worker.once('exit', () => finish(undefined, new ApiError(422, '本地资料处理未完整结束')));
    });
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, '本地OCR依赖未完整安装，请管理员按固定依赖重建服务'); }
  // 这里只清本次系统临时目录；静态追踪不应把动态临时路径展开成整项目的部署依赖。
  finally { if (langDir && resolve(/* turbopackIgnore: true */ langDir).startsWith(resolve(/* turbopackIgnore: true */ tmpdir()) + sep + 'form-studio-ocr-')) rmSync(langDir, { recursive: true, force: true }); busy.delete(key); }
}
