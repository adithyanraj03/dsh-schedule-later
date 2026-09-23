// Bundle-level tests: lib/client.js registers via window.__ModuleLoader__.load,
// wires BOTH composer slots, the ⏱️ flow (draft → confirm → POST + clear input,
// no immediate send) works end-to-end, the dock refreshes immediately on
// session switch (FIX1), the new collapse policy renders (FIX2), and the
// mobile layout applies (FIX5). Model switching is GONE (FIX3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STATE = '/plugin-data/dsh-schedule-later/state';

function loadBundle(react) {
  let def = null;
  global.window = { __ModuleLoader__: { load: (d) => { def = d; } } };
  // eslint-disable-next-line no-eval
  eval(readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8'));
  assert.ok(def, 'bundle registered itself');
  assert.equal(def.id, 'dsh-schedule-later');
  return def.factory((id) => {
    if (id === 'react' || id === 'react/jsx-runtime') return react;
    throw new Error('unexpected require: ' + id);
  });
}

const dumbReact = {
  createElement: () => null,
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
};

/** Minimal interactive React: state that persists across manual re-renders,
 *  plus a useEffect recorder whose pending callbacks tests run by hand. */
function makeInteractiveReact() {
  const self = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } };
    },
    useState(v) {
      const i = self.__hi++;
      if (!self.__hooks[i]) self.__hooks[i] = { value: typeof v === 'function' ? v() : v };
      const slot = self.__hooks[i];
      return [slot.value, (nv) => { slot.value = typeof nv === 'function' ? nv(slot.value) : nv; }];
    },
    useRef(v) {
      // same slot sequence as useState, as in real React
      const i = self.__hi++;
      if (!self.__hooks[i]) self.__hooks[i] = { value: { current: v } };
      return self.__hooks[i].value;
    },
    useEffect(fn, deps) {
      const i = self.__ei++;
      const slot = self.__effects[i] || (self.__effects[i] = { ran: false, last: undefined });
      const changed = !slot.ran || !deps || deps.some((d, j) => d !== slot.last?.[j]);
      if (changed) { slot.ran = true; slot.last = deps; self.__pending.push(fn); }
    },
    runEffects() { const fns = self.__pending; self.__pending = []; for (const fn of fns) fn(); },
    reset() { self.__hi = 0; self.__ei = 0; }, // keep hook slots: state persists across renders
    clear() { self.__hooks = []; self.__hi = 0; self.__effects = []; self.__ei = 0; self.__pending = []; },
    __hooks: [], __hi: 0, __effects: [], __ei: 0, __pending: [],
  };
  return self;
}

function applySlots(mod, sessions) {
  const captured = { right: null, dock: null, sidebar: null, props: null };
  const fakeCtx = {
    inject: (names, fn) => fn({
      slots: {
        inject: (name, reg) => {
          const r = reg({});
          if (name === 'conversation.input.right') captured.right = r;
          if (name === 'conversation.input.dock') captured.dock = r;
          if (name === 'sidebar.footer.action') captured.sidebar = r;
        },
        register: (o, C) => { o.__comp = C; return o; },
      },
      sessions,
    }),
  };
  mod.apply(fakeCtx);
  captured.props = {
    right: captured.right.inject('sess-1'),
    dock: captured.dock.inject('sess-1'),
  };
  return captured;
}

function findAll(node, pred, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return out;
  if (Array.isArray(node)) { for (const k of node) findAll(k, pred, out, depth + 1); return out; }
  if (pred(node)) out.push(node);
  const kids = node.props?.children;
  const arr = Array.isArray(kids) ? kids : kids !== undefined ? [kids] : [];
  for (const k of arr) findAll(k, pred, out, depth + 1);
  return out;
}
const texts = (node) => findAll(node, (n) => typeof n === 'object' && Array.isArray(n.props?.children))
  .flatMap((n) => n.props.children.filter((c) => typeof c === 'string' || typeof c === 'number'));

function expandFn(node, depth = 0) {
  if (Array.isArray(node)) return node.map((k) => expandFn(k, depth + 1));
  if (!node || typeof node !== 'object' || depth > 40) return node;
  if (typeof node.type === 'function') return expandFn(node.type({ ...(node.props || {}) }), depth + 1);
  const kids = node.props?.children;
  const arr = Array.isArray(kids) ? kids : kids !== undefined ? [kids] : [];
  return { ...node, props: { ...node.props, children: arr.map((k) => (k && typeof k === 'object' ? expandFn(k, depth + 1) : k)) } };
}

