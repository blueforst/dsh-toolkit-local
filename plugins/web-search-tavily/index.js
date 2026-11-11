import { WebError } from '@deepseek-ai/dsh-web';

export const name = 'forst-web-search-tavily';
export const inject = ['web'];

const providerId = 'forst-tavily';
const keyRef = 'TAVILY_API_KEY';
const endpoint = 'https://api.tavily.com/search';
const timeoutMs = 15000;

function ambientKey(ctx) {
  const environment = ctx.get('launchEnvironment');
  return environment ? environment.get(keyRef)?.value : process.env[keyRef];
}

async function readKey(ctx) {
  const credentials = ctx.get('credentials');
  const key = credentials ? (await credentials.resolve(keyRef))?.value : ambientKey(ctx);
  return key?.trim();
}

function abortError(signal, deadline) {
  if (signal?.aborted) return new WebError('Tavily 搜索已取消', 'WEB_ABORTED');
  if (deadline?.aborted) return new WebError('Tavily 搜索超时', 'WEB_PROVIDER_TIMEOUT');
}

function responseError(status) {
  if (status === 401 || status === 403) {
    return new WebError('Tavily 拒绝了 API Key，请在插件页检查密钥。', 'WEB_PROVIDER_CREDENTIAL_REJECTED');
  }
  if (status === 429) {
    return new WebError('Tavily 搜索请求过多，请稍后再试。', 'WEB_PROVIDER_RATE_LIMITED');
  }
  return new WebError(`Tavily 搜索失败（HTTP ${status}）`, 'WEB_PROVIDER_ERROR');
}

function normalizeSources(results, limit) {
  const sources = new Map();
  for (const item of results) {
    const url = typeof item?.url === 'string' ? URL.parse(item.url) : null;
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || sources.has(url.href)) continue;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const summary = typeof item.content === 'string' ? item.content.trim() : '';
    sources.set(url.href, {
      url: url.href,
      ...(title ? { title } : {}),
      ...(summary ? { snippet: summary.slice(0, 240), summary } : {}),
    });
    if (sources.size > limit) break;
  }
  return { sources: [...sources.values()].slice(0, limit), truncated: sources.size > limit };
}

async function search(ctx, request, signal) {
  if (signal?.aborted) throw abortError(signal);
  const query = request.query.trim();
  const requestedLimit = request.maxResults ?? 5;
  if (!query || !Number.isSafeInteger(requestedLimit) || requestedLimit < 0) {
    throw new WebError('Tavily 搜索需要有效的关键词和结果数。', 'WEB_PROVIDER_ERROR');
  }
  if (requestedLimit === 0) return { sources: [], truncated: false };
  const limit = Math.min(requestedLimit, 20);

  let key;
  try {
    key = await readKey(ctx);
  } catch {
    throw abortError(signal) ?? new WebError('暂时无法读取 Tavily API Key。', 'WEB_PROVIDER_ERROR');
  }
  if (signal?.aborted) throw abortError(signal);
  if (!key) {
    throw new WebError('请在插件页保存 Tavily API Key。', 'WEB_PROVIDER_CREDENTIAL_MISSING');
  }

  const deadline = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: limit }),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      redirect: 'error',
    });
  } catch {
    throw abortError(signal, deadline) ?? new WebError('无法连接 Tavily 搜索服务。', 'WEB_PROVIDER_ERROR');
  }
  if (!response.ok) throw responseError(response.status);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw abortError(signal, deadline) ?? new WebError('Tavily 返回了无效的搜索结果。', 'WEB_PROVIDER_ERROR');
  }
  if (!Array.isArray(payload?.results)) {
    throw new WebError('Tavily 返回了无效的搜索结果。', 'WEB_PROVIDER_ERROR');
  }
  return normalizeSources(payload.results, limit);
}

export function apply(ctx) {
  ctx.web.registerSearchProvider({
    id: providerId,
    available: () => true,
    async ready() {
      try {
        const credentials = ctx.get('credentials');
        return credentials ? (await credentials.describe(keyRef)).configured : Boolean(ambientKey(ctx)?.trim());
      } catch {
        return false;
      }
    },
    search: (request, signal) => search(ctx, request, signal),
  });
}
