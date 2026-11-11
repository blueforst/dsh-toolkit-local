import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Minimal hook/slot fixture: validates our client contract, not a real React/DSH UI.
function clientHarness({ states: initialStates = [], visibility = 'visible', quotaResponse } = {}) {
  let stateIndex = 0, nextTimer = 0;
  const definitions = [];
  const styles = [], slots = new Map(), effects = [], cleanups = [], hookCleanups = [];
  const states = [...initialStates], intervals = new Map(), timeouts = new Map(), listeners = new Map(), requests = [];
  const document = {
    visibilityState: visibility,
    body: {},
    createElement: () => ({ dataset: {}, remove() { this.removed = true; } }),
    head: { appendChild: element => styles.push(element) },
    addEventListener(name, callback) { (listeners.get(name) ?? (listeners.set(name, new Set()), listeners.get(name))).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children }, children }),
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const i = stateIndex++;
      if (!(i in states)) states[i] = initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useRef: () => ({ current: null }),
    useId: () => 'fixture-dialog',
    useEffect: callback => effects.push(callback),
  };
  const window = {
    __ModuleLoader__: { load: value => definitions.push(value) },
    setInterval(callback, ms) { const id = ++nextTimer; intervals.set(id, { callback, ms }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout(callback, ms) { const id = ++nextTimer; timeouts.set(id, { callback, ms }); return id; },
    clearTimeout: id => timeouts.delete(id),
  };
  const globals = {
    window, document, AbortController,
    Node: class FixtureNode {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (quotaResponse) return quotaResponse();
      return { ok: true, json: async () => ({ scope: 'opencode-go-monthly', timestamp: Date.now(), monthly: { percent: 8 } }) };
    },
  };
  for (const name of ['opencode-go-quota', 'session-billing', 'web-search-tavily']) {
    const source = new URL(`../plugins/${name}/client.js`, import.meta.url);
    runInNewContext(readFileSync(source, 'utf8'), globals);
  }
  const require = name => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal: child => ({ type: 'portal', children: [child] }) };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
      Tooltip: 'native-tooltip-fixture',
      SettingsSecretField: 'native-secret-field-fixture',
      useAnchoredPosition: () => ({ left: 12, top: 12 }),
      useDismissOnOutsidePointer() {},
    };
    throw new Error(`Unexpected client dependency: ${name}`);
  };
  const ctx = {
    effect: callback => cleanups.push(callback()),
    configForms: { whileServed: (_names, callback) => callback() },
    slots: {
      inject: (_name, callback) => callback(),
      register(spec, component) {
        assert(!slots.has(spec.id));
        slots.set(spec.id, { spec, component });
        const dispose = () => slots.delete(spec.id);
        cleanups.push(dispose);
        return dispose;
      },
    },
  };
  for (const definition of definitions) definition.factory(require).apply(ctx);
  return {
    slots, styles, states, requests, document, intervals, timeouts, listeners,
    render(id, props) { stateIndex = 0; return slots.get(id).component(props); },
    runEffects() { effects.splice(0).forEach(callback => hookCleanups.push(callback())); },
    settle() { return new Promise(resolve => setImmediate(resolve)); },
    dispose() { hookCleanups.splice(0).reverse().forEach(callback => callback?.()); cleanups.splice(0).reverse().forEach(callback => callback?.()); },
  };
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...(tree.children ?? []).flatMap(nodes)];
}

test('client registers quota, cost and the unified Web Search page and disposes its slots', () => {
  const h = clientHarness();
  assert.deepEqual([...h.slots.keys()], ['opencode-go-quota', 'session-cost', 'forst-web-search-settings']);
  assert.equal(h.slots.get('forst-web-search-settings').spec.name, 'plugins.detail.section');
  assert.equal(h.slots.get('opencode-go-quota').spec.order, 51);
  assert.equal(h.slots.get('session-cost').spec.order, -1);
  assert.equal(h.styles.length, 2);
  assert.equal(h.styles[0].dataset.pluginCss, '@forst/dsh-session-billing');
  assert.equal(h.requests.length, 0, 'registration cannot start background polling');
  h.dispose();
  assert.equal(h.slots.size, 0);
  assert(h.styles.every(style => style.removed));
});

