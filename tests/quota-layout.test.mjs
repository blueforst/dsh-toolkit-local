import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// CSSStyleDeclaration-shaped fixture, including inline priority and removal.
// The real quota component is rendered through its registered slot, then through
// QuotaSection, so a parent-layout effect cannot hide behind the outer component.
function styleDeclaration(value = '', priority = '') {
  const declarations = new Map(value ? [['flex-wrap', { value, priority }]] : []);
  const writes = [];
  return {
    writes,
    getPropertyValue: name => declarations.get(name)?.value ?? '',
    getPropertyPriority: name => declarations.get(name)?.priority ?? '',
    setProperty(name, nextValue, nextPriority = '') {
      writes.push({ name, value: nextValue, priority: nextPriority });
      if (nextValue === '') declarations.delete(name);
      else declarations.set(name, { value: nextValue, priority: nextPriority });
    },
    removeProperty(name) {
      const previous = declarations.get(name)?.value ?? '';
      writes.push({ name, removed: true });
      declarations.delete(name);
      return previous;
    },
  };
}

function parentChain(value = 'nowrap', priority = '') {
  const footer = { display: 'flex', style: styleDeclaration(value, priority), parentElement: null };
  const outerSlot = { display: 'contents', style: styleDeclaration(), parentElement: footer };
  const innerSlot = { display: 'contents', style: styleDeclaration(), parentElement: outerSlot };
  return { footer, outerSlot, innerSlot };
}

function renderQuota({ wide = true, parent = null } = {}) {
  let definition, component;
  const layoutEffects = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children }, children }),
    useState: initial => [initial, () => {}],
    useEffect() {}, // Polling is covered separately; no network in this fixture.
    useRef: initial => ({ current: initial }),
    useLayoutEffect: callback => layoutEffects.push(callback),
  };
  runInNewContext(readFileSync(new URL('../plugins/opencode-go-quota/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { definition = value; } } },
    getComputedStyle: element => ({ display: element.display }),
  });
  const plugin = definition.factory(name => {
    assert.equal(name, 'react');
    return React;
  });
  plugin.apply({ slots: {
    inject: (_name, callback) => callback(),
    register: (spec, value) => { assert.equal(spec.id, 'opencode-go-quota'); component = value; },
  } });
  const quotaElement = component({ wide });
  assert.equal(typeof quotaElement.type, 'function', 'render the inner section, not only the slot wrapper');
  const section = quotaElement.type(quotaElement.props);
  if (section?.props.ref) section.props.ref.current = { parentElement: parent };
  const cleanup = layoutEffects.map(effect => effect());
  return {
    section,
    unmount: () => cleanup.reverse().forEach(dispose => dispose?.()),
  };
}

test('quota uses the real flex parent across display:contents slot wrappers', () => {
  const { footer, outerSlot, innerSlot } = parentChain();
  const h = renderQuota({ parent: innerSlot });
  assert.equal(h.section.props['data-dsh-opencode-go-quota'], 'true');
  assert.equal(h.section.props.style.width, '100%');
  assert.equal(h.section.props.style.flex, '0 0 100%');
  assert.equal(footer.style.getPropertyValue('flex-wrap'), 'wrap');
  assert.equal(outerSlot.style.writes.length, 0);
  assert.equal(innerSlot.style.writes.length, 0);
  h.unmount();
});

test('collapsed quota never changes its parent layout', () => {
  const { footer, innerSlot } = parentChain('nowrap', 'important');
  const h = renderQuota({ wide: false, parent: innerSlot });
  assert.equal(h.section, null);
  assert.equal(footer.style.writes.length, 0);
  h.unmount();
  assert.equal(footer.style.writes.length, 0);
  assert.equal(footer.style.getPropertyValue('flex-wrap'), 'nowrap');
  assert.equal(footer.style.getPropertyPriority('flex-wrap'), 'important');
});

test('unmount restores the original inline flex-wrap value and priority', () => {
  const { footer, innerSlot } = parentChain('nowrap', 'important');
  const h = renderQuota({ parent: innerSlot });
  assert.equal(footer.style.getPropertyValue('flex-wrap'), 'wrap');
  assert.equal(footer.style.getPropertyPriority('flex-wrap'), '');
  h.unmount();
  assert.equal(footer.style.getPropertyValue('flex-wrap'), 'nowrap');
  assert.equal(footer.style.getPropertyPriority('flex-wrap'), 'important');
});

test('unmount removes its inline override when the original value came from a stylesheet', () => {
  const { footer, innerSlot } = parentChain('');
  const h = renderQuota({ parent: innerSlot });
  assert.equal(footer.style.getPropertyValue('flex-wrap'), 'wrap');
  h.unmount();
  assert.equal(footer.style.getPropertyValue('flex-wrap'), '');
  assert.equal(footer.style.getPropertyPriority('flex-wrap'), '');
  assert.equal(footer.style.writes.at(-1).removed, true);
});

test('unmount leaves a later third-party flex-wrap value untouched', () => {
  const { footer, innerSlot } = parentChain();
  const h = renderQuota({ parent: innerSlot });
  assert.equal(footer.style.getPropertyValue('flex-wrap'), 'wrap');
  footer.style.setProperty('flex-wrap', 'wrap-reverse', 'important');
  const count = footer.style.writes.length;
  h.unmount();
  assert.equal(footer.style.writes.length, count);
  assert.equal(footer.style.getPropertyValue('flex-wrap'), 'wrap-reverse');
  assert.equal(footer.style.getPropertyPriority('flex-wrap'), 'important');
});

test('unmount leaves a later third-party priority change untouched', () => {
  const { footer, innerSlot } = parentChain();
  const h = renderQuota({ parent: innerSlot });
  assert.equal(footer.style.getPropertyValue('flex-wrap'), 'wrap');
  footer.style.setProperty('flex-wrap', 'wrap', 'important');
  const count = footer.style.writes.length;
  h.unmount();
  assert.equal(footer.style.writes.length, count);
  assert.equal(footer.style.getPropertyValue('flex-wrap'), 'wrap');
  assert.equal(footer.style.getPropertyPriority('flex-wrap'), 'important');
});

test('quota safely renders before a parent is attached', () => {
  const h = renderQuota();
  assert.equal(h.section.props['data-placement'], 'sidebar');
  assert.doesNotThrow(() => h.unmount());
});