test('bundle: slots wired (input.right + input.dock ONLY — modelDirectories gone), core hits the state route', async () => {
  const mod = loadBundle(dumbReact);
  assert.deepEqual([...mod.inject].sort(), ['sessions', 'slots'], 'FIX3: modelDirectories gone; 0.3.0 adds sessions for sidebar jumps');
  const captured = applySlots(mod);
  assert.equal(captured.right.name, 'conversation.input.right');
  assert.equal(captured.right.id, 'dsh-schedule-later');
  assert.equal(captured.dock.name, 'conversation.input.dock');
  assert.equal(captured.props.right.sessionId, 'sess-1');
  assert.equal(captured.props.right.modelList, undefined, 'FIX3: no model dropdown data anymore');

  let called = null;
  globalThis.fetch = async (path) => {
    called = path;
    return { ok: true, json: async () => ({ now: 0, tasks: [] }) };
  };
  await mod.core.refresh();
  assert.equal(called, STATE + '?conversationId=sess-1', 'FIX2: state polled per current session');
});

test('bundle: core POSTs schedule to the schedule route and DELETEs on cancel', async () => {
  const mod = loadBundle(dumbReact);
  const calls = [];
  globalThis.fetch = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body });
    if ((opts.method || 'GET') === 'POST' && path.endsWith('/schedule')) {
      return { ok: true, json: async () => ({ task: { id: 't1', content: 'x', sendAt: 9, conversationId: 'sess-1' } }) };
    }
    if ((opts.method || 'GET') === 'DELETE') return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ now: 0, tasks: [] }) };
  };
  const task = await mod.core.scheduleMessage({ content: 'x', sendAt: 9, conversationId: 'sess-1' });
  assert.equal(task.id, 't1');
  assert.equal(calls[0].path, STATE.replace(/\/state$/, '/schedule'));
  assert.equal(calls[0].method, 'POST');
  await mod.core.cancelTask('t1');
  const del = calls.find((c) => c.method === 'DELETE');
  assert.match(del.path, /schedule\?id=t1$/);
});

