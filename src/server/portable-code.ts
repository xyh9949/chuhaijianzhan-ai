import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import selectorParser from 'postcss-selector-parser';
import { parse } from 'acorn';
import { designClassName } from '../lib/responsive-style';
import type { CodeSnippet } from '../lib/types';
import { ApiError } from './http';
import { validateSnippet } from './site-code';

export type CodeReferenceMaps = { nodes?: Map<string, string>; paths?: Map<string, string>; attributes?: Map<string, Map<string, string[]>>; queryKeys?: Map<string, string>; terms?: Map<string, string> };
type Ast = { type: string; start: number; end: number; [key: string]: unknown };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function stringNode(v: unknown): { start: number; end: number; value: string } | undefined {
  if (!record(v) || typeof v.start !== 'number' || typeof v.end !== 'number') return;
  if (v.type === 'Literal' && typeof v.value === 'string') return { start: v.start, end: v.end, value: v.value };
  if (v.type === 'TemplateLiteral' && Array.isArray(v.expressions) && !v.expressions.length && Array.isArray(v.quasis)) { const first = v.quasis[0] as { value?: { cooked?: string } }; if (typeof first?.value?.cooked === 'string') return { start: v.start, end: v.end, value: first.value.cooked }; }
}
/** 只改写明确的站内路径；普通文字与颜色#fff不会因为节点名相同被当作ID替换。 */
export function remapCodeUrl(value: string, maps: CodeReferenceMaps) {
  if (!value.startsWith('/')) return value;
  const match = /^([^?#]+)(\?[^#]*)?(#.*)?$/.exec(value); if (!match) return value;
  const base = maps.paths?.get(match[1]); if (!base) return value;
  const hash = match[3]?.slice(1), fragment = hash ? maps.nodes?.get(hash) || hash : undefined;
  let query = match[2] || '';
  if (query && maps.queryKeys) { const original = new URLSearchParams(query.slice(1)), updated = new URLSearchParams(); for (const [key, value] of original) { const nextKey = maps.queryKeys.get(key) || key; updated.append(nextKey, nextKey !== key && key.startsWith('term_') ? maps.terms?.get(value) || value : value); } query = `?${updated}`; }
  return base + query + (fragment ? `#${fragment}` : '');
}
const classMaps = new WeakMap<CodeReferenceMaps, Map<string,string>>();
function selector(value: string, maps: CodeReferenceMaps) {
  let classes = classMaps.get(maps); if (!classes) { classes = new Map([...maps.nodes || []].map(([from, to]) => [designClassName(from), designClassName(to)])); classMaps.set(maps, classes); }
  return selectorParser(root => {
    root.walkIds(node => { const to = maps.nodes?.get(node.value); if (to) node.value = to; });
    root.walkClasses(node => { const to = classes.get(node.value); if (to) node.value = to; });
    root.walkAttributes(node => {
      if (!node.value) return;
      const declared = maps.attributes?.get(node.attribute)?.get(node.value);
      if (declared?.length) { if (declared.length === 1) node.setValue(declared[0], { quoteMark: node.quoteMark || '"' }); else if (node.operator === '=') node.replaceWith(selectorParser().astSync(`:is(${declared.map(value => `[${node.attribute}="${value}"]`).join(',')})`, { maxNestingDepth: 64 }).first.first!); return; }
      const to = ['id', 'for'].includes(node.attribute) ? maps.nodes?.get(node.value) : node.attribute === 'class' ? node.value.split(/\s+/).map(v => classes.get(v) || v).join(' ') : ['href', 'src'].includes(node.attribute) ? node.value.startsWith('#') && maps.nodes?.has(node.value.slice(1)) ? `#${maps.nodes.get(node.value.slice(1))}` : remapCodeUrl(node.value, maps) : undefined;
      if (to && to !== node.value) node.setValue(to, { quoteMark: node.quoteMark || '"' });
    });
  }).processSync(value, { lossless: true, maxNestingDepth: 64 });
}
function scopeParameters(value: string, maps: CodeReferenceMaps) {
  const groups: { start: number; end: number }[] = []; let depth = 0, start = 0, quote = '';
  // @scope的外层括号不是普通选择器语法；只解析每个边界中的选择器，保留to和引号转义。
  for (let i = 0; i < value.length; i++) { const c = value[i]; if (c === '\\') { i++; continue; } if (quote) { if (c === quote) quote = ''; continue; } if (c === '"' || c === "'") { quote = c; continue; } if (c === '(') { if (!depth) start = i + 1; if (++depth > 64) throw new Error('scope depth'); } else if (c === ')' && --depth === 0) groups.push({ start, end: i }); if (depth < 0) throw new Error('scope syntax'); }
  if (depth || quote) throw new Error('scope syntax');
  for (const group of groups.reverse()) value = value.slice(0, group.start) + selector(value.slice(group.start, group.end), maps) + value.slice(group.end);
  return value;
}

/** 只改url()/image-set()中的资源值，content文字、颜色和普通字符串保持原样。 */
function cssValue(value: string, maps: CodeReferenceMaps, importRule = false) {
  const parsed = valueParser(value);
  const resource = (raw:string) => raw.startsWith('#') ? `#${maps.nodes?.get(raw.slice(1)) || raw.slice(1)}` : remapCodeUrl(raw,maps);
  function visit(nodes: valueParser.Node[], depth=0, imageSet=false) {
    if(depth>64)throw new Error('CSS value depth');
    for(const node of nodes) {
      if ('unclosed' in node && node.unclosed) throw new Error('CSS value syntax');
      if(node.type==='function') {
        if(node.value.toLowerCase()==='url') { const parts=node.nodes.filter(n=>!['space','comment'].includes(n.type));if(parts.length===1&&['word','string'].includes(parts[0].type))parts[0].value=resource(parts[0].value); }
        else visit(node.nodes,depth+1,['image-set','-webkit-image-set'].includes(node.value.toLowerCase()));
      } else if(node.type==='string'&&(imageSet||importRule&&depth===0)) node.value=resource(node.value);
    }
  }
  visit(parsed.nodes);return parsed.toString();
}

/** 解析CSS规则后只改选择器和媒体路径，不能用全局字符串替换误改颜色、文案或相似ID。 */
export function remapCss(source: string, maps: CodeReferenceMaps) {
  try {
    const root = postcss.parse(source);
    root.walkAtRules(rule => { if (rule.name.toLowerCase() === 'scope') rule.params = scopeParameters(rule.params, maps); else if (rule.name.toLowerCase() === 'import') rule.params = cssValue(rule.params, maps, true); });
    root.walkRules(rule => { rule.selector = selector(rule.selector, maps); });
    root.walkDecls(decl => { decl.value = cssValue(decl.value, maps); });
    return root.toString();
  } catch { throw new ApiError(422, '自定义CSS无法解析或选择器嵌套过深，尚未复制/导入；请检查原始代码'); }
}

/** 只变换AST中的明确DOM调用和站内路径常量，不执行脚本、不猜测动态计算的选择器。 */
export function remapJs(source: string, maps: CodeReferenceMaps) {
  const warnings = new Set<string>(), patches = new Map<number, { end: number; value: string }>();
  let tree: Ast;
  try { tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }) as unknown as Ast; }
  catch { throw new ApiError(422, '自定义JavaScript无法解析，尚未复制/导入；原始代码保留，请先检查语法'); }
  function patch(node: ReturnType<typeof stringNode>, value: string) { if (node && value !== node.value) patches.set(node.start, { end: node.end, value: JSON.stringify(value) }); }
  function visit(value: unknown, depth = 0) {
    if (depth > 256) throw new ApiError(422, '自定义JavaScript结构过深，尚未复制/导入');
    if (Array.isArray(value)) { value.forEach(v => visit(v, depth + 1)); return; } if (!record(value)) return;
    if (value.type === 'TaggedTemplateExpression') { warnings.add('检测到带标签的模板字符串，已保留其原始转义语义；其中的动态路径需人工核对。'); visit(value.tag, depth + 1); return; }
    if (value.type === 'CallExpression' && record(value.callee) && value.callee.type === 'MemberExpression') {
      const property = value.callee.property, name = record(property) ? property.type === 'Identifier' && !value.callee.computed ? property.name : property.type === 'Literal' ? property.value : undefined : undefined;
      if (typeof name === 'string' && ['getElementById', 'querySelector', 'querySelectorAll', 'closest', 'matches'].includes(name)) {
        const arg = Array.isArray(value.arguments) ? stringNode(value.arguments[0]) : undefined;
        if (!arg) warnings.add('检测到动态计算的DOM标识/选择器，未改写其程序表达式；启用前需开发者核对。');
        else if (name === 'getElementById') patch(arg, maps.nodes?.get(arg.value) || arg.value);
        else { try { patch(arg, selector(arg.value, maps)); } catch { warnings.add('部分JavaScript选择器常量无法解析，已保留原值，启用前需核对。'); } }
      }
    }
    const literal = stringNode(value); if (literal) patch(literal, remapCodeUrl(literal.value, maps));
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  visit(tree);
  let result = source;
  for (const [start, change] of [...patches].sort(([a], [b]) => b - a)) result = result.slice(0, start) + change.value + result.slice(change.end);
  return { source: result, warnings: [...warnings] };
}

export function remapSnippet(code: CodeSnippet, maps: CodeReferenceMaps, enableJs = false) {
  validateSnippet(code, '来源自定义代码', true);
  const js = remapJs(code.js, maps), result = { ...code, css: remapCss(code.css, maps), js: js.source, jsEnabled: enableJs && code.jsEnabled };
  validateSnippet(result, '复制/导入后的代码', true);
  return { code: result, warnings: [...(code.js.trim() ? ['自定义JavaScript默认不启用；动态生成HTML/选择器、外部接口与业务语义不由标识映射推断，管理员需检查后明确启用。'] : []), ...js.warnings] };
}
