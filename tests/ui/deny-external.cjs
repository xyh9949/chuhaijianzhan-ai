// 仅预加载到合成Next进程：即使误点接口，也不能从后端向外网或正式3200请求。
const http = require('node:http'), https = require('node:https');
const allowed = new URL(process.env.UI_TEST_ORIGIN || '');
if (allowed.hostname !== '127.0.0.1' || allowed.port === '3200') throw Error('UI regression origin is not isolated');
// 仅放行包装器亲自创建的随机本机模型；不能借配置转发到正式站或外网。
const model = process.env.UI_TEST_MODEL_ORIGIN ? new URL(process.env.UI_TEST_MODEL_ORIGIN) : null;
if (model && (model.protocol !== 'http:' || model.hostname !== '127.0.0.1' || !model.port || model.port === '3200' || model.username || model.password || model.pathname !== '/' || model.search || model.hash || model.origin === allowed.origin)) throw Error('UI synthetic model origin is not isolated');
function check(value, options) {
  let target;
  if (typeof value === 'string' || value instanceof URL) target = new URL(value);
  else { const opts = { ...value, ...options }; target = new URL(`${opts.protocol || 'http:'}//${opts.hostname || opts.host || 'localhost'}${opts.port ? ':' + opts.port : ''}${opts.path || '/'}`); }
  if (target.origin !== allowed.origin && target.origin !== model?.origin) throw Error('UI regression outbound request is disabled');
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => { check(input instanceof Request ? input.url : input); return originalFetch(input, options); };
for (const transport of [http, https]) for (const key of ['request', 'get']) { const original = transport[key]; transport[key] = function (value, ...rest) { check(value, typeof rest[0] === 'object' ? rest[0] : undefined); return original.call(this, value, ...rest); }; }
