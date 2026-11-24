'use client';

import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import type { StudioState } from './types';

export type ClientActor = { id: string; name: string; email: string; role: 'admin' | 'editor' | 'viewer' };
export type StudioEnvelope = { state: StudioState; revision: number; activeReleaseId: string | null };
export class RequestError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !url.startsWith('/api/auth/sign-in')) window.dispatchEvent(new Event('form-studio:session-expired'));
  if (!response.ok) throw new RequestError(response.status, data.error?.message || data.error || data.message || `请求失败（${response.status}）`);
  return data as T;
}

type SaveState = 'saved' | 'pending' | 'saving' | 'error';
type Waiter = { resolve: () => void; reject: (error: Error) => void };
type Mutation = (envelope: StudioEnvelope) => Promise<StudioEnvelope>;
type Job = Waiter & ({ kind: 'mutation'; run: Mutation } | { kind: 'refresh'; base: StudioEnvelope });
type Snapshot = { envelope: StudioEnvelope; saveState: SaveState; error: string; isMutating: boolean };
type Transport = { patch: (envelope: StudioEnvelope, patch: Partial<StudioState>) => Promise<StudioEnvelope>; read: () => Promise<StudioEnvelope> };
type Runtime = Snapshot & {
  actor: ClientActor; flush: () => Promise<void>; mutate: (callback: Mutation) => Promise<void>;
  refresh: () => Promise<void>; recoverRejectedMutation: () => Promise<void>; confirmMutationByReading:(matches:(value:StudioEnvelope)=>boolean)=>Promise<void>; accept: (value: StudioEnvelope) => void; getEnvelope: () => StudioEnvelope; getSaveState:()=>SaveState; retry: () => Promise<void>;
};
export const StudioContext = createContext<Runtime | null>(null);
export function useStudioRuntime() { const value = useContext(StudioContext); if (!value) throw new Error('工作区尚未加载'); return value; }

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>, keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
function recordId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as { id?: unknown; props?: { id?: unknown } }, id = item.id ?? item.props?.id;
  return typeof id === 'string' ? id : undefined;
}
// 重放操作开始后的本地差异，避免整包 pending 覆盖上传新增记录、其它页面或服务器更新时间。
// 同一字段同时变化时保留等待期间的新输入，随后仍通过 revision PATCH 进行服务器校验。
function rebase(base: unknown, local: unknown, server: unknown): unknown {
  if (equal(base, local)) return server;
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(server)) {
    const keyed = [base, local, server].every((items) => items.every((item) => recordId(item)) && new Set(items.map(recordId)).size === items.length);
    if (!keyed) return local;
    const before = new Map(base.map((item) => [recordId(item)!, item])), now = new Map(local.map((item) => [recordId(item)!, item])), result = new Map(server.map((item) => [recordId(item)!, item]));
    for (const id of before.keys()) if (!now.has(id)) result.delete(id);
    for (const [id, value] of now) if (!before.has(id) || !equal(before.get(id), value)) result.set(id, rebase(before.get(id), value, result.get(id)));
    const order = !equal(base.map(recordId), local.map(recordId)) ? [...now.keys(), ...result.keys()] : [...result.keys()];
    return [...new Set(order)].filter((id) => result.has(id)).map((id) => result.get(id));
  }
  if (base && local && server && typeof base === 'object' && typeof local === 'object' && typeof server === 'object' && !Array.isArray(base) && !Array.isArray(local) && !Array.isArray(server)) {
    const before = base as Record<string, unknown>, now = local as Record<string, unknown>, result = { ...server as Record<string, unknown> };
    for (const key of Object.keys(before)) if (!Object.hasOwn(now, key)) delete result[key];
    for (const key of Object.keys(now)) if (!Object.hasOwn(before, key) || !equal(before[key], now[key])) result[key] = rebase(before[key], now[key], result[key]);
    return result;
  }
  return local;
}
function selectedPage(state: StudioState, preferred: string) {
  return state.pages.some((page) => page.id === preferred) ? preferred : state.pages.find((page) => page.slug === '/')?.id || state.pages[0]?.id || '';
}

