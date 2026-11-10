// Unit-test fixture only. It is not Pi's catalog or zod and is never shipped.
// The real installed DSH/Pi contract is tested by pricing.integration.mjs.
import assert from 'node:assert/strict';

function schema(validate) {
  return {
    parse(value) { validate(value); return value; },
    finite() { return schema(value => { validate(value); assert(Number.isFinite(value)); }); },
    nonnegative() { return schema(value => { validate(value); assert(value >= 0); }); },
    int() { return schema(value => { validate(value); assert(Number.isInteger(value)); }); },
    nullable() { return schema(value => { if (value !== null) validate(value); }); },
    strict() { return this; },
  };
}

export const fixtureZ = {
  number: () => schema(value => assert.equal(typeof value, 'number')),
  string: () => schema(value => assert.equal(typeof value, 'string')),
  object(shape) {
    return schema(value => {
      assert(value && typeof value === 'object' && !Array.isArray(value));
      assert.deepEqual(Object.keys(value).sort(), Object.keys(shape).sort());
      for (const [key, rule] of Object.entries(shape)) rule.parse(value[key]);
    });
  },
};

export const fixtureRoute = { provider: 'fixture-provider', model: 'fixture-model' };
export const fixtureModel = {
  id: fixtureRoute.model,
  // Artificial prices per million tokens, chosen for easily checked arithmetic.
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 },
};

export function fixtureRuntime(overrides = {}) {
  return {
    z: fixtureZ,
    version: '1.4.0',
    getBuiltinModels: provider => provider === fixtureRoute.provider ? [fixtureModel] : [],
    calculateCost(model, usage) {
      const cost = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => [key, usage[key] * model.cost[key] / 1e6]));
      cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
      return cost;
    },
    ...overrides,
  };
}

export const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

export const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 10000, reasoningTokens: 100 };
export const message = (step, value = usage, source = fixtureRoute, turn = 1) => ({
  type: 'assistant/message',
  data: { turn, step, usage: value, message: { source: { kind: 'model', ...source } } },
});
