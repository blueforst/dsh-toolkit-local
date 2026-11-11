import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../plugins/opencode-go-quota/index.js';

function response() {
  return { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
}

const validMonthly = { percent: 8, status: 'ok', resetsAt: '2026-12-01T00:00:00.000Z' };

function harness(t, { key = 'test-credential', credentials, monthly = validMonthly, network } = {}) {
  const oldKey = process.env.OPENCODE_GO_API_KEY;
  if (key === null) delete process.env.OPENCODE_GO_API_KEY;
  else process.env.OPENCODE_GO_API_KEY = key;
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENCODE_GO_API_KEY;
    else process.env.OPENCODE_GO_API_KEY = oldKey;
  });
  let now = 100000;
  const calls = [], routes = new Map(), cleanups = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return network ? network(url, options) : { ok: true, json: async () => ({ usage: { monthly } }) };
  });
  apply({
    get: name => name === 'credentials' ? credentials : undefined,
    effect: callback => cleanups.push(callback()),
    connection: { requestRejection: request => request.rejection },
    webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } },
  });
  const request = async (method = 'GET', rejection) => {
    const res = response();
    await routes.get('/opencode-go-quota').handler({ method, rejection }, res);
    return res;
  };
  return { request, calls, routes, advance: value => { now += value; }, dispose: () => cleanups.forEach(fn => fn?.()) };
}

test('quota is the sole HTTP route and disposal releases the registration', t => {
  const h = harness(t);
  assert.deepEqual([...h.routes.keys()], ['/opencode-go-quota']);
  h.dispose();
  assert.equal(h.routes.size, 0);
  assert.equal(h.calls.length, 0, 'registration must not contact the account');
});

test('authentication rejection precedes all provider access, including HEAD', async t => {
  const h = harness(t);
  for (const rejection of [401, 403]) {
    for (const method of ['GET', 'HEAD']) {
      const res = await h.request(method, rejection);
      assert.equal(res.status, rejection);
      assert.equal(res.headers['Cache-Control'], 'no-store');
      if (method === 'HEAD') assert.equal(res.body, undefined);
      else assert(!res.body.includes('test-credential'));
    }
  }
  assert.equal(h.calls.length, 0);
});

test('Go quota shares a 60-second cache, coalesces concurrency, and supports HEAD', async t => {
  const h = harness(t, { network: async () => {
    await Promise.resolve();
    return { ok: true, json: async () => ({ usage: { monthly: validMonthly } }) };
  } });
  const [a, b] = await Promise.all([h.request(), h.request()]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://opencode.ai/inference/go/v1/usage');
  assert.equal(h.calls[0].options.headers.Authorization, 'Bearer test-credential');
  assert(h.calls[0].options.signal instanceof AbortSignal);
  assert.equal(a.status, 200);
  assert.equal(a.body, b.body);
  assert.equal(a.headers['Content-Length'], Buffer.byteLength(a.body));
  assert.equal(a.headers['Cache-Control'], 'no-store');
  assert.equal(JSON.parse(a.body).monthly.percent, 8);
  assert.equal(JSON.parse(a.body).scope, 'opencode-go-monthly');
  assert(!a.body.includes('test-credential'));
  h.advance(59999);
  await h.request();
  assert.equal(h.calls.length, 1);
  h.advance(1);
  await h.request();
  assert.equal(h.calls.length, 2);
  const head = await h.request('HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined);
  assert(Number(head.headers['Content-Length']) > 0);
  assert.equal(h.calls.length, 2);
});

test('unsupported methods do not request quota', async t => {
  const h = harness(t);
  for (const method of ['POST', 'DELETE', 'PUT', 'OPTIONS']) {
    const res = await h.request(method);
    assert.equal(res.status, 405);
    assert.equal(res.headers.Allow, 'GET, HEAD');
  }
  assert.equal(h.calls.length, 0);
});

test('missing credential fails closed without provider traffic', async t => {
  const h = harness(t, { key: null });
  const res = await h.request();
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.body).code, 'missing-credential');
  const head = await h.request('HEAD');
  assert.equal(head.status, 503);
  assert.equal(head.body, undefined);
  assert.equal(h.calls.length, 0);
});

test('quota uses the DSH credential service and recovers when a key is saved', async t => {
  let key;
  const credentials = { async resolve(ref) {
    assert.equal(ref, 'OPENCODE_GO_API_KEY');
    return key ? { value: key, source: 'file' } : undefined;
  } };
  const h = harness(t, { credentials });
  const missing = await h.request();
  assert.equal(missing.status, 503);
  assert.equal(JSON.parse(missing.body).code, 'missing-credential');
  assert.equal(h.calls.length, 0, 'the credential service owns resolution when available');
  key = 'desktop-stored-key';
  assert.equal((await h.request()).status, 200);
  assert.equal(h.calls[0].options.headers.Authorization, 'Bearer desktop-stored-key');
});

test('provider failure is sanitized and retry is delayed by ten seconds', async t => {
  let fail = true;
  const h = harness(t, { network: async () => {
    if (fail) throw new Error('test-credential: provider internal body');
    return { ok: true, json: async () => ({ usage: { monthly: validMonthly } }) };
  } });
  const res = await h.request();
  assert.equal(res.status, 503);
  assert(!res.body.includes('test-credential'));
  assert(!res.body.includes('provider internal body'));
  fail = false;
  h.advance(9999);
  assert.equal((await h.request()).status, 503);
  assert.equal(h.calls.length, 1);
  h.advance(1);
  assert.equal((await h.request()).status, 200);
  assert.equal(h.calls.length, 2);
});

test('expired cached data is not presented as a fresh successful provider sample', async t => {
  let fail = false;
  const h = harness(t, { network: async () => fail
    ? { ok: false, status: 503 }
    : { ok: true, json: async () => ({ usage: { monthly: validMonthly } }) }
  });
  assert.equal((await h.request()).status, 200);
  h.advance(60000);
  fail = true;
  assert.equal((await h.request()).status, 503);
  assert.equal(h.calls.length, 2);
});

for (const monthly of [undefined, {}, { ...validMonthly, percent: -1 }, { ...validMonthly, percent: 101 },
  { ...validMonthly, percent: NaN }, { ...validMonthly, percent: '8' }, { ...validMonthly, status: 'unexpected' },
  { ...validMonthly, resetsAt: 'not-a-date' }]) {
  test(`invalid quota payload is rejected: ${JSON.stringify(monthly)}`, async t => {
    const h = harness(t, { network: async () => ({ ok: true, json: async () => ({ usage: { monthly } }) }) });
    assert.equal((await h.request()).status, 503);
  });
}

test('valid exhausted or rate-limited usage is still a successful quota sample', async t => {
  const h = harness(t, { monthly: { ...validMonthly, percent: 100, status: 'rate-limited' } });
  const res = await h.request();
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).monthly.status, 'rate-limited');
  assert.equal(JSON.parse(res.body).monthly.percent, 100);
});
