import test from 'node:test';
import assert from 'node:assert/strict';
import { WebError } from '@deepseek-ai/dsh-web';
import { apply } from '../plugins/web-search-tavily/index.js';

function harness(t, { key = 'fixture-key', reply = () => Response.json({ results: [] }) } = {}) {
  let provider;
  const requests = [];
  const credentials = {
    async describe(ref) {
      assert.equal(ref, 'TAVILY_API_KEY');
      return { configured: Boolean(key) };
    },
    async resolve(ref) {
      assert.equal(ref, 'TAVILY_API_KEY');
      return key ? { value: key, source: 'file' } : undefined;
    },
  };
  apply({
    web: { registerSearchProvider: value => { provider = value; } },
    get: name => name === 'credentials' ? credentials : undefined,
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return reply(url, options);
  });
  return { provider, requests, setKey(value) { key = value; } };
}

test('uses the official search API and normalizes ranked citations within the result limit', async t => {
  const h = harness(t, { reply: () => Response.json({
    results: [
      { url: 'https://example.com/1', title: ' 标题 ', content: ' 第一条摘要 ' },
      { url: 'https://example.com/1', title: 'duplicate' },
      { url: 'javascript:alert(1)', title: 'invalid' },
      { url: 'https://user:password@example.com/3' },
      { url: 'https://example.com/2' },
      { url: 'https://example.com/3' },
    ],
  }) });
  assert.equal(h.provider.id, 'forst-tavily');
  assert.deepEqual(await h.provider.search({ query: ' 开源框架 ', maxResults: 2 }), {
    sources: [
      { url: 'https://example.com/1', title: '标题', snippet: '第一条摘要', summary: '第一条摘要' },
      { url: 'https://example.com/2' },
    ],
    truncated: true,
  });
  const [{ url, options }] = h.requests;
  assert.equal(url, 'https://api.tavily.com/search');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer fixture-key');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body), { query: '开源框架', search_depth: 'basic', max_results: 2 });
  await h.provider.search({ query: 'another search', maxResults: 30 });
  assert.equal(JSON.parse(h.requests[1].options.body).max_results, 20);
});

test('readiness checks local credentials and sees a key saved after plugin activation', async t => {
  const h = harness(t, { key: null });
  assert.equal(await h.provider.ready(), false);
  await assert.rejects(h.provider.search({ query: 'test' }), { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' });
  assert.equal(h.requests.length, 0);
  h.setKey('new-key');
  assert.equal(await h.provider.ready(), true);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(await h.provider.search({ query: 'test' }), { sources: [], truncated: false });
  assert.equal(h.requests[0].options.headers.Authorization, 'Bearer new-key');
});

test('cancellation reaches the upstream request and uses the native error code', async t => {
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const h = harness(t, { reply: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    requestStarted();
  }) });
  const controller = new AbortController();
  const result = h.provider.search({ query: 'test' }, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(result, { code: 'WEB_ABORTED' });
  assert.equal(h.requests[0].options.signal.aborted, true);
});

test('handles credential rejection, throttling and malformed results without exposing upstream details', async t => {
  let reply;
  const h = harness(t, { reply: () => reply });
  for (const [status, code] of [[401, 'WEB_PROVIDER_CREDENTIAL_REJECTED'], [429, 'WEB_PROVIDER_RATE_LIMITED']]) {
    reply = new Response('upstream-secret-body', { status });
    await assert.rejects(h.provider.search({ query: 'test' }), error => {
      assert(error instanceof WebError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /upstream-secret-body|fixture-key/);
      return true;
    });
  }
  reply = Response.json({ message: 'missing results' });
  await assert.rejects(h.provider.search({ query: 'test' }), { code: 'WEB_PROVIDER_ERROR' });
});
