// Explicit installed-SDK integration gate. Not part of *.test.mjs unit tests.
// Run: DSH_ENTRYPOINT=/path/to/dsh/lib/bin.js node --test tests/*.integration.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { loadRuntime } from '../plugins/session-billing/runtime.js';
import { createProjection } from '../plugins/session-billing/projection.js';

const entrypoint = process.env.DSH_ENTRYPOINT;
assert(entrypoint && statSync(entrypoint).isFile(), 'Set DSH_ENTRYPOINT to the real installed DSH lib/bin.js; this integration gate must not silently skip.');
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('installed Pi contract: pricing, retries, deduplication, compaction, unknown model and cache write', async () => {
  const runtime = await loadRuntime(entrypoint);
  const projection = createProjection(runtime);
  const route = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' };
  const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 10000, reasoningTokens: 100 };
  const message = (step, value = usage, source = route) => ({ type: 'assistant/message', data: { turn: 1, step, usage: value, message: { source: { kind: 'model', ...source } } } });
  let state = projection.apply(projection.init(), message(1));
  close(state.totals.inputUsd, .00015);
  close(state.totals.outputUsd, .00012);
  close(state.totals.cacheReadUsd, .00003);
  close(state.totals.cacheWriteUsd, 0);
  assert.equal(projection.apply(state, message(1)), state);
  state = projection.apply(state, message(1, { ...usage, outputTokens: 300 }));
  close(state.totals.usd, .00036);
  assert.equal(state.totals.pricedCalls, 1);
  state = projection.apply(state, { type: 'llm/retry-started', data: { turn: 1, step: 1 } });
  state = projection.apply(state, message(1));
  close(state.totals.usd, .00066);
  assert.equal(state.totals.pricedCalls, 2);
  state = projection.apply(state, { type: 'compaction/summary', data: { ...route, usage } });
  close(state.totals.usd, .00096);
  state = projection.apply(state, message(2, usage, { provider: 'unknown', model: 'unknown' }));
  assert.equal(state.totals.unpricedCalls, 1);
  projection.stateSchema.parse(JSON.parse(JSON.stringify(state)));
  projection.wire.viewSchema.parse(projection.wire.view(state));
  assert.throws(() => projection.stateSchema.parse({ ...state, extra: true }));
  const model = runtime.getBuiltinModels('anthropic').find(item => item.cost.cacheWrite > 0);
  assert(model, 'Installed Pi must contain a model with nonzero cache-write pricing.');
  const withWrite = projection.apply(projection.init(), message(1, { ...usage, cacheWriteTokens: 5000 }, { provider: 'anthropic', model: model.id }));
  assert(withWrite.totals.cacheWriteUsd > 0);
  close(withWrite.totals.usd, withWrite.totals.inputUsd + withWrite.totals.outputUsd + withWrite.totals.cacheReadUsd + withWrite.totals.cacheWriteUsd);
});

test('installed DSH/Pi contract: local backend registers only quota HTTP and the native cost projection', async () => {
  const { apply, inject, name } = await import('../index.js');
  assert.equal(name, 'dsh-toolkit-local');
  assert.deepEqual(inject, ['webServer', 'sessionProjections', 'connection']);
  const routes = new Map(), projections = [], cleanups = [];
  const previous = process.argv[1];
  process.argv[1] = entrypoint;
  try {
    await apply({
      effect: callback => cleanups.push(callback()),
      connection: { requestRejection: () => undefined },
      webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } },
      sessionProjections: { register: projection => { projections.push(projection); } },
    });
    assert.deepEqual([...routes.keys()], ['/opencode-go-quota']);
    assert.equal(projections.length, 1);
    assert.equal(projections[0].key, 'forstSessionCost');
    projections[0].stateSchema.parse(projections[0].init());
  } finally {
    process.argv[1] = previous;
    cleanups.reverse().forEach(dispose => dispose?.());
  }
  assert.equal(routes.size, 0);
});
