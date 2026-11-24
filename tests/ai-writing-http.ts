import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { StudioState, ContentEntry } from '../src/lib/types';
import type { RichNode } from '../src/lib/presentation-content';
import { richTextPlainText } from '../src/lib/presentation-content';
import { createContentColumn } from '../src/lib/content-columns';
import type { AiWritingProfile, AiWritingGenerateInput, AiWritingProposal, AiWritingReceipt, AiWritingSaveAttempt } from '../src/lib/ai-writing-types';
import type { AiWritingReuseResponse } from '../src/lib/ai-writing-reuse-types';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type Client = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };
// 写入回包可附回执；与GET比较的是完整CMS状态/revision/公开指针，不把操作回执当成GET字段。
const envelopeOnly = (value: Envelope) => ({ state: value.state, revision: value.revision, activeReleaseId: value.activeReleaseId });

/** 合成HTTP闭环实际走原生保存事务；模型仅本机响应，不调用真实供应商或发布测试内容。 */
export async function runAiWritingHttp(clients: { admin: Client; editor: Client; viewer: Client; anonymous: Client }, initial: Envelope, options: { dataDirectory: string }): Promise<Envelope> {
  const { admin, editor, viewer, anonymous } = clients;
  const missingSave = `aws-${randomUUID()}`;
  for (const [client, code] of [[anonymous, 401], [editor, 403], [viewer, 403]] as const) {
    await client.api('/api/ai/writing/profile', 'GET', undefined, code);
    await client.api('/api/ai/writing/proposals', 'POST', {}, code);
    await client.api('/api/ai/writing/save', 'POST', {}, code);
    await client.api(`/api/ai/writing/saves/${missingSave}`, 'GET', undefined, code);
    await client.api('/api/ai/writing/reuse', 'GET', undefined, code);
  }
  const wrongOrigin = await admin.fetch('/api/ai/writing/profile', { method: 'PATCH', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(wrongOrigin.status, 403); await wrongOrigin.body?.cancel();
  const modelKey = `writing-http-${randomUUID()}`; let calls = 0, response: unknown, malformed = false;
  const model = createServer((request, reply) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, `Bearer ${modelKey}`);
      const input = JSON.parse(body); assert.match(input.messages[0].content, /AI_CONTENT_WRITING/);
      assert.equal(JSON.stringify(input.messages).includes(modelKey), false, '服务密钥不能进入写作提示'); calls++;
      reply.writeHead(200, { 'Content-Type': 'application/json' }); reply.end(JSON.stringify({ choices: [{ message: { content: malformed ? 'not-json' : JSON.stringify(response) } }] }));
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address(); assert.ok(address && typeof address === 'object');
  let state = initial;
  try {
    const provider = await admin.api<{ revision: number }>('/api/ai/provider');
    await admin.api('/api/ai/provider', 'PATCH', { expectedRevision: provider.revision, enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'http-writing-json', apiKey: modelKey, allowLocal: true });
    let profile = await admin.api<AiWritingProfile>('/api/ai/writing/profile');
    const profileBody = (current: AiWritingProfile) => { const { revision, updatedAt: _, ...values } = current; return { ...values, expectedRevision: revision }; };
    profile = await admin.api<AiWritingProfile>('/api/ai/writing/profile', 'PATCH', { ...profileBody(profile), brandName: 'Synthetic writing brand', audience: 'Project buyers', market: 'Global', tone: 'Clear and factual', terminology: '', avoidedClaims: 'No unsupported certification or delivery promise', facts: [{ id: 'http-writing-fact', label: 'Confirmed material', text: 'The supplied sample uses aluminum.', source: 'Synthetic manually checked product sheet', confirmed: true, scope: 'company' }] });
    assert.equal(state.revision, (await admin.api<Envelope>('/api/studio')).revision, '写作资料只写私表');
    const product = state.state.products[0]; assert.ok(product, '既有HTTP基线需有合法产品及图片');
    const pendingHumanText = 'Human draft before AI, not previously saved.';
    const input: AiWritingGenerateInput = { target: { kind: 'product', id: product.id }, fields: [{ key: 'description', label: '产品介绍', kind: 'text', maxLength: 1500, before: pendingHumanText }], outputKeys: ['description'], task: 'product', sourceText: `Name: ${product.name}. User supplied aluminum sample.`, instruction: 'Write a concise factual introduction.', language: state.state.settings.language, audience: 'Project buyers', tone: 'Clear', factIds: ['http-writing-fact'], profileRevision: profile.revision };
    response = { fields: [{ key: 'description', after: 'A concise introduction to the supplied aluminum sample.' }], warnings: [], missingFacts: ['No certification evidence was provided.'], evidenceIds: ['http-writing-fact'] };
    const proposal = await admin.api<AiWritingProposal>('/api/ai/writing/proposals', 'POST', input, 201);
    assert.equal(calls, 1); assert.deepEqual(envelopeOnly(await admin.api<Envelope>('/api/studio')), envelopeOnly(state), '生成不提前保存表单');
    assert.equal(proposal.fields[0].before, pendingHumanText); assert.equal(proposal.fields[0].after, 'A concise introduction to the supplied aluminum sample.');
    await admin.api(`/api/ai/writing/proposals/${proposal.id}`); await admin.api('/api/ai/writing/proposals'); assert.equal(calls, 1, '读取不重发模型');
    const noFacts = { ...input, factIds: ['unknown-fact'] }; await admin.api('/api/ai/writing/proposals', 'POST', noFacts, 422); assert.equal(calls, 1, '非法依据在调用前拒绝');
    const after = proposal.fields[0].after as string;
    const productSaveInput = { saveAttemptId: `aws-${randomUUID()}`, expectedRevision: state.revision, patch: { products: state.state.products.map(item => item.id === product.id ? { ...item, description: after } : item) }, receipts: [{ proposalId: proposal.id, selectedKeys: ['description'], before: { description: pendingHumanText }, after: { description: after } }] };
    const productSaved = await admin.api<Envelope & { writingSaveAttempt: AiWritingSaveAttempt }>('/api/ai/writing/save', 'POST', productSaveInput); state = productSaved;
    assert.equal(state.state.products.find(item => item.id === product.id)?.description, after);
    assert.equal(productSaved.writingSaveAttempt.id, productSaveInput.saveAttemptId); assert.equal(productSaved.writingSaveAttempt.savedRevision, state.revision); assert.deepEqual(productSaved.writingSaveAttempt.proposalIds, [proposal.id]);
    const savedMarker = await admin.api<AiWritingSaveAttempt>(`/api/ai/writing/saves/${productSaveInput.saveAttemptId}`); assert.deepEqual(savedMarker, productSaved.writingSaveAttempt); assert.equal(calls, 1, '保存确认GET不发模型');
    await admin.api(`/api/ai/writing/saves/${missingSave}`, 'GET', undefined, 404);
    await admin.api('/api/ai/writing/saves/not-valid', 'GET', undefined, 422);
    await admin.api('/api/ai/writing/save', 'POST', { ...productSaveInput, expectedRevision: state.revision }, 409);
    assert.deepEqual(envelopeOnly(await admin.api<Envelope>('/api/studio')), envelopeOnly(state), '相同保存ID不能用于不同请求');
    const receipts = await admin.api<{ items: AiWritingReceipt[] }>(`/api/ai/writing/receipts?kind=product&id=${product.id}`);
    const receipt = receipts.items.find(item => item.proposalId === proposal.id); assert.ok(receipt);
    // 无关字段继续维护后撤销，只恢复AI前编辑区的值，不回退这次材料输入或公开版本。
    state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { products: state.state.products.map(item => item.id === product.id ? { ...item, material: 'HTTP unrelated material change' } : item) } });
    const laterBeforeDuplicate = envelopeOnly(state), duplicate = await admin.api<Envelope & { writingSaveAttempt: AiWritingSaveAttempt }>('/api/ai/writing/save', 'POST', productSaveInput);
    assert.deepEqual(envelopeOnly(duplicate), laterBeforeDuplicate, '相同保存请求只返回当前工作区，不能重放旧产品数组'); assert.equal(duplicate.writingSaveAttempt.savedRevision, savedMarker.savedRevision); assert.equal(duplicate.revision, state.revision);
    state = await admin.api<Envelope>(`/api/ai/writing/receipts/${receipt.id}/undo`, 'POST', { expectedRevision: state.revision });
    assert.equal(state.state.products.find(item => item.id === product.id)?.description, pendingHumanText); assert.equal(state.state.products.find(item => item.id === product.id)?.material, 'HTTP unrelated material change'); assert.equal(state.activeReleaseId, initial.activeReleaseId);
    const undone = await admin.api<Envelope>(`/api/ai/writing/receipts/${receipt.id}/undo`, 'POST', { expectedRevision: state.revision }); assert.equal(undone.revision, state.revision, '重复撤销幂等');

    const conflictProposal = await admin.api<AiWritingProposal>('/api/ai/writing/proposals', 'POST', input, 201);
    state = await admin.api<Envelope>('/api/ai/writing/save', 'POST', { expectedRevision: state.revision, patch: { products: state.state.products.map(item => item.id === product.id ? { ...item, description: after } : item) }, receipts: [{ proposalId: conflictProposal.id, selectedKeys: ['description'], before: { description: pendingHumanText }, after: { description: after } }] });
    const conflictReceipt = (await admin.api<{ items: AiWritingReceipt[] }>(`/api/ai/writing/receipts?kind=product&id=${product.id}`)).items.find(item => item.proposalId === conflictProposal.id); assert.ok(conflictReceipt);
    state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { products: state.state.products.map(item => item.id === product.id ? { ...item, description: 'Human edit after AI' } : item) } });
    await admin.api(`/api/ai/writing/receipts/${conflictReceipt.id}/undo`, 'POST', { expectedRevision: state.revision }, 409); assert.deepEqual(envelopeOnly(await admin.api<Envelope>('/api/studio')), envelopeOnly(state), '冲突不能覆盖人工改动');

    // 明确新增一次本机生成探针：人工后改使所有AI字段被过滤，仍需能核对这次保存成功。
    const zeroProposal = await admin.api<AiWritingProposal>('/api/ai/writing/proposals', 'POST', input, 201), zeroSaveId = `aws-${randomUUID()}`, humanAfterAi = 'Human text saved after editing the AI suggestion.';
    const zeroInput = { saveAttemptId: zeroSaveId, expectedRevision: state.revision, patch: { products: state.state.products.map(item => item.id === product.id ? { ...item, description: humanAfterAi } : item) }, receipts: [{ proposalId: zeroProposal.id, selectedKeys: ['description'], before: { description: pendingHumanText }, after: { description: after } }] };
    const zeroSaved = await admin.api<Envelope & { writingReceipts: AiWritingReceipt[]; writingSaveAttempt: AiWritingSaveAttempt }>('/api/ai/writing/save', 'POST', zeroInput); state = zeroSaved;
    assert.deepEqual(zeroSaved.writingReceipts, []); assert.deepEqual(zeroSaved.writingSaveAttempt.receiptIds, []); assert.equal((await admin.api<AiWritingSaveAttempt>(`/api/ai/writing/saves/${zeroSaveId}`)).savedRevision, state.revision); assert.equal((await admin.api<AiWritingProposal>(`/api/ai/writing/proposals/${zeroProposal.id}`)).savedRevision, state.revision);
    const beforeZeroRead = envelopeOnly(state), callsBeforeZeroRead = calls;
    assert.deepEqual(envelopeOnly(await admin.api<Envelope>('/api/ai/writing/save', 'POST', zeroInput)), beforeZeroRead); assert.equal(calls, callsBeforeZeroRead); assert.deepEqual(envelopeOnly(await admin.api<Envelope>('/api/studio')), beforeZeroRead);

    {
      // 仅在隔离数据库种另一账号的小型标记，沿既有HTTP夹具方式验owner，不新增登录或模型请求。
      const db = new Database(join(options.dataDirectory, 'studio.sqlite')), foreignId = `aws-${randomUUID()}`;
      try {
        const members = await admin.api<{ members: { id: string; email: string }[] }>('/api/members'), foreignActor = members.members.find(item => item.email === 'http-viewer@example.com'); assert.ok(foreignActor);
        const foreign = { ...zeroSaved.writingSaveAttempt, id: foreignId };
        db.prepare('INSERT INTO cms_ai_writing_save VALUES(?,?,?,?,?,?)').run(foreignId, foreignActor.id, 'f'.repeat(64), JSON.stringify(foreign), foreign.createdAt, foreign.expiresAt);
        await admin.api(`/api/ai/writing/saves/${foreignId}`, 'GET', undefined, 404);
        assert.deepEqual(envelopeOnly(await admin.api<Envelope>('/api/studio')), envelopeOnly(state), 'owner查询不改CMS');
      } finally { db.prepare('DELETE FROM cms_ai_writing_save WHERE id=?').run(foreignId); db.close(); }
    }

    const reuseBefore = envelopeOnly(state), reuseCalls = calls, reuse = await admin.api<AiWritingReuseResponse>(`/api/ai/writing/reuse?productId=${encodeURIComponent(product.id)}`);
    assert.ok(reuse.candidates.length > 0 && reuse.candidates.length <= 200); assert.ok(reuse.candidates.every(item => item.scope === 'product' && item.productId === product.id && item.sourceRef.kind === 'product')); assert.equal(calls, reuseCalls); assert.deepEqual(envelopeOnly(await admin.api<Envelope>('/api/studio')), reuseBefore);
    const selectedFact = reuse.candidates.find(item => item.sourceRef.locator === 'material'); assert.ok(selectedFact);
    const { id: _candidateId, ...factValues } = selectedFact;
    profile = await admin.api<AiWritingProfile>('/api/ai/writing/profile', 'PATCH', { ...profileBody(profile), facts: [...profile.facts, { ...factValues, id: 'http-writing-product-fact', confirmed: true }] });

    const column = createContentColumn('news', `writing-${randomUUID().slice(0, 8)}`, state.state.pages);
    state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { contentModels: [...(state.state.contentModels || []), column.model], pages: [...state.state.pages, column.page], editorData: { ...state.state.editorData, [column.page.id]: column.data } } });
    const bodyField = column.model.fields.find(field => field.key === 'body'); assert.ok(bodyField);
    const beforeDoc: RichNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Human unsaved article before AI.' }] }] };
    const afterDoc: RichNode = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Buyer information' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'A factual guide based on the supplied information.' }] }] };
    const entry: ContentEntry = { id: `entry-${randomUUID()}`, modelId: column.model.id, title: 'Human article title', status: 'draft', updated: '', customFields: {}, slug: `http-writing-${randomUUID().slice(0, 8)}` };
    const bodyKey = `customFields:${bodyField.id}`;
    response = { fields: [{ key: bodyKey, after: afterDoc }], warnings: [], missingFacts: [], evidenceIds: ['http-writing-fact'] };
    const articleInput = { ...input, profileRevision: profile.revision, factIds: ['http-writing-fact', 'http-writing-product-fact'], target: { kind: 'entry' as const, id: entry.id, modelId: column.model.id }, fields: [{ key: bodyKey, label: bodyField.label, kind: 'richtext', maxLength: 60000, before: beforeDoc }], outputKeys: [bodyKey], task: 'article' };
    const beforeUnselectedFact = calls; await admin.api('/api/ai/writing/proposals', 'POST', articleInput, 422); assert.equal(calls, beforeUnselectedFact, '文章未明确选关联产品时不能引用限定产品事实');
    const article = await admin.api<AiWritingProposal>('/api/ai/writing/proposals', 'POST', { ...articleInput, referenceProductIds: [product.id] }, 201);
    assert.deepEqual(article.referenceProductIds, [product.id]); assert.ok(article.evidence.some(item => item.id === 'http-writing-product-fact' && item.productId === product.id));
    assert.equal((await admin.api<Envelope>('/api/studio')).state.contentEntries?.some(item => item.id === entry.id), false, '新文章生成不创建记录');
    const generatedDoc = article.fields[0].after as RichNode;
    state = await admin.api<Envelope>('/api/ai/writing/save', 'POST', { expectedRevision: state.revision, patch: { contentEntries: [...(state.state.contentEntries || []), { ...entry, customFields: { [bodyField.id]: richTextPlainText(generatedDoc) }, richTextFields: { [bodyField.id]: generatedDoc } }] }, receipts: [{ proposalId: article.id, selectedKeys: [bodyKey], before: { [bodyKey]: beforeDoc }, after: { [bodyKey]: generatedDoc } }] });
    assert.equal(state.state.contentEntries?.find(item => item.id === entry.id)?.customFields[bodyField.id], richTextPlainText(generatedDoc));
    const articleReceipt = (await admin.api<{ items: AiWritingReceipt[] }>(`/api/ai/writing/receipts?kind=entry&id=${entry.id}`)).items.find(item => item.proposalId === article.id); assert.ok(articleReceipt);
    state = await admin.api<Envelope>(`/api/ai/writing/receipts/${articleReceipt.id}/undo`, 'POST', { expectedRevision: state.revision });
    const restored = state.state.contentEntries?.find(item => item.id === entry.id); assert.ok(restored); assert.deepEqual(restored.richTextFields?.[bodyField.id], beforeDoc); assert.equal(restored.title, entry.title);

    response = { fields: [{ key: 'description', after }], warnings: [], missingFacts: [] };
    const stale = await admin.api<AiWritingProposal>('/api/ai/writing/proposals', 'POST', { ...input, profileRevision: profile.revision }, 201);
    profile = await admin.api<AiWritingProfile>('/api/ai/writing/profile', 'PATCH', { ...profileBody(profile), tone: 'Updated preference requiring review' });
    assert.equal((await admin.api<AiWritingProposal>(`/api/ai/writing/proposals/${stale.id}`)).stale, true);
    await admin.api('/api/ai/writing/save', 'POST', { expectedRevision: state.revision, patch: { products: state.state.products.map(item => item.id === product.id ? { ...item, description: after } : item) }, receipts: [{ proposalId: stale.id, selectedKeys: ['description'], before: { description: 'Human edit after AI' }, after: { description: after } }] }, 409);
    assert.deepEqual(envelopeOnly(await admin.api<Envelope>('/api/studio')), envelopeOnly(state));
    malformed = true; const previousCalls = calls;
    await admin.api('/api/ai/writing/proposals', 'POST', { ...input, profileRevision: profile.revision }, 502); assert.equal(calls, previousCalls + 1, '坏JSON不自动重试'); assert.deepEqual(envelopeOnly(await admin.api<Envelope>('/api/studio')), envelopeOnly(state));
    assert.equal(calls, 6, '本组仅有6次明确本机模拟生成，不应有读取/保存引起的隐藏请求');
    return state;
  } finally { await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve())); }
}