test('bundle: ⏱️ flow — popover defaults to now+5min, NO model dropdown, confirm POSTs the DRAFT and clears the input', async () => {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod);
  const posted = [];
  const core = captured.props.right.core;
  core.scheduleMessage = async (p) => { posted.push(p); return { task: { id: 't1', ...p } }; };

  const draft = 'first line\n  indented markdown `code`';
  const props = {
    ...captured.props.right,
    useInput: (sel) => draft,
    inputActions: { setDraft: (t) => { props.__setDraft.push(t); }, submit: () => { throw new Error('must NOT send immediately'); } },
    __setDraft: [],
  };

  // initial render: only the ⏱️ button
  react.reset();
  let tree = expandFn(captured.right.__comp(props));
  const alarm = findAll(tree, (n) => n.type === 'button' && texts(n).join('').includes('Schedule'))[0];
  assert.ok(alarm, 'Schedule button rendered in the composer tool row');
  assert.equal(findAll(tree, (n) => n.props?.['data-send-at'] !== undefined).length, 0, 'popover closed initially');

  // click ⏱️ → popover with time default now+5min, model dropdown GONE
  alarm.props.onClick();
  react.reset();
  tree = expandFn(captured.right.__comp(props));
  const timeInput = findAll(tree, (n) => n.props?.['data-send-at'] !== undefined)[0];
  assert.ok(timeInput, 'the popover opens, carrying the chosen time');
  assert.equal(timeInput.props['data-layout'], 'side', 'desktop: the date & time picker is a panel on the right');
  assert.ok(findAll(tree, (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-picker').length === 1, 'picker panel rendered');
  const expected = new Date(Date.now() + 5 * 60_000);
  const pad = (n) => String(n).padStart(2, '0');
  const want = `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}T${pad(expected.getHours())}:${pad(expected.getMinutes())}`;
  assert.equal(timeInput.props['data-send-at'], want, 'default time = now + 5 minutes');
  assert.equal(findAll(tree, (n) => n.type === 'select').length, 0, 'FIX3: no model dropdown in the popover');
  assert.ok(!JSON.stringify(texts(tree)).includes('switch model'), 'FIX3: no model-switch label anywhere');

  // confirm (no model to pick)
  const confirm = findAll(tree, (n) => n.type === 'button' && /Confirm/.test(texts(n).join('')))[0];
  assert.ok(confirm, 'confirm button rendered');
  await confirm.props.onClick();

  assert.equal(posted.length, 1, 'exactly one POST');
  assert.equal(posted[0].content, draft, 'the composer DRAFT becomes the task content');
  assert.ok(posted[0].sendAt > Date.now(), 'sendAt in the future');
  assert.equal(posted[0].conversationId, 'sess-1');
  assert.equal(posted[0].model, undefined, 'FIX3: no model in the payload');
  assert.deepEqual(props.__setDraft, [''], 'input cleared via inputActions.setDraft("")');
});

test('bundle FIX1: dock re-fetches IMMEDIATELY when sessionId prop changes', async () => {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod);
  const core = captured.props.dock.core;
  const urls = [];
  const data = {
    'sess-1': { now: 0, tasks: [{ id: 'a', content: 'A', sendAt: 5, conversationId: 'sess-1' }] },
    'sess-2': { now: 0, tasks: [{ id: 'b', content: 'B', sendAt: 6, conversationId: 'sess-2' }] },
  };
  globalThis.fetch = async (path) => {
    urls.push(path);
    const cid = new URL(path, 'http://x').searchParams.get('conversationId');
    return { ok: true, json: async () => data[cid] ?? { now: 0, tasks: [] } };
  };

  const render = (sid) => {
    react.reset();
    return expandFn(captured.dock.__comp({ core, sessionId: sid }));
  };
  render('sess-1');
  react.runEffects(); // FIX1: session effect fetches right away
  await new Promise((r) => setTimeout(r, 5)); // let the async refresh settle
  assert.ok(urls.some((u) => u.includes('conversationId=sess-1')), 'immediate fetch on mount');
  assert.deepEqual(core.visibleTasks().map((t) => t.id), ['a']);

  // switch conversation: props.sessionId changes → effect re-runs immediately
  render('sess-2');
  const before = urls.length;
  react.runEffects();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(urls.length > before, 'FIX1: sessionId change triggers a fresh fetch');
  assert.deepEqual(core.visibleTasks().map((t) => t.id), ['b'], 'the NEW session list is shown instantly');
});

test('bundle FIX2: dock collapse policy — >1 shows ONLY the soonest entry + "N more scheduled ⌄", expand/collapse works', async () => {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod);
  const core = captured.props.dock.core;
  const base = Date.now() + 60_000;
  const tasks = [
    { id: 't4', content: 'd', sendAt: base + 30_000, conversationId: 'sess-1' },
    { id: 't1', content: 'a', sendAt: base + 0, conversationId: 'sess-1' },
    { id: 't2', content: 'b', sendAt: base + 10_000, conversationId: 'sess-1' },
    { id: 't3', content: 'c', sendAt: base + 20_000, conversationId: 'sess-1' },
  ];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ now: 0, tasks }) });
  await core.refresh();

  const render = () => {
    react.reset();
    return expandFn(captured.dock.__comp({ ...captured.props.dock }));
  };
  let tree = render();
  let mono = findAll(tree, (n) => n.props?.style?.fontFamily === 'monospace');
  assert.equal(mono.length, 1, 'only ONE entry visible by default (the soonest)');
  assert.equal((Array.isArray(mono[0].props.children) ? mono[0].props.children[0] : mono[0].props.children), 'a', 'soonest (sendAt-min) entry shown');
  const all = JSON.stringify(texts(tree));
  assert.match(all, /3 more scheduled/, 'summary row for the remaining 3');

  // expand → all 4
  let toggle = findAll(tree, (n) => n.type === 'button' && /scheduled ⌄/.test(texts(n).join('')))[0];
  toggle.props.onClick();
  tree = render();
  mono = findAll(tree, (n) => n.props?.style?.fontFamily === 'monospace');
  assert.equal(mono.length, 4, 'expanded shows the full list');
  const order = mono.map((n) => (Array.isArray(n.props.children) ? n.props.children[0] : n.props.children));
  assert.deepEqual(order, ['a', 'b', 'c', 'd'], 'entries in sendAt ascending order');

  // collapse again → back to 1 + summary
  toggle = findAll(tree, (n) => n.type === 'button' && /Collapse/.test(texts(n).join('')))[0];
  assert.ok(toggle, 'collapse toggle rendered while expanded');
  toggle.props.onClick();
  tree = render();
  mono = findAll(tree, (n) => n.props?.style?.fontFamily === 'monospace');
  assert.equal(mono.length, 1, 'collapsed again to the single soonest entry');

  // single entry: user had collapsed — summary shows it; expand reveals it;
  // collapse again hides it entirely (manual collapse works for ANY count)
  await core.cancelTask('t1'); await core.cancelTask('t2'); await core.cancelTask('t3');
  tree = render();
  assert.equal(findAll(tree, (n) => n.props?.style?.fontFamily === 'monospace').length, 0, 'single entry stays collapsed under the prior override');
  assert.match(JSON.stringify(texts(tree)), /1 scheduled/, 'summary shows the hidden single task');
  toggle = findAll(tree, (n) => n.type === 'button' && /scheduled ⌄/.test(texts(n).join('')))[0];
  toggle.props.onClick();
  tree = render();
  assert.equal(findAll(tree, (n) => n.props?.style?.fontFamily === 'monospace').length, 1, 'single entry visible once expanded');
  toggle = findAll(tree, (n) => n.type === 'button' && /Collapse/.test(texts(n).join('')))[0];
  toggle.props.onClick();
  tree = render();
  assert.equal(findAll(tree, (n) => n.props?.style?.fontFamily === 'monospace').length, 0, 'single entry collapsible to nothing');
  assert.match(JSON.stringify(texts(tree)), /1 scheduled/);
});

