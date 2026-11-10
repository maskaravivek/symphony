// Tiny DOM toolkit: h() element builder, an in-place keyed morph so live
// refreshes keep focus, scroll and disclosure state, a UI-state store for
// disclosures/sort/tabs, and a 1s ticker for relative times.

import { duration, relTime, absTime, parseTime } from './format.js';

function dispatch(event) {
  const handler = event.currentTarget.__on?.[event.type];
  if (handler) handler.call(event.currentTarget, event);
}

const PROPS = new Set(['value', 'checked', 'selected', 'indeterminate']);

/**
 * h('a.cls', { href, key, on: { click }, class: [...] }, ...children)
 * Children may be strings, numbers, nodes, arrays, null/false (skipped).
 */
export function h(tag, props, ...children) {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    if (props !== undefined) children.unshift(props);
    props = {};
  }
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  const classList = [...classes];
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') {
      const list = Array.isArray(v) ? v : [v];
      for (const c of list) if (c) classList.push(...String(c).split(/\s+/).filter(Boolean));
    } else if (k === 'key') {
      el.setAttribute('data-key', String(v));
    } else if (k === 'on') {
      el.__on = {};
      for (const [type, fn] of Object.entries(v)) {
        if (typeof fn !== 'function') continue;
        el.__on[type] = fn;
        el.addEventListener(type, dispatch);
      }
    } else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) if (dv != null) el.dataset[dk] = String(dv);
    } else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) if (sv != null) el.style.setProperty(sk, String(sv));
    } else if (PROPS.has(k)) {
      el[k] = v;
      if (v === true) el.setAttribute(k, '');
      else if (k === 'value') el.setAttribute('value', String(v));
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
  if (classList.length) el.setAttribute('class', classList.join(' '));
  appendChildren(el, children);
  return el;
}

export function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Visually hidden text for screen readers. */
export function sr(text) {
  return h('span.sr-only', text);
}

// ---------------------------------------------------------------------------
// Morph: patch `target`'s children to match `source`'s children in place.
// ---------------------------------------------------------------------------

function keyOf(node) {
  return node.nodeType === 1 ? node.getAttribute('data-key') : null;
}

function sameKind(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  return a.nodeName === b.nodeName && keyOf(a) === keyOf(b);
}

function morphAttributes(target, source) {
  for (const attr of [...target.attributes]) {
    if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
  }
  for (const attr of source.attributes) {
    if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
  }
}

function morphNode(target, source) {
  if (target.nodeType !== 1) {
    if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
    return;
  }
  const focused = target === document.activeElement;
  morphAttributes(target, source);
  target.__on = source.__on;
  if (source.__on) for (const type of Object.keys(source.__on)) target.addEventListener(type, dispatch);
  const tag = target.nodeName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (!focused && target.value !== source.value) target.value = source.value;
    if (target.checked !== source.checked) target.checked = source.checked;
  }
  if (tag === 'DETAILS' && target.open !== source.open) target.open = source.open;
  if (source.hasAttribute('data-morph-skip')) return;
  morphChildren(target, source);
  if (tag === 'SELECT' && !focused) target.value = source.value;
}

export function morphChildren(target, source) {
  const incoming = [...source.childNodes];
  const keyed = new Map();
  for (const child of target.childNodes) {
    const k = keyOf(child);
    if (k != null) keyed.set(k, child);
  }
  let cursor = target.firstChild;
  for (const next of incoming) {
    const k = keyOf(next);
    let match = null;
    if (k != null) {
      const candidate = keyed.get(k);
      if (candidate && sameKind(candidate, next)) match = candidate;
      if (match) keyed.delete(k);
    } else if (cursor && keyOf(cursor) == null && sameKind(cursor, next)) {
      match = cursor;
    }
    if (match) {
      if (match === cursor) cursor = cursor.nextSibling;
      else target.insertBefore(match, cursor);
      morphNode(match, next);
    } else {
      target.insertBefore(next, cursor);
    }
  }
  while (cursor) {
    const after = cursor.nextSibling;
    target.removeChild(cursor);
    cursor = after;
  }
}

