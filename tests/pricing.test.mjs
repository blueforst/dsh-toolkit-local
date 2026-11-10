import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjection } from '../plugins/session-billing/projection.js';
import { fixtureRuntime, fixtureRoute, fixtureModel, close, usage, message } from './fixtures/runtime.mjs';

test('fixture unit: mutually exclusive billing buckets and reasoning not billed twice', () => {
  let received;
  const fixture = fixtureRuntime();
  const projection = createProjection({ ...fixture, calculateCost: (model, value) => { received = value; return fixture.calculateCost(model, value); } });
  const state = projection.apply(projection.init(), message(1, { ...usage, cacheWriteTokens: 5000, reasoningTokens: 999999 }));
  assert.deepEqual([received.input, received.output, received.cacheRead, received.cacheWrite], [1000, 200, 10000, 5000]);
  close(state.totals.inputUsd, .001);
  close(state.totals.outputUsd, .0004);
  close(state.totals.cacheReadUsd, .001);
  close(state.totals.cacheWriteUsd, .0075);
  close(state.totals.usd, .0099);
  assert.equal(state.totals.pricedCalls, 1);
  assert.equal(state.totals.unpricedCalls, 0);
});

test('fixture unit: duplicate settlements are idempotent and updated settlements replace charges', () => {
  const projection = createProjection(fixtureRuntime());
  let state = projection.apply(projection.init(), message(1));
  assert.equal(projection.apply(state, message(1)), state);
  state = projection.apply(state, message(1, { ...usage, outputTokens: 300 }));
  close(state.totals.usd, .0026);
  assert.equal(state.totals.pricedCalls, 1);
  state = projection.apply(state, message(1, { ...usage, outputTokens: 100 }));
  close(state.totals.usd, .0022);
  assert.equal(state.totals.pricedCalls, 1);
});

test('fixture unit: retries and compaction retain billed usage', () => {
  const projection = createProjection(fixtureRuntime());
  let state = projection.apply(projection.init(), message(1));
  state = projection.apply(state, { type: 'llm/retry-started', data: { turn: 1, step: 1 } });
  state = projection.apply(state, message(1));
  close(state.totals.usd, .0048);
  assert.equal(state.totals.pricedCalls, 2);
  state = projection.apply(state, { type: 'compaction/summary', data: { ...fixtureRoute, usage } });
  close(state.totals.usd, .0072);
  assert.equal(state.totals.pricedCalls, 3);
  assert.equal(projection.apply(state, { type: 'llm/retry-started', data: { turn: 99, step: 99 } }), state);
});

test('fixture unit: stream attempt usage takes the latest usage chunk and direct usage wins', () => {
  const projection = createProjection(fixtureRuntime());
  let state = projection.apply(projection.init(), { type: 'request/context', data: fixtureRoute });
  state = projection.apply(state, { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [
    { type: 'chunk', chunk: { type: 'usage', usage: { ...usage, outputTokens: 50 } } },
    { type: 'chunk', chunk: { type: 'text', value: 'not usage' } },
    { type: 'chunk', chunk: { type: 'usage', usage } },
  ] } });
  close(state.totals.usd, .0024);
  state = projection.apply(state, { type: 'assistant/attempt', data: { turn: 1, step: 2, usage: { ...usage, outputTokens: 100 }, stream: [
    { type: 'chunk', chunk: { type: 'usage', usage: { ...usage, outputTokens: 999999 } } },
  ] } });
  close(state.totals.usd, .0046);
});

test('fixture unit: model source overrides request route and unsupported routes remain unpriced', () => {
  const projection = createProjection(fixtureRuntime());
  let state = projection.apply(projection.init(), { type: 'request/context', data: fixtureRoute });
  state = projection.apply(state, message(1, usage, { provider: 'unknown-provider', model: 'unknown-model' }));
  assert.equal(state.totals.pricedCalls, 0);
  assert.equal(state.totals.unpricedCalls, 1);
  assert.equal(state.totals.usd, 0);
  // Later settlement of the same call can replace unknown with a known quote.
  state = projection.apply(state, message(1));
  assert.equal(state.totals.pricedCalls, 1);
  assert.equal(state.totals.unpricedCalls, 0);
  close(state.totals.usd, .0024);
});