test('bundle FIX5: mobile (≤480px) — dock fully collapsed by default; popover near-full-width; touch targets ≥40px', async () => {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  global.window.matchMedia = (q) => ({ matches: String(q).includes('480') }); // AFTER loadBundle (it resets window)
  const captured = applySlots(mod);

  // dock: 1 task on mobile → fully collapsed (summary only)
  const core = captured.props.dock.core;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ now: 0, tasks: [{ id: 't1', content: 'a', sendAt: Date.now() + 60_000, conversationId: 'sess-1' }] }),
  });
  await core.refresh();
  react.reset();
  let tree = expandFn(captured.dock.__comp({ ...captured.props.dock }));
  assert.equal(findAll(tree, (n) => n.props?.style?.fontFamily === 'monospace').length, 0, 'mobile: no entries by default');
  assert.match(JSON.stringify(texts(tree)), /1 scheduled/, 'mobile: collapsed summary');

  // popover: near-full-width + ≥40px touch targets
  const bprops = { ...captured.props.right, useInput: () => 'x', inputActions: {} };
  react.reset();
  const alarm = findAll(expandFn(captured.right.__comp(bprops)), (n) => n.type === 'button' && texts(n).join('').includes('Schedule'))[0];
  alarm.props.onClick();
  react.reset();
  tree = expandFn(captured.right.__comp(bprops));
  const pop = findAll(tree, (n) => n.type === 'div' && String(n.props?.style?.width || '').includes('100vw'))[0];
  assert.ok(pop, 'mobile: popover width uses ~100vw');
  const btns = findAll(tree, (n) => n.type === 'button' && /Confirm|Cancel/.test(texts(n).join('')));
  assert.ok(btns.length >= 2, 'confirm + cancel buttons present');
  for (const b of btns) assert.ok(Number(b.props.style.minHeight) >= 40, 'touch target ≥40px');
  assert.equal(findAll(tree, (n) => n.props?.['data-send-at'] !== undefined)[0].props['data-layout'], 'stack', 'mobile: picker folds under the popover');
  const toggle = findAll(tree, (n) => n.type === 'button' && /Change date/.test(texts(n).join('')))[0];
  assert.ok(Number(toggle.props.style.minHeight) >= 40, 'picker toggle touch target ≥40px');

  delete global.window.matchMedia;
});

test('bundle FIX1: failed state fetch keeps the old list and shows an error line (no flash-to-empty)', async () => {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod);
  const core = captured.props.dock.core;
  let fail = false;
  globalThis.fetch = async () => {
    if (fail) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ({ now: 0, tasks: [{ id: 'a', content: 'A', sendAt: Date.now() + 60_000, conversationId: 'sess-1' }] }) };
  };
  await core.refresh();
  fail = true;
  await core.refresh();
  react.reset();
  const tree = expandFn(captured.dock.__comp({ ...captured.props.dock }));
  assert.equal(findAll(tree, (n) => n.props?.style?.fontFamily === 'monospace').length, 1, 'old entry still rendered after a failed refresh');
  assert.match(JSON.stringify(texts(tree)), /Could not refresh/, 'error surfaced inline');
});

// --- 0.3.0: sidebar "Scheduled" panel ---------------------------------------------
function mkSessions(byId) {
  const opened = [];
  return {
    list: { getSnapshot: () => ({ byId }) },
    open: (id) => { if (!(id in byId)) throw new Error('unknown session'); opened.push(id); },
    opened,
  };
}