/** Render `children` into `container`, morphing in place. */
export function render(container, ...children) {
  const scratch = document.createElement(container.nodeName);
  appendChildren(scratch, children);
  morphChildren(container, scratch);
}

// ---------------------------------------------------------------------------
// UI state: disclosure, sort and tab state keyed by stable ids. Survives
// re-renders (and navigation within the session).
// ---------------------------------------------------------------------------

const uiStore = new Map();
let rerender = null;
let renderQueued = false;

/** Register the function that re-renders the current page. */
export function onRequestRender(fn) {
  rerender = fn;
}

/** Ask for a re-render on the next frame (coalesced). */
export function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    rerender?.();
  });
}

export const ui = {
  get(key, fallback) {
    return uiStore.has(key) ? uiStore.get(key) : fallback;
  },
  set(key, value) {
    uiStore.set(key, value);
  },
};

/** <details> whose open state is remembered under `key`. */
export function disclosure(key, { summary, open = false, className, onToggle } = {}, ...body) {
  const isOpen = ui.get(`open:${key}`, open);
  return h(
    'details',
    {
      key,
      class: ['disclosure', className],
      open: isOpen,
      on: {
        toggle(event) {
          const el = event.currentTarget;
          if (ui.get(`open:${key}`, open) === el.open) return;
          ui.set(`open:${key}`, el.open);
          onToggle?.(el.open);
          requestRender();
        },
      },
    },
    h('summary', summary),
    // Body is built lazily only when open, to keep the DOM small.
    isOpen ? body.map((b) => (typeof b === 'function' ? b() : b)) : null,
  );
}

// ---------------------------------------------------------------------------
// Live time: elements with data-tick are refreshed every second.
// ---------------------------------------------------------------------------

export function timeEl(iso, { prefix = '', className, suffix = '' } = {}) {
  if (parseTime(iso) == null) return h('span.muted', { class: className, title: iso ? `Unknown time (${iso})` : null }, '—');
  return h(
    'time',
    { class: className, datetime: iso, title: absTime(iso), dataset: { tick: 'rel', prefix, suffix } },
    `${prefix}${relTime(iso)}${suffix}`,
  );
}

/** Live elapsed time since `startIso`. */
export function elapsedEl(startIso, { className } = {}) {
  if (parseTime(startIso) == null) return h('span.muted', '—');
  const start = Date.parse(startIso);
  return h(
    'span',
    { class: ['num', className], title: `Started ${absTime(startIso)}`, dataset: { tick: 'elapsed', start: startIso } },
    duration(Date.now() - start),
  );
}

/** Live age ("12s") since `iso`. */
export function ageEl(iso, { className } = {}) {
  if (parseTime(iso) == null) return h('span', '—');
  return h('span', { class: ['num', className], dataset: { tick: 'elapsed', start: iso } }, duration(Date.now() - Date.parse(iso)));
}

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-tick]')) {
    let text;
    if (el.dataset.tick === 'rel') text = `${el.dataset.prefix ?? ''}${relTime(el.getAttribute('datetime'), now)}${el.dataset.suffix ?? ''}`;
    else {
      const start = parseTime(el.dataset.start);
      text = start == null ? '—' : duration(now - start);
    }
    if (el.textContent !== text) el.textContent = text;
  }
}

let tickTimer = null;
export function startTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (!document.hidden) tick();
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

let announcer = null;
/** Polite screen-reader announcement. */
export function announce(message) {
  if (!announcer) {
    announcer = h('div.sr-only', { 'aria-live': 'polite', role: 'status' });
    document.body.appendChild(announcer);
  }
  announcer.textContent = '';
  setTimeout(() => { announcer.textContent = message; }, 30);
}