for (const [label, value] of [
  ['no usage', undefined], ['negative input', { ...usage, inputTokens: -1 }],
  ['non-finite output', { ...usage, outputTokens: Infinity }], ['string input', { ...usage, inputTokens: '1000' }],
  ['negative cache read', { ...usage, cacheReadTokens: -1 }], ['invalid cache write', { ...usage, cacheWriteTokens: NaN }],
]) {
  test(`fixture unit: ${label} is unpriced, not free`, () => {
    const projection = createProjection(fixtureRuntime());
    const event = message(1);
    event.data.usage = value;
    const state = projection.apply(projection.init(), event);
    assert.equal(state.totals.pricedCalls, 0);
    assert.equal(state.totals.unpricedCalls, 1);
    assert.equal(state.totals.usd, 0);
  });
}

test('fixture unit: absent cache usage defaults to zero and zero-token calls remain priced', () => {
  const projection = createProjection(fixtureRuntime());
  const state = projection.apply(projection.init(), message(1, { inputTokens: 0, outputTokens: 0 }));
  assert.equal(state.totals.pricedCalls, 1);
  assert.equal(state.totals.unpricedCalls, 0);
  assert.equal(state.totals.usd, 0);
  assert.equal(state.totals.cacheReadUsd, 0);
  assert.equal(state.totals.cacheWriteUsd, 0);
});

test('fixture unit: provider lookup errors and non-finite calculated charges remain unpriced', () => {
  const unavailable = createProjection(fixtureRuntime({ getBuiltinModels() { throw new Error('no provider'); } }));
  assert.equal(unavailable.apply(unavailable.init(), message(1)).totals.unpricedCalls, 1);
  const invalid = createProjection(fixtureRuntime({ calculateCost() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: NaN }; } }));
  assert.equal(invalid.apply(invalid.init(), message(1)).totals.unpricedCalls, 1);
});

test('fixture unit: cached catalog lookup is scoped to the provider and model', () => {
  const requested = [];
  const projection = createProjection(fixtureRuntime({ getBuiltinModels(provider) { requested.push(provider); return [fixtureModel]; } }));
  let state = projection.apply(projection.init(), message(1));
  state = projection.apply(state, message(2));
  state = projection.apply(state, message(3, usage, { provider: 'other-provider', model: fixtureModel.id }));
  assert.deepEqual(requested, [fixtureRoute.provider, 'other-provider']);
  assert.equal(state.totals.pricedCalls, 3);
});

test('fixture unit: full-history replay agrees with live accumulation, projection key stays stable', () => {
  const projection = createProjection(fixtureRuntime());
  const events = [message(1), message(1), { type: 'llm/retry-started', data: { turn: 1, step: 1 } }, message(1),
    message(2, usage, { provider: 'unknown', model: 'unknown' }), message(1, usage, fixtureRoute, 2),
    { type: 'compaction/summary', data: { ...fixtureRoute, usage } }];
  const replay = values => values.reduce((state, event) => projection.apply(state, event), projection.init());
  const split = events.slice(3).reduce((state, event) => projection.apply(state, event), JSON.parse(JSON.stringify(replay(events.slice(0, 3)))));
  assert.deepEqual(split, replay(events));
  assert.equal(projection.key, 'forstSessionCost');
  assert.equal(projection.stateVersion, 2010400);
  assert.deepEqual(projection.wire.view(split), split.totals);
  projection.stateSchema.parse(split);
  assert.equal(projection.apply(split, { type: 'tool/result', data: {} }), split);
  assert(createProjection(fixtureRuntime({ version: '1.4.1' })).stateVersion > projection.stateVersion);
});
