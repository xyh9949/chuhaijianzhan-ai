import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { createStudioController, RequestError, type StudioEnvelope } from '../src/lib/studio-client';
import { initialState } from '../src/lib/demo';
import type { StudioState } from '../src/lib/types';

function fixture(): StudioEnvelope { return { revision: 0, activeReleaseId: null, state: { ...structuredClone(initialState), activePageId: '' } }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function saved(envelope: StudioEnvelope, patch: Partial<StudioState>): StudioEnvelope { return { ...structuredClone(envelope), revision: envelope.revision + 1, state: { ...structuredClone(envelope.state), ...structuredClone(patch) } }; }

test('明确读取完成记录后的恢复只读服务器，不能重发丢失响应的写入',async()=>{
  const initial=fixture(),server=saved(initial,{});let writes=0,reads=0;
  const controller=createStudioController(initial,'admin',{patch:async env=>env,read:async()=>{reads++;return server;}});
  await assert.rejects(controller.mutate(async()=>{writes++;throw new Error('lost response');}));await nextTurn();
  await controller.confirmMutationByReading(value=>value.revision===server.revision);await nextTurn();
  assert.equal(writes,1);assert.equal(reads,1);assert.equal(controller.getSnapshot().saveState,'saved');assert.equal(controller.getEnvelope().revision,server.revision);controller.dispose();
});
test('核对发现后改或期间输入时保留错误和原输入，不清待提交内容',async()=>{
  const initial=fixture(),gate=deferred<StudioEnvelope>();let reads=0;
  const controller=createStudioController(initial,'admin',{patch:async env=>env,read:()=>{reads++;return gate.promise;}});
  await assert.rejects(controller.mutate(async()=>{throw new Error('lost response');}));await nextTurn();
  const checking=controller.confirmMutationByReading(()=>true);await nextTurn();
  await assert.rejects(controller.update({settings:{...initial.state.settings,name:'核对期间的新输入'}}));
  gate.resolve(saved(initial,{}));await assert.rejects(checking,/变化/);assert.equal(reads,1);assert.equal(controller.getSnapshot().saveState,'error');assert.equal(controller.getEnvelope().state.settings.name,'核对期间的新输入');controller.dispose();
});
test('相同操作已保存但当前记录不一致时不能解除保护',async()=>{
  const initial=fixture();const controller=createStudioController(initial,'admin',{patch:async env=>env,read:async()=>saved(initial,{})});
  await assert.rejects(controller.mutate(async()=>{throw new Error('lost response');}));await nextTurn();
  await assert.rejects(controller.confirmMutationByReading(()=>false),/变化/);assert.equal(controller.getEnvelope().revision,initial.revision);assert.equal(controller.getSnapshot().saveState,'error');controller.dispose();
});

test('explicit recovery of a rejected mutation only reads current state and never replays the old request', async () => {
  const initial = fixture(), server = saved(initial, { settings: { ...initial.state.settings, name: 'Other window version' } });
  let attempts = 0, reads = 0; const patchVersions: number[] = [];
  const controller = createStudioController(initial, 'admin', { patch: async (env, patch) => { patchVersions.push(env.revision); return saved(env, patch); }, read: async () => { reads++; return server; } });
  await assert.rejects(controller.mutate(async () => { attempts++; throw new RequestError(409, 'writing evidence changed'); }), /writing evidence/);
  await nextTurn(); assert.equal(controller.getSnapshot().saveState, 'error');
  await controller.recoverRejectedMutation(); await nextTurn();
  assert.equal(attempts, 1); assert.equal(reads, 1); assert.deepEqual(patchVersions, []); assert.equal(controller.getSnapshot().saveState, 'saved');
  assert.equal(controller.getEnvelope().state.settings.name, 'Other window version');
  const next = controller.update({ settings: { ...server.state.settings, name: 'Explicit later save' } }); await controller.flush(); await next;
  assert.deepEqual(patchVersions, [server.revision]); assert.equal(controller.getEnvelope().state.settings.name, 'Explicit later save'); controller.dispose();
});

test('scoped rejected recovery cannot discard pending optimistic content', async () => {
  const initial = fixture(); let reads = 0;
  const controller = createStudioController(initial, 'admin', { patch: async () => { throw new RequestError(409, 'another window'); }, read: async () => { reads++; return initial; } });
  const change = controller.update({ settings: { ...initial.state.settings, name: 'Must retain this unsaved input' } });
  await assert.rejects(controller.flush(), /another window/); await assert.rejects(change, /another window/); await nextTurn();
  await assert.rejects(controller.recoverRejectedMutation(), /待确认|未保存/);
  assert.equal(reads, 0); assert.equal(controller.getEnvelope().state.settings.name, 'Must retain this unsaved input'); assert.equal(controller.getSnapshot().saveState, 'error'); controller.dispose();
});

test('uncertain mutations retain the original export and reload protection', async () => {
  const initial = fixture(); let attempts = 0, reads = 0;
  const controller = createStudioController(initial, 'admin', { patch: async (env, patch) => saved(env, patch), read: async () => { reads++; return initial; } });
  await assert.rejects(controller.mutate(async () => { attempts++; throw new Error('connection lost'); }), /connection lost/); await nextTurn();
  await assert.rejects(controller.recoverRejectedMutation(), /待确认|未保存/); await assert.rejects(controller.retry(), /尚未确认/);
  assert.equal(reads, 0); assert.equal(attempts, 1); assert.equal(controller.getSnapshot().saveState, 'error'); controller.dispose();
});

test('upload pauses PATCH and rebases edits by ID without losing the new media', async () => {
  const initial = fixture(), upload = deferred<StudioEnvelope>(), calls: number[] = [];
  const controller = createStudioController(initial, 'admin', { patch: async (env, patch) => { calls.push(env.revision); return saved(env, patch); }, read: async () => initial });
  const mutation = controller.mutate(async (env) => { assert.equal(env.revision, 0); return upload.promise; });
  await nextTurn();
  const media = controller.getEnvelope().state.media.map((item, index) => index === 0 ? { ...item, alt: 'typed while uploading' } : item);
  const typing = controller.update({ media });
  let flushed = false;
  const flush = controller.flush().then(() => { flushed = true; });
  await nextTurn();
  assert.equal(flushed, false); assert.deepEqual(calls, []); assert.equal(controller.getSnapshot().isMutating, true);
  const uploaded = { ...initial.state.media[0], id: 'new_upload', url: '/api/media/new_upload' };
  upload.resolve(saved(initial, { media: [...initial.state.media, uploaded] }));
  await Promise.all([mutation, typing, flush]);
  assert.deepEqual(calls, [1]);
  assert.equal(controller.getEnvelope().revision, 2);
  assert.equal(controller.getEnvelope().state.media[0].alt, 'typed while uploading');
  assert.equal(controller.getEnvelope().state.media.some((item) => item.id === 'new_upload'), true);
  assert.equal(controller.getSnapshot().saveState, 'saved'); controller.dispose();
});

test('queued mutations execute after pending saves with the latest revision and flush has no self wait', async () => {
  const initial = fixture(), patchGate = deferred<StudioEnvelope>(), order: string[] = [];
  const controller = createStudioController(initial, 'admin', { patch: async (env, patch) => { order.push(`patch:${env.revision}`); return patchGate.promise; }, read: async () => initial });
  const settings = { ...initial.state.settings, name: 'Edited' };
  const save = controller.update({ settings });
  const first = controller.mutate(async (env) => { order.push(`first:${env.revision}`); return saved(env, {}); });
  const second = controller.mutate(async (env) => { order.push(`second:${env.revision}`); return saved(env, {}); });
  const flushed = controller.flush(); await nextTurn();
  assert.deepEqual(order, ['patch:0']);
  patchGate.resolve(saved(initial, { settings }));
  await Promise.all([save, first, second, flushed]);
  assert.deepEqual(order, ['patch:0', 'first:1', 'second:2']);
  await controller.flush(); assert.equal(controller.getEnvelope().revision, 3); controller.dispose();
});

test('409 keeps optimistic input exportable, rejects queued side effects, and cannot be blindly retried', async () => {
  const initial = fixture(); let mutations = 0;
  const controller = createStudioController(initial, 'admin', { patch: async () => { throw new RequestError(409, 'conflict'); }, read: async () => initial });
  const save = controller.update({ settings: { ...initial.state.settings, name: 'Keep my text' } });
  const mutation = controller.mutate(async (env) => { mutations++; return env; });
  await assert.rejects(controller.flush(), /conflict/); await assert.rejects(save); await assert.rejects(mutation);
  assert.equal(mutations, 0); assert.equal(controller.getEnvelope().state.settings.name, 'Keep my text');
  assert.equal(controller.getSnapshot().saveState, 'error'); await assert.rejects(controller.retry(), /导出/); controller.dispose();
});

test('422 correction can be submitted without reloading or losing local fields', async () => {
  const initial = fixture(); let calls = 0;
  const controller = createStudioController(initial, 'admin', { patch: async (env, patch) => { if (++calls === 1) throw new RequestError(422, 'invalid'); return saved(env, patch); }, read: async () => initial });
  const invalid = controller.update({ settings: { ...initial.state.settings, name: '' } });
  await assert.rejects(controller.flush(), /invalid/); await assert.rejects(invalid);
  const corrected = controller.update({ settings: { ...controller.getEnvelope().state.settings, name: 'Corrected' } });
  await controller.flush(); await corrected;
  assert.equal(calls, 2); assert.equal(controller.getEnvelope().state.settings.name, 'Corrected'); controller.dispose();
});

test('refresh discards confirmed old input but keeps fields typed during its request', async () => {
  const initial = fixture(), read = deferred<StudioEnvelope>();
  const controller = createStudioController(initial, 'admin', { patch: async (env, patch) => saved(env, patch), read: () => read.promise });
  const discarded = controller.update({ settings: { ...initial.state.settings, name: 'Discard this name' } });
  const refreshed = controller.refresh(); await assert.rejects(discarded, /放弃/); await nextTurn();
  const later = controller.update({ settings: { ...controller.getEnvelope().state.settings, description: 'Keep this new description' } });
  const server = saved(initial, { settings: { ...initial.state.settings, name: 'Server name', description: 'Server description' } });
  read.resolve(server); await refreshed; await controller.flush(); await later;
  assert.equal(controller.getEnvelope().state.settings.name, 'Server name');
  assert.equal(controller.getEnvelope().state.settings.description, 'Keep this new description'); controller.dispose();
});

test('a side inquiry response survives a draft PATCH that started earlier', async () => {
  const initial = fixture(), gate = deferred<StudioEnvelope>();
  const controller = createStudioController(initial, 'admin', { patch: () => gate.promise, read: async () => initial });
  const settings = { ...initial.state.settings, name: 'New name' };
  const update = controller.update({ settings }), flush = controller.flush(); await nextTurn();
  const live = controller.getEnvelope();
  controller.accept({ ...live, state: { ...live.state, inquiries: live.state.inquiries.map((item, index) => index ? item : { ...item, status: 'contacted' }) } });
  gate.resolve(saved(initial, { settings })); await Promise.all([update, flush]);
  assert.equal(controller.getEnvelope().state.inquiries[0].status, 'contacted'); controller.dispose();
});

test('unmount cancels the debounce without a background write and missing selected page falls back to home', async () => {
  const initial = fixture(); initial.state.activePageId = 'deleted'; let calls = 0;
  const controller = createStudioController(initial, 'admin', { patch: async (env) => { calls++; return env; }, read: async () => initial });
  assert.equal(controller.getEnvelope().state.activePageId, 'home');
  const save = controller.update({ settings: { ...initial.state.settings, name: 'Pending' } });
  assert.equal(controller.hasUnsavedWork(), true); controller.dispose(); await assert.rejects(save, /关闭/);
  await delay(500); assert.equal(calls, 0);
});

test('invalid external 422 rejects that operation without blocking the next upload or reporting a draft error', async () => {
  const initial = fixture();
  const controller = createStudioController(initial, 'admin', { patch: async (env, patch) => saved(env, patch), read: async () => initial });
  await assert.rejects(controller.mutate(async () => { throw new RequestError(422, 'invalid image'); }), /invalid image/);
  await controller.mutate(async (env) => saved(env, {})); await controller.flush();
  assert.equal(controller.getEnvelope().revision, 1);
  assert.equal(controller.getSnapshot().saveState, 'saved'); assert.equal(controller.getSnapshot().error, ''); controller.dispose();
});

test('uncertain external network failure requires reload and never silently replays the operation', async () => {
  const initial = fixture(); let operations = 0;
  const controller = createStudioController(initial, 'admin', { patch: async (env, patch) => saved(env, patch), read: async () => saved(initial, {}) });
  await assert.rejects(controller.mutate(async () => { operations++; throw new Error('connection lost'); }), /connection lost/);
  await assert.rejects(controller.retry(), /重新加载/);
  await assert.rejects(controller.mutate(async (env) => { operations++; return env; }), /尚未确认/);
  assert.equal(operations, 1);
  await controller.refresh(); await controller.flush();
  assert.equal(controller.getEnvelope().revision, 1); assert.equal(controller.getSnapshot().saveState, 'saved'); controller.dispose();
});
