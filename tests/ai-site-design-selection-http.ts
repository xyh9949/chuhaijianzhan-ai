import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Data } from '@puckeditor/core';
import type { StudioState } from '../src/lib/types';
import type { AiSiteDesignPreview } from '../src/lib/ai-site-design-types';
import type { ExternalAiTokenSummary } from '../src/server/external-ai-tokens';

type Envelope = { state: StudioState; revision: number; activeReleaseId: string | null };
type Browser = { api<T = Record<string, unknown>>(path: string, method?: string, body?: unknown, expected?: number): Promise<T>; fetch(path: string, options?: RequestInit): Promise<Response> };
type MachineView = AiSiteDesignPreview & { status: 'pending' | 'applied' | 'undone'; selectionPreviews?: { designId: string; status: string }[] };
type Issued = { credential: ExternalAiTokenSummary; token: string };
const ids = ['http-selection-a', 'http-selection-b'];
const pageData = (id: string): Data => ({ root: { props: { title: id, brand: '', showChrome: 'no' } }, zones: {}, content: [
  { type: 'Heading', props: { id: `${id}-title`, level: 'h1', text: `Synthetic selection ${id}` } },
  { type: 'Text', props: { id: `${id}-copy`, text: `ORIGINAL_SELECTION_HTTP_${id}` } },
] } as Data);