test('collapsed sidebar does not poll quota or allocate a timer', async () => {
  const h = clientHarness();
  h.render('opencode-go-quota', { wide: false });
  h.runEffects();
  await h.settle();
  assert.equal(h.requests.length, 0);
  assert.equal(h.intervals.size, 0);
  h.dispose();
});

test('quota polling pauses when hidden, resumes immediately, and cleans up on unload', async () => {
  const h = clientHarness({ visibility: 'hidden' });
  h.render('opencode-go-quota', { wide: true });
  h.runEffects();
  await h.settle();
  assert.equal(h.requests.length, 0);
  assert.equal(h.intervals.size, 1);
  const timer = [...h.intervals.values()][0];
  assert.equal(timer.ms, 60000);
  await timer.callback();
  assert.equal(h.requests.length, 0);
  h.document.visibilityState = 'visible';
  for (const callback of h.listeners.get('visibilitychange')) await callback();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/opencode-go-quota');
  assert.equal(h.requests[0].options.cache, 'no-store');
  assert.equal(h.states[0].monthly.percent, 8);
  assert.equal(h.timeouts.size, 0);
  h.dispose();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.listeners.get('visibilitychange').size, 0);
  assert(h.requests[0].options.signal.aborted);
  await timer.callback();
  assert.equal(h.requests.length, 1, 'disposed refresh cannot issue another request');
});

test('quota explains a missing key and shows usage after the next successful refresh', async () => {
  let configured = false;
  const h = clientHarness({ quotaResponse: () => configured
    ? { ok: true, json: async () => ({ scope: 'opencode-go-monthly', timestamp: Date.now(), monthly: { percent: 8 } }) }
    : { ok: false, status: 503, json: async () => ({ code: 'missing-credential' }) } });
  h.render('opencode-go-quota', { wide: true });
  h.runEffects();
  await h.settle();
  assert.equal(h.render('opencode-go-quota', { wide: true }).props.detail, '未配置 OpenCode Go API Key');
  configured = true;
  await [...h.intervals.values()][0].callback();
  const updated = h.render('opencode-go-quota', { wide: true });
  assert.equal(updated.props.detail, '本月已使用');
  assert.equal(updated.children[0].props.value, 8);
  h.dispose();
});

const cost = { usd: .0003, inputUsd: .00015, outputUsd: .00012, cacheReadUsd: .00003, cacheWriteUsd: 0, pricedCalls: 1, unpricedCalls: 0 };

test('billing details hide zero cache-write, show positive cache-write, and mark unknown pricing', () => {
  for (const cacheWriteUsd of [0, .001]) {
    const h = clientHarness({ states: [true] });
    const tree = h.render('session-cost', { useProjection: key => { assert.equal(key, 'forstSessionCost'); return { ...cost, cacheWriteUsd, unpricedCalls: 1 }; } });
    const rendered = nodes(tree);
    assert.equal(rendered.filter(node => node.props?.role === 'dialog').length, 1);
    assert.deepEqual(rendered.filter(node => node.props?.['data-cost-bucket']).map(node => node.props['data-cost-bucket']),
      cacheWriteUsd > 0 ? ['inputUsd', 'outputUsd', 'cacheReadUsd', 'cacheWriteUsd'] : ['inputUsd', 'outputUsd', 'cacheReadUsd']);
    assert(rendered.find(node => node.type === 'button').props['aria-label'].includes('*'));
    h.dispose();
  }
});

test('billing dialog closes with Escape and removes its listeners', () => {
  const h = clientHarness({ states: [true] });
  h.render('session-cost', { useProjection: () => cost });
  h.runEffects();
  assert.equal(h.listeners.get('keydown').size, 1);
  for (const callback of h.listeners.get('keydown')) callback({ key: 'Escape' });
  assert.equal(h.states[0], false);
  h.dispose();
  assert.equal(h.listeners.get('keydown').size, 0);
  assert.equal(h.listeners.get('click').size, 0);
});

test('switching to a session without usage hides the cost and closes the dialog', () => {
  const h = clientHarness({ states: [true] });
  assert.equal(h.render('session-cost', { useProjection: () => null }), null);
  h.runEffects();
  assert.equal(h.states[0], false);
  h.dispose();
});