test('sidebar: footer action registered; entry shows the ALL-sessions badge; panel lists tasks sorted asc with session labels', async () => {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const sessions = mkSessions({
    'sess-1': { id: 'sess-1', displayTitle: 'Chat one' },
    'sess-2': { id: 'sess-2', displayTitle: 'Chat two' },
  });
  const captured = applySlots(mod, sessions);
  assert.ok(captured.sidebar, 'sidebar.footer.action registration captured');
  assert.equal(captured.sidebar.name, 'sidebar.footer.action');
  assert.equal(captured.sidebar.id, 'dsh-schedule-later');

  const base = Date.now() + 60_000;
  const allTasks = [
    { id: 't2', content: 'second task', sendAt: base + 20_000, conversationId: 'sess-2' },
    { id: 't1', content: 'first task\nwith a newline', sendAt: base + 10_000, conversationId: 'sess-1' },
  ];
  const urls = [];
  globalThis.fetch = async (path) => {
    urls.push(path);
    return { ok: true, json: async () => ({ now: 0, tasks: allTasks }) };
  };

  // initial render: footer entry with badge = 2 (ALL sessions)
  react.reset();
  let tree = expandFn(captured.sidebar.__comp({ wide: true }));
  const entryBtn = findAll(tree, (n) => n.type === 'button' && /Scheduled/.test(texts(n).join('')))[0];
  assert.ok(entryBtn, 'sidebar entry button rendered');
  react.runEffects(); // mount effect polls the full state
  await new Promise((r) => setTimeout(r, 5));
  react.reset();
  tree = expandFn(captured.sidebar.__comp({ wide: true }));
  assert.match(JSON.stringify(texts(tree)), /2/, 'badge shows the all-sessions pending count');

  // open the panel: fetches the FULL state (no conversationId filter)
  entryBtn.props.onClick();
  react.reset();
  tree = expandFn(captured.sidebar.__comp({ wide: true }));
  react.runEffects();
  await new Promise((r) => setTimeout(r, 5));
  react.reset();
  tree = expandFn(captured.sidebar.__comp({ wide: true }));
  assert.ok(urls.some((u) => !u.includes('conversationId=')), 'panel fetches the unfiltered all-tasks state');
  const rows = findAll(tree, (n) => n.props?.['data-task']);
  assert.equal(rows.length, 2, 'both sessions’ tasks listed');
  assert.deepEqual(rows.map((r) => r.props['data-task']), ['t1', 't2'], 'sendAt ascending');
  const flat = JSON.stringify(texts(tree));
  assert.match(flat, /Chat one/, 'session label from the session list');
  assert.match(flat, /Chat two/, 'second session label');
  assert.match(flat, /first task/, 'content summary present');
});

test('sidebar: entry click jumps via sessions.open; missing session → greyed out, still cancellable; empty state', async () => {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const sessions = mkSessions({ 'sess-1': { id: 'sess-1', displayTitle: 'Chat one' } });
  const captured = applySlots(mod, sessions);
  const base = Date.now() + 60_000;
  const allTasks = [
    { id: 't1', content: 'ok', sendAt: base, conversationId: 'sess-1' },
    { id: 't2', content: 'orphan', sendAt: base + 5_000, conversationId: 'gone' },
  ];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ now: 0, tasks: allTasks }) });
  react.reset();
  let tree = expandFn(captured.sidebar.__comp({}));
  const entryBtn = findAll(tree, (n) => n.type === 'button' && /Scheduled/.test(texts(n).join('')))[0];
  entryBtn.props.onClick();
  react.runEffects();
  await new Promise((r) => setTimeout(r, 5));
  react.reset();
  tree = expandFn(captured.sidebar.__comp({}));
  const rows = findAll(tree, (n) => n.props?.['data-task']);
  assert.equal(rows.length, 2);

  // click the live entry → sessions.open(sessionId)
  rows.find((r) => r.props['data-task'] === 't1').props.onClick();
  assert.equal(sessions.opened.length, 1, 'entry click calls sessions.open once');
  assert.equal(sessions.opened[0], 'sess-1');

  // missing-session entry: grayed (opacity < 1), labelled "Chat no longer exists", click does NOT navigate, cancel still works
  const orphan = rows.find((r) => r.props['data-task'] === 't2');
  assert.ok(Number(orphan.props.style.opacity) < 1, 'orphan entry grayed');
  assert.match(JSON.stringify(texts(orphan)), /Chat no longer exists/, 'missing-session label');
  const before = sessions.opened.length;
  orphan.props.onClick();
  assert.equal(sessions.opened.length, before, 'orphan click does not navigate');
  const cancel = findAll(orphan, (n) => n.type === 'button' && /Cancel/.test(texts(n).join('')))[0];
  assert.ok(cancel, 'cancel button on the orphan entry');
  const del = [];
  globalThis.fetch = async (path, opts = {}) => {
    if ((opts.method || 'GET') === 'DELETE') { del.push(path); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ now: 0, tasks: allTasks.filter((t) => t.id !== 't2') }) };
  };
  await cancel.props.onClick();
  assert.equal(del.length, 1, 'cancel reuses the existing DELETE route');
  assert.match(del[0], /schedule\?id=t2$/);
});