/** SDK底层错误可能包含认证请求；报告只记录固定动作和数字协议类别。 */
async function sdk<T>(label: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { const code = typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : 'transport'; throw new Error(`Selection SDK ${label} failed (${code})`); }
}
async function connect(token: string, origin: string) {
  const client = new McpClient({ name: 'selection-http-regression', version: '1' });
  try { await sdk('initialize', () => client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', origin), { requestInit: { headers: { Authorization: `Bearer ${token}`, Connection: 'close' }, redirect: 'error' } }))); return client; }
  catch (error) { await client.close().catch(() => {}); throw error; }
}
async function tool<T>(client: McpClient, name: string, args: Record<string, unknown>, expectedError?: number): Promise<T> {
  const result = await sdk(name, () => client.callTool({ name, arguments: args }, undefined, { timeout: 15000 }));
  const text = (result.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text, value = result.structuredContent || (text ? JSON.parse(text) : undefined);
  if (expectedError === undefined) assert.notEqual(result.isError, true, `${name} should succeed`);
  else { assert.equal(result.isError, true, `${name} should reject`); assert.equal((value as { status: number }).status, expectedError); }
  return value as T;
}

/** 真HTTP及官方SDK验证选后新预览再人工采用；只用主包装器隔离实例，绝不访问正式3200。 */
export async function runAiSiteDesignSelectionHttp(input: { admin: Browser; editor: Browser; viewer: Browser; anonymous: Browser; origin: string; milestones: string[] }, initial: Envelope): Promise<Envelope> {
  const { admin, editor, viewer, anonymous, origin, milestones } = input, url = new URL(origin);
  assert.equal(url.hostname, '127.0.0.1'); assert.notEqual(url.port, '3200');
  const original = structuredClone(initial), clients: McpClient[] = [], credentials: Issued[] = [], designs: string[] = [];
  let state = initial, seeded = false, bodyFailure: unknown;
  const issue = async (name: string, scopes = ['read', 'propose']) => { const value = await admin.api<Issued>('/api/external-ai/tokens', 'POST', { name, scopes, pageIds: ids }, 201); credentials.push(value); return value; };
  const remember = <T extends AiSiteDesignPreview>(value: T) => { designs.push(value.designId); return value; };
  try {
    for (const [browser, status] of [[anonymous, 401], [editor, 403], [viewer, 403]] as const) await browser.api('/api/ai/site-designs/select', 'POST', {}, status);
    assert.equal((await admin.fetch('/api/ai/site-designs/select', { method: 'POST', headers: { Origin: 'https://untrusted.example.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const pages = ids.map((id, index) => ({ id, title: `Selection HTTP ${index + 1}`, slug: `/http-selection-${index + 1}`, status: 'draft' as const, type: '普通页面', locale: initial.state.settings.language, updated: '' }));
    state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { pages: [...state.state.pages, ...pages], editorData: { ...state.state.editorData, ...Object.fromEntries(ids.map(id => [id, pageData(id)])) } } }); seeded = true;
    const baseline = structuredClone(state), provider = await admin.api('/api/ai/provider'); assert.equal(provider.enabled, false); assert.equal(provider.hasApiKey, false);
    const full = await issue('Selection HTTP machine'), other = await issue('Selection HTTP other'), readOnly = await issue('Selection HTTP read', ['read']);
    const machine = await connect(full.token, origin), otherMachine = await connect(other.token, origin), reader = await connect(readOnly.token, origin); clients.push(machine, otherMachine, reader);
    assert.ok((await sdk('list-tools', () => machine.listTools())).tools.some(tool => tool.name === 'site_design_select'));
    assert.equal((await sdk('read-tools', () => reader.listTools())).tools.some(tool => tool.name === 'site_design_select'), false);
    const request = { expectedRevision: state.revision, instruction: '同时优化两个合成页面，随后只采用满意页面，不改其他设计和资料。', targets: { pageIds: ids, header: false, footer: false, navigation: false, style: false }, preserveText: false };
    const source = remember(await tool<MachineView>(machine, 'site_design_propose', { requestId: 'http-selection-source', request, proposal: { summary: '准备两个页面的可选择候选。', warnings: [], operations: ids.map(id => ({ kind: 'page', pageId: id, operations: [{ kind: 'text', id: `${id}-title`, text: `AI_HEADING_HTTP_${id}` }, { kind: 'text', id: `${id}-copy`, text: `AI_SELECTION_HTTP_${id}` }] })) } }));
    assert.deepEqual(source.selectionUnits?.map(unit => unit.id).sort(), ids.map(id => `page:${id}`).sort()); assert.deepEqual(await admin.api('/api/studio'), baseline);

    // 浏览器产生的派生预览也需继承机器归属，避免外部AI看不到用户选择结果。
    const browserSelection = remember(await admin.api<AiSiteDesignPreview>('/api/ai/site-designs/select', 'POST', { designId: source.designId, expectedRevision: state.revision, unitIds: [`page:${ids[0]}`] }, 201));
    assert.equal((await tool<MachineView>(machine, 'site_design_status', { designId: browserSelection.designId })).status, 'pending');
    const sourceAfterBrowserSelection = await tool<MachineView>(machine, 'site_design_status', { designId: source.designId }); assert.equal(sourceAfterBrowserSelection.status, 'pending'); assert.ok(sourceAfterBrowserSelection.selectionPreviews?.some(item => item.designId === browserSelection.designId));
    assert.deepEqual(await admin.api('/api/studio'), baseline);
    await tool(otherMachine, 'site_design_select', { requestId: 'http-selection-other', designId: source.designId, expectedRevision: state.revision, unitIds: [`page:${ids[0]}`] }, 404);
    assert.equal((await fetch(`${origin}/api/ai/site-designs/select`, { method: 'POST', headers: { Authorization: `Bearer ${full.token}`, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ designId: source.designId, expectedRevision: state.revision, unitIds: [`page:${ids[0]}`] }) })).status, 401);

    const manuallyChanged = structuredClone(state.state.editorData[ids[1]]) as Data; manuallyChanged.content[1].props.text = 'MANUAL_UNSELECTED_HTTP';
    state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { editorData: { ...state.state.editorData, [ids[1]]: manuallyChanged } } });
    const current = structuredClone(state), selectionInput = { requestId: 'http-selection-machine', designId: source.designId, expectedRevision: state.revision, unitIds: [`page:${ids[0]}`] };
    const selected = remember(await tool<MachineView>(machine, 'site_design_select', selectionInput)); assert.notEqual(selected.designId, source.designId); assert.equal(selected.baseRevision, state.revision); assert.equal(selected.status, 'pending');
    assert.deepEqual(selected.selection, { sourceDesignId: source.designId, unitIds: [`page:${ids[0]}`] }); assert.deepEqual(await admin.api('/api/studio'), current);
    assert.equal((await tool<MachineView>(machine, 'site_design_select', selectionInput)).designId, selected.designId);
    await tool(machine, 'site_design_select', { ...selectionInput, unitIds: [`page:${ids[1]}`] }, 409);
    await tool(machine, 'site_design_select', { ...selectionInput, requestId: 'http-selection-conflicting-resource', unitIds: [`page:${ids[1]}`] }, 409);
    await tool(machine, 'site_design_select', { ...selectionInput, requestId: 'http-selection-unsupported-unit', unitIds: ['header'] }, 422);
    await tool(otherMachine, 'site_design_status', { designId: selected.designId }, 404);
    const afterA = selected.previewPages.find(page => page.pageId === ids[0])!, afterB = selected.previewPages.find(page => page.pageId === ids[1])!;
    assert.ok(afterA.available && afterB.available); const firstHtml = await (await admin.fetch(afterA.afterUrl!)).text(), secondHtml = await (await admin.fetch(afterB.afterUrl!)).text();
    assert.match(firstHtml, /AI_SELECTION_HTTP_http-selection-a/); assert.match(secondHtml, /MANUAL_UNSELECTED_HTTP/); assert.doesNotMatch(secondHtml, /AI_SELECTION_HTTP_http-selection-b/);
    assert.equal((await anonymous.fetch(afterA.afterUrl!)).status, 404); assert.equal((await viewer.fetch(afterA.afterUrl!)).status, 404);
    const review = await tool<{ reviewUrl: string; requiresBrowserConfirmation: boolean }>(machine, 'site_design_review', { designId: selected.designId, action: 'apply' }); assert.equal(new URL(review.reviewUrl).searchParams.get('externalDesign'), selected.designId); assert.equal(review.requiresBrowserConfirmation, true); assert.deepEqual(await admin.api('/api/studio'), current);

    state = await admin.api<Envelope>('/api/ai/site-designs/apply', 'POST', { designId: selected.designId, expectedRevision: state.revision });
    assert.match(JSON.stringify(state.state.editorData[ids[0]]), /AI_SELECTION_HTTP_http-selection-a/); assert.deepEqual(state.state.editorData[ids[1]], manuallyChanged); assert.deepEqual(state.state.theme, baseline.state.theme); assert.deepEqual(state.state.siteLayout, baseline.state.siteLayout); assert.equal(state.activeReleaseId, baseline.activeReleaseId);
    const sourceAfterApply = await tool<MachineView>(machine, 'site_design_status', { designId: source.designId }); assert.equal(sourceAfterApply.status, 'pending'); assert.ok(sourceAfterApply.selectionPreviews?.some(item => item.designId === selected.designId && item.status === 'applied')); assert.equal((await tool<MachineView>(machine, 'site_design_status', { designId: selected.designId })).status, 'applied');
    const freshUnselected = structuredClone(state.state.editorData[ids[1]]) as Data; freshUnselected.content[1].props.text = 'MANUAL_AFTER_SELECTION_APPLY_HTTP';
    state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { editorData: { ...state.state.editorData, [ids[1]]: freshUnselected } } });
    state = await admin.api<Envelope>('/api/ai/site-designs/undo', 'POST', { designId: selected.designId, expectedRevision: state.revision });
    assert.deepEqual(state.state.editorData[ids[0]], baseline.state.editorData[ids[0]]); assert.deepEqual(state.state.editorData[ids[1]], freshUnselected); assert.equal(state.activeReleaseId, baseline.activeReleaseId); assert.equal((await tool<MachineView>(machine, 'site_design_status', { designId: selected.designId })).status, 'undone'); assert.equal((await tool<MachineView>(machine, 'site_design_status', { designId: source.designId })).status, 'pending');
    assert.deepEqual(await admin.api('/api/ai/provider'), provider);
    milestones.push('整站AI按页面/全站区域选择生成新真实预览、原候选保持、未选手改重基准、MCP幂等/归属与浏览器选择继承、确认后精确采用撤销、零站内模型调用通过');
    // 同页保留原标题、只采用正文；冻结预览与真正采用后布局必须一致。
    const partialBaseline = await admin.api<Envelope>('/api/studio'), section = source.sectionUnits?.find(unit => unit.pageIds[0] === ids[0] && unit.nodeIds.includes(`${ids[0]}-copy`)); assert.ok(section);
    const partial = remember(await admin.api<AiSiteDesignPreview>('/api/ai/site-designs/select', 'POST', { designId: source.designId, expectedRevision: state.revision, unitIds: [section.id] }, 201));
    assert.deepEqual(await admin.api('/api/studio'), partialBaseline);
    const partialPage = partial.previewPages.find(page => page.pageId === ids[0])!, partialHtml = await (await admin.fetch(partialPage.afterUrl!)).text();
    assert.match(partialHtml, /AI_SELECTION_HTTP_http-selection-a/); assert.match(partialHtml, /Synthetic selection http-selection-a/); assert.doesNotMatch(partialHtml, /AI_HEADING_HTTP_http-selection-a/);
    state = await admin.api<Envelope>('/api/ai/site-designs/apply', 'POST', { designId: partial.designId, expectedRevision: state.revision });
    const partialData = state.state.editorData[ids[0]] as Data; assert.equal(partialData.content[0].props.text, (partialBaseline.state.editorData[ids[0]] as Data).content[0].props.text); assert.equal(partialData.content[1].props.text, `AI_SELECTION_HTTP_${ids[0]}`); assert.equal(state.activeReleaseId, partialBaseline.activeReleaseId);
    state = await admin.api<Envelope>('/api/ai/site-designs/undo', 'POST', { designId: partial.designId, expectedRevision: state.revision }); assert.deepEqual(state.state.editorData, partialBaseline.state.editorData);
    milestones.push('AI页面内区块选择：原生HTTP新组合真实预览、只采用正文并保留标题与其他页、人工确认与安全撤销通过');
    // 新增/删除在同一位置形成替换组，独立正文不跟随；确认前核对真实HTTP渲染。
    const structuralBaseline = await admin.api<Envelope>('/api/studio');
    const structural = remember(await tool<MachineView>(machine, 'site_design_propose', { requestId: 'http-structural-source', request: { expectedRevision: structuralBaseline.revision, instruction: '替换首页标题区，正文独立调整，允许只选择满意的关联结构。', targets: { pageIds: [ids[0]], header: false, footer: false, navigation: false, style: false }, preserveText: false }, proposal: { summary: '关联替换与独立正文。', warnings: [], operations: [{ kind: 'page', pageId: ids[0], operations: [
      { kind: 'remove', id: `${ids[0]}-title` }, { kind: 'insert', parentId: '$page', index: 0, node: { tempId: 'new-http-structure', type: 'Heading', level: 'h1', text: 'HTTP_STRUCTURAL_REPLACEMENT' } },
      { kind: 'text', id: `${ids[0]}-copy`, text: 'HTTP_STRUCTURAL_COPY_UNSELECTED' },
    ] }] } }));
    const structureUnit = structural.sectionUnits?.find(unit => unit.nodeIds.includes(`${ids[0]}-title`)); assert.ok(structureUnit); assert.match(structureUnit.id, /^section:g1:/); assert.equal(structureUnit.nodeIds.length, 2);
    const structureSelected = remember(await admin.api<AiSiteDesignPreview>('/api/ai/site-designs/select', 'POST', { designId: structural.designId, expectedRevision: structuralBaseline.revision, unitIds: [structureUnit.id] }, 201));
    assert.deepEqual(await admin.api('/api/studio'), structuralBaseline);
    const structureHtml = await (await admin.fetch(structureSelected.previewPages.find(page => page.pageId === ids[0])!.afterUrl!)).text();
    assert.match(structureHtml, /HTTP_STRUCTURAL_REPLACEMENT/); assert.match(structureHtml, /ORIGINAL_SELECTION_HTTP_http-selection-a/); assert.doesNotMatch(structureHtml, /HTTP_STRUCTURAL_COPY_UNSELECTED/);
    state = await admin.api<Envelope>('/api/ai/site-designs/apply', 'POST', { designId: structureSelected.designId, expectedRevision: structuralBaseline.revision });
    assert.equal((state.state.editorData[ids[0]] as Data).content[0].props.text, 'HTTP_STRUCTURAL_REPLACEMENT'); assert.equal(state.activeReleaseId, structuralBaseline.activeReleaseId);
    state = await admin.api<Envelope>('/api/ai/site-designs/undo', 'POST', { designId: structureSelected.designId, expectedRevision: state.revision }); assert.deepEqual(state.state.editorData, structuralBaseline.state.editorData);
    milestones.push('AI关联结构组：新增删除真实编译、服务单位不可拆、选组真实HTTP预览、独立正文保持、确认采用撤销通过');
    // 稳定容器内只选标题；模型生成之后的说明手改不能被整块采用语义覆盖。
    const beforeFine = await admin.api<Envelope>('/api/studio'), originalData = beforeFine.state.editorData[ids[0]] as Data;
    const fineData = { ...originalData, content: [{ type: 'Container', props: { id: 'http-fine-root', nodeLabel: '精细选择首屏', content: originalData.content } }] } as Data;
    state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: beforeFine.revision, patch: { editorData: { ...beforeFine.state.editorData, [ids[0]]: fineData } } });
    const fineSource = remember(await tool<MachineView>(machine, 'site_design_propose', { requestId: 'http-fine-source', request: { expectedRevision: state.revision, instruction: '分别优化首屏的标题和说明，让用户能只采用满意内容。', targets: { pageIds: [ids[0]], header: false, footer: false, navigation: false, style: false }, preserveText: false }, proposal: { summary: '同一首屏内的独立标题和说明。', warnings: [], operations: [{ kind: 'page', pageId: ids[0], operations: [{ kind: 'text', id: `${ids[0]}-title`, text: 'HTTP_FINE_TITLE' }, { kind: 'text', id: `${ids[0]}-copy`, text: 'HTTP_FINE_COPY_UNSELECTED' }] }] } }));
    const fineUnit = fineSource.detailUnits?.find(unit => unit.nodeIds.includes(`${ids[0]}-title`)); assert.ok(fineUnit); assert.match(fineUnit.id, /^detail:d1:/);
    const manualFine = structuredClone(fineData); manualFine.content[0].props.content[1].props.text = 'HTTP_FINE_MANUAL_SIBLING';
    state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: state.revision, patch: { editorData: { ...state.state.editorData, [ids[0]]: manualFine } } });
    const fineBaseline = await admin.api<Envelope>('/api/studio');
    await tool(machine, 'site_design_select', { requestId: 'http-fine-overlap', designId: fineSource.designId, expectedRevision: state.revision, unitIds: [fineUnit.parentId, fineUnit.id] }, 422);
    const fineSelected = remember(await tool<MachineView>(machine, 'site_design_select', { requestId: 'http-fine-selection', designId: fineSource.designId, expectedRevision: state.revision, unitIds: [fineUnit.id] }));
    assert.deepEqual(await admin.api('/api/studio'), fineBaseline); assert.deepEqual(fineSelected.selection?.unitIds, [fineUnit.id]);
    const fineHtml = await (await admin.fetch(fineSelected.previewPages.find(page => page.pageId === ids[0])!.afterUrl!)).text(); assert.match(fineHtml, /HTTP_FINE_TITLE/); assert.match(fineHtml, /HTTP_FINE_MANUAL_SIBLING/); assert.doesNotMatch(fineHtml, /HTTP_FINE_COPY_UNSELECTED/);
    state = await admin.api<Envelope>('/api/ai/site-designs/apply', 'POST', { designId: fineSelected.designId, expectedRevision: fineBaseline.revision }); assert.equal(state.activeReleaseId, fineBaseline.activeReleaseId);
    state = await admin.api<Envelope>('/api/ai/site-designs/undo', 'POST', { designId: fineSelected.designId, expectedRevision: state.revision }); assert.deepEqual(state.state.editorData, fineBaseline.state.editorData);
    milestones.push('AI区块内部细分：官方MCP真实单位与父子拒绝、只选标题保留生成后兄弟手改、真实HTTP预览、确认采用撤销通过');
  } catch (error) { bodyFailure = error; throw error; }
  finally {
    for (const client of clients) await client.close().catch(() => {}); let failures = 0;
    for (const id of [...designs].reverse()) try { await admin.api(`/api/ai/site-designs/${id}`, 'DELETE'); } catch { failures++; }
    for (const item of credentials) try { await admin.api(`/api/external-ai/tokens/${item.credential.id}`, 'DELETE'); } catch { failures++; }
    if (seeded) try { const latest = await admin.api<Envelope>('/api/studio'); state = await admin.api<Envelope>('/api/studio', 'PATCH', { expectedRevision: latest.revision, patch: { pages: original.state.pages, editorData: original.state.editorData } }); } catch { failures++; }
    if (failures && !bodyFailure) throw new Error(`Selection HTTP cleanup failed (${failures} steps)`);
  }
  assert.deepEqual(state.state.pages, original.state.pages); assert.deepEqual(state.state.editorData, original.state.editorData); assert.equal(state.activeReleaseId, original.activeReleaseId); return state;
}