/** 顺序控制器可以用延迟请求独立验证，不依赖 React 挂载或实际服务器。 */
export function createStudioController(initial: StudioEnvelope, initialRole: ClientActor['role'], transport: Transport = {
  patch: (envelope, patch) => request('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: envelope.revision, patch }) }),
  read: () => request('/api/studio'),
}) {
  let live: StudioEnvelope = { ...initial, state: { ...initial.state, activePageId: selectedPage(initial.state, initial.state.activePageId) } };
  let pending: Partial<StudioState> = {}, waiters: Waiter[] = [], jobs: Job[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null, running: Promise<void> | null = null;
  let failure: Error | null = null, refreshFailed = false, uncertainMutation = false, role = initialRole, disposed = false, generation = 0, isMutating = false;
  let rejectInFlight: ((error: Error) => void) | null = null;
  const subscribers = new Set<() => void>();
  let snapshot: Snapshot = { envelope: live, saveState: 'saved', error: '', isMutating: false };
  const hasPending = () => Object.keys(pending).length > 0;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  const emit = () => {
    snapshot = { envelope: live, saveState: failure ? 'error' : running ? 'saving' : hasPending() || jobs.length ? 'pending' : 'saved', error: failure?.message || '', isMutating };
    if (!disposed) subscribers.forEach((listener) => listener());
  };
  const rejectQueued = (error: Error) => { waiters.splice(0).forEach((item) => item.reject(error)); jobs.splice(0).forEach((item) => item.reject(error)); };
  const fail = (error: Error) => { failure = error; clearTimer(); rejectQueued(error); emit(); };
  const adopt = (value: StudioEnvelope, base: StudioEnvelope) => {
    const state = rebase(base.state, live.state, value.state) as StudioState;
    // 版本/历史以服务器为准；本地询盘更新也参与重放，避免旧 PATCH 回包覆盖它。
    state.releases = value.state.releases;
    state.activePageId = selectedPage(state, live.state.activePageId);
    live = { ...value, state };
    pending = Object.fromEntries(Object.keys(pending).filter((key) => !equal(state[key as keyof StudioState], value.state[key as keyof StudioState])).map((key) => [key, state[key as keyof StudioState]]));
    emit();
  };
  const asError = (cause: unknown) => cause instanceof Error ? cause : new Error('请求失败');
  async function work() {
    while (!disposed && !failure && (hasPending() || jobs.length)) {
      const epoch = generation, first = jobs[0];
      // 明确重载优先于其后的新输入；GET 完成后再保存请求期间的新输入。
      if (first?.kind === 'refresh') {
        jobs.shift(); rejectInFlight = first.reject;
        try {
          const value = await transport.read();
          if (epoch !== generation || disposed) { first.reject(new Error('工作区已重新加载或关闭')); continue; }
          adopt(value, first.base); refreshFailed = false; first.resolve();
        } catch (cause) {
          const error = asError(cause); first.reject(error);
          if (epoch !== generation || disposed) continue;
          refreshFailed = true; fail(error); throw error;
        } finally { rejectInFlight = null; }
      } else if (hasPending()) {
        const patch = pending, listeners = waiters, base = structuredClone(live);
        pending = {}; waiters = []; rejectInFlight = (error) => listeners.forEach((item) => item.reject(error));
        try {
          const value = await transport.patch(base, patch);
          if (epoch !== generation || disposed) { listeners.forEach((item) => item.reject(new Error('工作区已重新加载或关闭'))); continue; }
          adopt(value, base); listeners.forEach((item) => item.resolve());
        } catch (cause) {
          const error = asError(cause); listeners.forEach((item) => item.reject(error));
          if (epoch !== generation || disposed) continue;
          pending = { ...patch, ...pending }; fail(error); throw error;
        } finally { rejectInFlight = null; }
      } else if (first?.kind === 'mutation') {
        jobs.shift(); const base = structuredClone(live); isMutating = true; rejectInFlight = first.reject; emit();
        try {
          // 回调只发送一次外部请求，不得在回调内部再次等待 flush/mutate；worker 本身从不自等。
          const value = await first.run(base);
          if (epoch !== generation || disposed) { first.reject(new Error('工作区已重新加载或关闭')); continue; }
          adopt(value, base); first.resolve();
        } catch (cause) {
          const error = asError(cause); first.reject(error);
          if (epoch !== generation || disposed) continue;
          // 确定性请求错误由调用组件提示，不把一次无效上传说成草稿保存失败。
          if (error instanceof RequestError && error.status >= 400 && error.status < 500 && ![401, 409].includes(error.status)) continue;
          // 网络/5xx 无法确定非幂等操作是否已经提交；必须重读服务器，绝不自动重放。
          uncertainMutation = !(error instanceof RequestError && [401, 409].includes(error.status));
          const blocked = uncertainMutation ? new Error(`外部操作结果尚未确认，请先重新加载服务器版本；原请求不会自动重试。${error.message}`) : error;
          fail(blocked); throw blocked;
        } finally { isMutating = false; rejectInFlight = null; emit(); }
      }
    }
    if (!failure && !disposed && !hasPending()) waiters.splice(0).forEach((item) => item.resolve());
  }
  function start(): Promise<void> {
    clearTimer();
    if (disposed) return Promise.reject(new Error('工作区已关闭'));
    if (failure) return Promise.reject(failure);
    if (running) return running;
    // 先赋 running 再进入微任务，空队列也不会留下已完成但未清理的“运行中”引用。
    running = Promise.resolve().then(work).finally(() => { running = null; emit(); if (!disposed && !failure && (hasPending() || jobs.length)) void start().catch(() => {}); });
    emit(); running.catch(() => {}); return running;
  }
  async function flush() {
    clearTimer();
    do { if (failure) throw failure; await start(); } while (running || hasPending() || jobs.length);
    if (failure) throw failure;
  }
  function update(patch: Partial<StudioState>): Promise<void> {
    const { activePageId, ...content } = patch;
    if (disposed || (Object.keys(content).length && role === 'viewer')) {
      const result = Promise.reject(new Error(disposed ? '工作区已关闭' : '当前账号只有查看权限')); result.catch(() => {}); return result;
    }
    live = { ...live, state: { ...live.state, ...patch } };
    if (!Object.keys(content).length) { emit(); return Promise.resolve(); }
    pending = { ...pending, ...content };
    // 422 可随字段修正继续提交；409、权限和网络失败不自动重放。
    if (failure instanceof RequestError && failure.status === 422 && !refreshFailed) failure = null;
    const result = new Promise<void>((resolve, reject) => {
      if (failure) { reject(failure); return; }
      waiters.push({ resolve, reject }); clearTimer();
      if (!running) timer = setTimeout(() => { void start().catch(() => {}); }, 450);
    });
    emit(); result.catch(() => {}); return result;
  }
  function mutate(run: Mutation): Promise<void> {
    const result = new Promise<void>((resolve, reject) => {
      if (disposed || failure || role === 'viewer') { reject(failure || new Error(disposed ? '工作区已关闭' : '当前账号只有查看权限')); return; }
      jobs.push({ kind: 'mutation', run, resolve, reject }); void start().catch(() => {});
    });
    result.catch(() => {}); return result;
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.reject(new Error('工作区已关闭'));
    const cancelled = new Error('已确认重新加载，旧的未保存操作已放弃');
    // 不假装撤销服务器已收到的请求：失效旧响应，再用 GET 读取其实际最终结果。
    generation++; clearTimer(); rejectQueued(cancelled); rejectInFlight?.(cancelled);
    pending = {}; failure = null; refreshFailed = false; uncertainMutation = false;
    const base = structuredClone(live);
    const result = new Promise<void>((resolve, reject) => jobs.push({ kind: 'refresh', base, resolve, reject }));
    emit(); void start().catch(() => {}); result.catch(() => {}); return result;
  }
  async function recoverRejectedMutation() {
    // 仅恢复已被服务器明确拒绝、且没有其它待提交数据的操作；不重送原请求、不丢队列输入。
    if (disposed || !(failure instanceof RequestError) || failure.status !== 409 || uncertainMutation || refreshFailed || hasPending() || jobs.length || isMutating || running) {
      throw new Error('还有待确认的操作或未保存工作，请先保留输入，再使用顶部导出和重新加载；当前表单保持。');
    }
    await refresh();
  }
  async function confirmMutationByReading(matches:(value:StudioEnvelope)=>boolean) {
    // 仅在组件已读取本人完成标记后使用；没有其它队列工作时只读核对，不重发或清掉新输入。
    if(disposed||!failure||!uncertainMutation||refreshFailed||hasPending()||jobs.length||isMutating||running)throw new Error('还有其它待保存或待确认操作，请保留输入后使用顶部重新加载。');
    const epoch=generation,base=structuredClone(live);isMutating=true;emit();
    try {const value=await transport.read();if(disposed||generation!==epoch||hasPending()||jobs.length||!matches(value))throw new Error('核对期间内容已有变化，当前输入保持，请重新核对。');failure=null;uncertainMutation=false;adopt(value,base);}
    finally {isMutating=false;emit();}
  }
  function accept(value: StudioEnvelope) {
    // 仅兼容询盘等同 revision 侧数据；改变草稿版本的响应必须走互斥的 mutate。
    if (value.revision !== live.revision) throw new Error('改变草稿版本的响应必须通过 runtime.mutate 接受');
    live = { ...live, state: { ...live.state, inquiries: value.state.inquiries } }; emit();
  }
  async function retry() {
    if (failure instanceof RequestError && failure.status === 409) throw new Error('其他窗口已修改内容，请先导出当前草稿，再重新加载服务器版本。');
    if (uncertainMutation) throw new Error('外部操作结果尚未确认，请先导出需要保留的输入，再重新加载服务器版本；不会自动重试原操作。');
    if (refreshFailed) throw new Error('重新加载失败，请先导出需要保留的输入，再重新加载服务器版本。');
    failure = null; emit(); await flush();
  }
  return {
    update, flush, mutate, refresh, recoverRejectedMutation, confirmMutationByReading, accept, retry,
    getEnvelope: () => live, getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    hasUnsavedWork: () => hasPending() || Boolean(running) || jobs.length > 0,
    setRole: (value: ClientActor['role']) => { role = value; },
    activate: () => { disposed = false; },
    dispose: () => { disposed = true; generation++; clearTimer(); const error = new Error('工作区已关闭，未完成的输入未保存'); rejectQueued(error); rejectInFlight?.(error); },
  };
}

export function useStudioStore(initial: StudioEnvelope, actor: ClientActor) {
  const ref = useRef<ReturnType<typeof createStudioController> | null>(null);
  if (!ref.current) ref.current = createStudioController(initial, actor.role);
  const controller = ref.current;
  controller.setRole(actor.role);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.activate();
    // 仅记住当前页面 ID；内容永远来自服务端，不读取旧原型 localStorage。
    try { const id = sessionStorage.getItem('form-studio:active-page'); if (id) void controller.update({ activePageId: selectedPage(controller.getEnvelope().state, id) }); } catch { /* 禁用浏览器存储不阻塞编辑。 */ }
    const remember = controller.subscribe(() => { try { sessionStorage.setItem('form-studio:active-page', controller.getEnvelope().state.activePageId); } catch { /* 同上。 */ } });
    const beforeUnload = (event: BeforeUnloadEvent) => { if (controller.hasUnsavedWork()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { remember(); window.removeEventListener('beforeunload', beforeUnload); controller.dispose(); };
  }, [controller]);
  return { state: snapshot.envelope.state, update: controller.update, runtime: { actor, ...snapshot, flush: controller.flush, mutate: controller.mutate, refresh: controller.refresh, recoverRejectedMutation: controller.recoverRejectedMutation, confirmMutationByReading:controller.confirmMutationByReading, accept: controller.accept, retry: controller.retry, getEnvelope: controller.getEnvelope, getSaveState:()=>controller.getSnapshot().saveState } satisfies Runtime };
}