test('sidebar: empty state is friendly; mobile panel spans the viewport', async () => {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const sessions = mkSessions({});
  const captured = applySlots(mod, sessions);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ now: 0, tasks: [] }) });
  react.reset();
  let tree = expandFn(captured.sidebar.__comp({}));
  assert.doesNotMatch(JSON.stringify(texts(tree)), /[0-9]/, 'no numeric badge when zero tasks');
  const entryBtn = findAll(tree, (n) => n.type === 'button' && /Scheduled/.test(texts(n).join('')))[0];
  entryBtn.props.onClick();
  react.runEffects();
  await new Promise((r) => setTimeout(r, 5));
  react.reset();
  tree = expandFn(captured.sidebar.__comp({}));
  assert.match(JSON.stringify(texts(tree)), /No scheduled messages/, 'friendly empty state');

  // mobile: panel width ~100vw
  global.window.matchMedia = (q) => ({ matches: String(q).includes('480') });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ now: 0, tasks: [{ id: 't1', content: 'x', sendAt: Date.now() + 60_000, conversationId: 's' }] }) });
  // panel stays open; only the viewport changed
  react.reset();
  tree = expandFn(captured.sidebar.__comp({}));
  const panel = findAll(tree, (n) => n.type === 'div' && String(n.props?.style?.width || '').includes('100vw'))[0];
  assert.ok(panel, 'mobile: panel width uses ~100vw');
  delete global.window.matchMedia;
});

/* ---- date & time picker (the popover's right-hand panel) ---------------- */

/** Open the popover with a fixed default send time; returns a re-render fn. */
function openPickerAt(when) {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod);
  captured.props.right.core.defaultSendAt = () => when.getTime();
  const props = { ...captured.props.right, useInput: () => 'draft', inputActions: {} };
  const render = () => { react.reset(); return expandFn(captured.right.__comp(props)); };
  findAll(render(), (n) => n.type === 'button' && n.props?.['aria-label'] === 'Schedule send')[0].props.onClick();
  return render;
}
const sendAtOf = (tree) => findAll(tree, (n) => n.props?.['data-send-at'] !== undefined)[0].props['data-send-at'];
const byLabel = (tree, label) => findAll(tree, (n) => n.props?.['aria-label'] === label)[0];
const localValue = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const daysAhead = (n, h, m) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, m, 0, 0); return d; };

test('picker: one hour later from 11:30 PM rolls onto the next day', () => {
  const start = daysAhead(2, 23, 30);
  const render = openPickerAt(start);
  byLabel(render(), 'One hour later').props.onClick();
  assert.equal(sendAtOf(render()), localValue(daysAhead(3, 0, 30)));
});

test('picker: minutes step in fives, snapping first (23 → 25 → 20 → 15)', () => {
  const render = openPickerAt(daysAhead(2, 10, 23));
  byLabel(render(), 'Five minutes later').props.onClick();
  assert.equal(sendAtOf(render()), localValue(daysAhead(2, 10, 25)));
  byLabel(render(), 'Five minutes earlier').props.onClick();
  byLabel(render(), 'Five minutes earlier').props.onClick();
  assert.equal(sendAtOf(render()), localValue(daysAhead(2, 10, 15)));
});

test('picker: AM/PM switches the half of the SAME day and shows which is on', () => {
  const render = openPickerAt(daysAhead(2, 10, 25));
  const halves = () => findAll(render(), (n) => n.type === 'button' && /^(AM|PM)$/.test(texts(n).join('')));
  assert.deepEqual(halves().map((b) => [texts(b).join(''), b.props['aria-pressed']]), [['AM', true], ['PM', false]]);
  halves()[1].props.onClick();
  assert.equal(sendAtOf(render()), localValue(daysAhead(2, 22, 25)));
  assert.deepEqual(halves().map((b) => b.props['aria-pressed']), [false, true]);
  halves()[1].props.onClick(); // already PM: nothing moves
  assert.equal(sendAtOf(render()), localValue(daysAhead(2, 22, 25)));
});

test('picker: choosing a calendar day keeps the time; past days are disabled', () => {
  const start = daysAhead(2, 9, 40);
  const render = openPickerAt(start);
  const target = new Date(start);
  target.setDate(start.getDate() > 20 ? start.getDate() - 1 : start.getDate() + 1);
  const cell = byLabel(render(), target.toDateString());
  assert.ok(cell, 'the neighbouring day is in the grid');
  assert.equal(cell.props.disabled, false);
  cell.props.onClick();
  assert.equal(sendAtOf(render()), localValue(new Date(target.getFullYear(), target.getMonth(), target.getDate(), 9, 40)));

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const openToday = openPickerAt(daysAhead(0, 23, 55));
  const old = byLabel(openToday(), yesterday.toDateString());
  if (old) assert.equal(old.props.disabled, true, 'yesterday cannot be picked');
});

test('picker: the sky slider moves by keyboard (5 min, an hour with Page keys) and by pointer', () => {
  const render = openPickerAt(daysAhead(2, 14, 0));
  const slider = () => findAll(render(), (n) => n.props?.role === 'slider')[0];
  assert.equal(slider().props['aria-valuetext'], '2:00 PM');
  slider().props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(sendAtOf(render()), localValue(daysAhead(2, 14, 5)));
  slider().props.onKeyDown({ key: 'PageDown', preventDefault() {} });
  assert.equal(sendAtOf(render()), localValue(daysAhead(2, 13, 5)));
  // halfway along the track is noon; a quarter is 6 AM — same day
  const at = (fraction) => slider().props.onPointerDown({
    clientX: 10 + 288 * fraction, pointerId: 1,
    currentTarget: { getBoundingClientRect: () => ({ left: 10, width: 288 }), setPointerCapture() {} },
  });
  at(0.5);
  assert.equal(sendAtOf(render()), localValue(daysAhead(2, 12, 0)));
  at(0.25);
  assert.equal(sendAtOf(render()), localValue(daysAhead(2, 6, 0)));
  assert.equal(slider().props['aria-valuetext'], '6:00 AM');
});

/* ---- message box in the popover, synced with the composer ---------------- */

function openWithComposer(initial, when) {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod);
  const core = captured.props.right.core;
  if (when) core.defaultSendAt = () => when.getTime();
  const posted = [];
  core.scheduleMessage = async (p) => { posted.push(p); return { task: { id: 't', ...p } }; };
  const composer = { draft: initial, pushes: [] };
  const props = {
    ...captured.props.right,
    useInput: (sel) => sel({ draft: composer.draft }),
    inputActions: { setDraft: (t) => { composer.pushes.push(t); composer.draft = t; } },
  };
  const render = () => { react.reset(); return expandFn(captured.right.__comp(props)); };
  findAll(render(), (n) => n.type === 'button' && n.props?.['aria-label'] === 'Schedule send')[0].props.onClick();
  // Commit the opened popover the way React would: its mount effects run now,
  // before anyone types, not queued up behind later edits.
  render();
  react.runEffects();
  const box = () => findAll(render(), (n) => n.type === 'textarea')[0];
  return { react, render, composer, posted, box };
}

test('editor: the popover shows the composer draft, and typing there edits the composer', async () => {
  const { render, composer, posted, box } = openWithComposer('check the build');
  assert.equal(box().props.value, 'check the build', 'opens with what is in the message box');
  box().props.onChange({ target: { value: 'check the release build' } });
  assert.deepEqual(composer.pushes, ['check the release build'], 'the composer gets the edit');
  assert.equal(box().props.value, 'check the release build');
  await findAll(render(), (n) => n.type === 'button' && /Confirm/.test(texts(n).join('')))[0].props.onClick();
  assert.equal(posted[0].content, 'check the release build', 'the edited text is what gets scheduled');
  assert.equal(composer.pushes.at(-1), '', 'and the composer is cleared afterwards');
});

test('editor: typing in the composer while the popover is open shows up in it', () => {
  const { react, composer, box } = openWithComposer('first');
  box();
  composer.draft = 'first, then more';
  box(); // re-render: the draft effect is now pending
  react.runEffects();
  assert.equal(box().props.value, 'first, then more');
});

test('editor: a late echo of an older keystroke never overwrites newer typing', () => {
  const { react, composer, box } = openWithComposer('');
  box().props.onChange({ target: { value: 'a' } });
  box().props.onChange({ target: { value: 'ab' } });
  composer.draft = 'a'; // the composer store catches up late, one keystroke behind
  box();
  react.runEffects();
  assert.equal(box().props.value, 'ab');
});

test('editor: Ctrl+Enter confirms; an empty message is refused with a reason', async () => {
  const { render, posted, box } = openWithComposer('');
  await box().props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
  assert.equal(posted.length, 0);
  assert.match(JSON.stringify(texts(render())), /message is empty/);
  box().props.onChange({ target: { value: 'ping me' } });
  box().props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(posted[0]?.content, 'ping me');
});

/* ---- click-to-pick lists on the time columns ------------------------------ */

test('picker: clicking the hour opens a list of 12 → 11; picking keeps AM/PM and the day', () => {
  const render = openPickerAt(daysAhead(2, 15, 25)); // 3:25 PM
  byLabel(render(), 'Hour').props.onClick();
  const list = findAll(render(), (n) => n.props?.role === 'listbox')[0];
  const options = findAll(list, (n) => n.props?.role === 'option');
  assert.deepEqual(options.map((o) => texts(o).join('')), ['12', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11']);
  assert.deepEqual(options.filter((o) => o.props['aria-selected']).map((o) => texts(o).join('')), ['03']);
  options[7].props.onClick(); // 07
  const tree = render();
  assert.equal(sendAtOf(tree), localValue(daysAhead(2, 19, 25)), '07 in the afternoon half is 7 PM');
  assert.equal(findAll(tree, (n) => n.props?.role === 'listbox').length, 0, 'the list closes after a pick');
});

test('picker: the minute list is in fives but keeps an exact minute like :23', () => {
  const render = openPickerAt(daysAhead(2, 9, 23));
  byLabel(render(), 'Minute').props.onClick();
  const labels = findAll(render(), (n) => n.props?.role === 'option').map((o) => texts(o).join(''));
  assert.deepEqual(labels, ['00', '05', '10', '15', '20', '23', '25', '30', '35', '40', '45', '50', '55']);
  const pick = findAll(render(), (n) => n.props?.role === 'option' && texts(n).join('') === '45')[0];
  pick.props.onClick();
  assert.equal(sendAtOf(render()), localValue(daysAhead(2, 9, 45)));
});

/* ---- scheduled rows: tinted by the time they send ------------------------- */

async function dockRowFor(sendAt) {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod);
  const core = captured.props.dock.core;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ now: Date.now(), tasks: [{ id: 'r', content: 'hello', sendAt, conversationId: 'sess-1' }] }) });
  await core.refresh();
  react.reset();
  const tree = expandFn(captured.dock.__comp({ ...captured.props.dock }));
  return findAll(tree, (n) => n.type === 'div' && String(n.props?.style?.borderLeft || '').startsWith('3px solid'))[0];
}
const at = (days, hh, mm) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hh, mm, 0, 0); return d.getTime(); };

test('rows: a night send is tinted indigo with a moon pill; a day send blue with a sun pill', async () => {
  const night = await dockRowFor(at(1, 23, 30));
  assert.match(night.props.style.borderLeft, /99,102,241/, 'night accent');
  assert.ok(findAll(night, (n) => /dsl-moonglow/.test(n.props?.className || '')).length === 1, 'moon glyph');
  assert.match(JSON.stringify(texts(night)), /Tomorrow/);
  assert.match(JSON.stringify(texts(night)), /11:30 PM/);

  const day = await dockRowFor(at(1, 10, 5));
  assert.match(day.props.style.borderLeft, /79,158,232/, 'morning accent');
  assert.ok(findAll(day, (n) => /dsl-sunturn/.test(n.props?.className || '')).length === 1, 'sun glyph');
  assert.match(JSON.stringify(texts(day)), /10:05 AM/);
  const pill = findAll(day, (n) => n.props?.title && /\d{4}-\d\d-\d\d \d\d:\d\d/.test(n.props.title))[0];
  assert.ok(pill, 'the exact timestamp is kept as the tooltip');
});

test('rows: only a message in its last minute pulses', async () => {
  const soon = await dockRowFor(Date.now() + 30_000);
  assert.match(soon.props.className, /dsl-due/);
  const later = await dockRowFor(Date.now() + 10 * 60_000);
  assert.doesNotMatch(later.props.className, /dsl-due/);
});
