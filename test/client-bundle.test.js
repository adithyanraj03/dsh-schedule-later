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

test('dock: sits above dsh\'s To-dos (order 0), goal (10) and queue (20), so the To-dos stay next to the message box', () => {
  const captured = applySlots(loadBundle(dumbReact));
  assert.equal(captured.dock.order, -10);
});

test('dock: an expanded list scrolls inside a capped box, with the Collapse toggle outside it', async () => {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod);
  const core = captured.props.dock.core;
  const base = Date.now() + 60_000;
  const tasks = Array.from({ length: 8 }, (_, i) => ({ id: 't' + i, content: 'message ' + i, sendAt: base + i * 60_000, conversationId: 'sess-1' }));
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ now: 0, tasks }) });
  await core.refresh();
  const render = () => { react.reset(); return expandFn(captured.dock.__comp({ ...captured.props.dock })); };

  let tree = render();
  findAll(tree, (n) => n.type === 'button' && /7 more scheduled/.test(texts(n).join('')))[0].props.onClick();
  tree = render();
  const list = findAll(tree, (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-dock-list')[0];
  assert.ok(list, 'the entries are wrapped in a list box');
  assert.equal(list.props.style.overflowY, 'auto');
  assert.equal(list.props.style.maxHeight, 'min(40vh, 320px)');
  assert.equal(findAll(list, (n) => n.props?.style?.fontFamily === 'monospace').length, 8, 'all 8 are in the scrolling box');
  const collapse = findAll(tree, (n) => n.type === 'button' && /Collapse/.test(texts(n).join('')))[0];
  assert.ok(collapse, 'Collapse is rendered');
  assert.equal(findAll(list, (n) => n === collapse).length, 0, 'and is not inside the scrolling box, so it cannot scroll away');
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

  // click the live entry → its details card; "Open chat" there → sessions.open(sessionId)
  rows.find((r) => r.props['data-task'] === 't1').props.onClick();
  assert.equal(sessions.opened.length, 0, 'a row click opens the details, not the chat');
  react.reset();
  tree = expandFn(captured.sidebar.__comp({}));
  const card = findAll(tree, (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-detail')[0];
  assert.ok(card, 'details card open');
  findAll(card, (n) => n.type === 'button' && /Open chat/.test(texts(n).join('')))[0].props.onClick({});
  assert.equal(sessions.opened.length, 1, 'Open chat calls sessions.open once');
  assert.equal(sessions.opened[0], 'sess-1');

  // Open chat closed the panel, as a jump should; reopen it for the rest.
  react.reset();
  findAll(expandFn(captured.sidebar.__comp({})), (n) => n.type === 'button' && /Scheduled/.test(texts(n).join('')))[0].props.onClick();
  react.reset();
  tree = expandFn(captured.sidebar.__comp({}));
  // missing-session entry: grayed (opacity < 1), labelled "Chat no longer exists", click does NOT navigate, cancel still works
  const orphan = findAll(tree, (n) => n.props?.['data-task'] === 't2')[0];
  assert.ok(Number(orphan.props.style.opacity) < 1, 'orphan entry grayed');
  // Rows are grouped by chat; the label is on the orphan chat's heading.
  const orphanGroup = findAll(tree, (n) => n.props?.['data-group'] === 'gone:gone')[0];
  assert.match(JSON.stringify(texts(orphanGroup)), /Chat no longer exists/, 'missing-session label on its chat heading');
  const before = sessions.opened.length;
  orphan.props.onClick();
  assert.equal(sessions.opened.length, before, 'orphan click does not navigate');
  react.reset();
  const orphanCard = findAll(expandFn(captured.sidebar.__comp({})), (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-detail')[0];
  assert.equal(findAll(orphanCard, (n) => n.type === 'button' && /Open chat/.test(texts(n).join(''))).length, 0, 'no Open chat for a deleted chat');
  const cancel = findAll(orphan, (n) => n.type === 'button' && /Cancel/.test(texts(n).join('')))[0];
  assert.ok(cancel, 'cancel button on the orphan entry');
  const del = [];
  globalThis.fetch = async (path, opts = {}) => {
    if ((opts.method || 'GET') === 'DELETE') { del.push(path); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ now: 0, tasks: allTasks.filter((t) => t.id !== 't2') }) };
  };
  cancel.props.onClick({});
  assert.equal(del.length, 0, 'Cancel asks first');
  react.reset();
  const dialog = findAll(expandFn(captured.sidebar.__comp({})), (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-confirm')[0];
  assert.ok(dialog, 'a confirmation dialog');
  findAll(dialog, (n) => n.type === 'button' && /Cancel message/.test(texts(n).join('')))[0].props.onClick({});
  await new Promise((r) => setTimeout(r, 5));
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

/* ---- sidebar footer entry: sized like Settings, icon-only when collapsed ------- */

async function sidebarWith(tasks) {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ now: 0, tasks }) });
  const render = (wide) => { react.reset(); return expandFn(captured.sidebar.__comp({ wide })); };
  render(true);
  react.runEffects(); // the mount effect polls the full state
  await new Promise((r) => setTimeout(r, 5));
  return render;
}
const TASKS = [
  { id: 'a', content: 'one', sendAt: Date.now() + 60_000, conversationId: 's1' },
  { id: 'b', content: 'two', sendAt: Date.now() + 120_000, conversationId: 's2' },
];

test('sidebar: the expanded row has the Settings row measurements', async () => {
  const render = await sidebarWith(TASKS);
  const tree = render(true);
  const root = findAll(tree, (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-sidebar')[0];
  assert.equal(root.props.style.height, 50);
  assert.equal(root.props.style.margin, 0);
  const btn = findAll(root, (n) => n.type === 'button')[0];
  assert.equal(btn.props.style.height, 42);
  assert.equal(btn.props.style.width, 'calc(100% + 4px)');
  assert.equal(btn.props.style.margin, '0 -2px');
  assert.equal(btn.props.style.padding, '0 10px 0 8px');
  assert.match(texts(btn).join(''), /Scheduled/);
});

test('sidebar: collapsed (wide: false) shows the stopwatch alone, the count as a corner badge', async () => {
  const render = await sidebarWith(TASKS);
  const tree = render(false);
  const root = findAll(tree, (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-sidebar')[0];
  assert.equal(root.props.style.justifyContent, 'center');
  const btn = findAll(root, (n) => n.type === 'button')[0];
  assert.equal(btn.props.style.width, 36);
  assert.equal(btn.props.style.height, 36);
  assert.doesNotMatch(texts(btn).join(''), /Scheduled/, 'no label on the rail');
  assert.equal(btn.props.title, 'Scheduled messages (2)');
  const badge = findAll(btn, (n) => n.props?.['data-badge'] !== undefined)[0];
  assert.equal(badge.props.style.position, 'absolute');
  assert.deepEqual(badge.props.children, ['2']);
});

test('sidebar: collapsed with nothing pending shows no badge', async () => {
  const render = await sidebarWith([]);
  const btn = findAll(render(false), (n) => n.type === 'button')[0];
  assert.equal(findAll(btn, (n) => n.props?.['data-badge'] !== undefined).length, 0);
  assert.equal(btn.props.title, 'Scheduled messages');
});

test('sidebar: the panel opens beside the collapsed rail, not over it', async () => {
  for (const [wide, left] of [[true, 12], [false, 64]]) {
    const render = await sidebarWith(TASKS);
    findAll(render(wide), (n) => n.type === 'button')[0].props.onClick();
    const panel = findAll(render(wide), (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-sidebar-panel')[0];
    assert.ok(panel, `panel open (wide: ${wide})`);
    assert.equal(panel.props.style.left, left);
  }
});

/* ---- sidebar panel: closes like a menu ------------------------------------ */

function fakeDom() {
  const on = { doc: {}, win: {} };
  const reg = (bag) => ({
    addEventListener: (t, fn) => { (bag[t] ||= new Set()).add(fn); },
    removeEventListener: (t, fn) => { bag[t]?.delete(fn); },
  });
  return {
    on,
    document: { ...reg(on.doc), activeElement: null },
    window: reg(on.win),
    fire: (bag, type, ev) => { for (const fn of [...(on[bag][type] || [])]) fn(ev); },
  };
}

async function openPanel(dom) {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ now: 0, tasks: TASKS }) });
  global.document = dom.document;
  Object.assign(global.window, dom.window);
  const render = () => { react.reset(); return expandFn(captured.sidebar.__comp({ wide: true })); };
  let tree = render();
  react.runEffects();
  await new Promise((r) => setTimeout(r, 5));
  findAll(render(), (n) => n.type === 'button' && n.props['aria-label'] === 'Scheduled messages')[0].props.onClick();
  tree = render();
  // Attach the root "element": it contains only what we call 'inside'.
  const root = findAll(tree, (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-sidebar')[0];
  root.props.ref.current = { contains: (t) => t === 'inside' };
  react.runEffects(); // the open effect installs the listeners
  const isOpen = () => findAll(render(), (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-sidebar-panel').length === 1;
  return { isOpen };
}

test('sidebar panel: a press outside closes it; a press inside does not', async () => {
  const dom = fakeDom();
  const { isOpen } = await openPanel(dom);
  assert.ok(isOpen(), 'opened');
  dom.fire('doc', 'pointerdown', { target: 'inside' });
  assert.ok(isOpen(), 'a press inside the panel or on its button keeps it open');
  dom.fire('doc', 'pointerdown', { target: 'outside' });
  assert.ok(!isOpen(), 'a press anywhere else closes it');
  delete global.document;
});

test('sidebar panel: Esc closes it', async () => {
  const dom = fakeDom();
  const { isOpen } = await openPanel(dom);
  dom.fire('doc', 'keydown', { key: 'Enter' });
  assert.ok(isOpen(), 'other keys do nothing');
  dom.fire('doc', 'keydown', { key: 'Escape' });
  assert.ok(!isOpen());
  delete global.document;
});

test('sidebar panel: focus moving into an iframe (e.g. the graft viz tab) closes it', async () => {
  const dom = fakeDom();
  const { isOpen } = await openPanel(dom);
  dom.document.activeElement = { tagName: 'BODY' };
  dom.fire('win', 'blur', {});
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(isOpen(), 'leaving the window for another app does not close it');
  dom.document.activeElement = { tagName: 'IFRAME' };
  dom.fire('win', 'blur', {});
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(!isOpen(), 'clicking into an iframe does');
  delete global.document;
});

/* ---- sidebar panel: grouped by chat, day headings, row actions ------------ */

async function panelWith(tasks, sessionsById, fetchImpl) {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod, mkSessions(sessionsById));
  globalThis.fetch = fetchImpl || (async () => ({ ok: true, json: async () => ({ now: 0, tasks }) }));
  const render = () => { react.reset(); return expandFn(captured.sidebar.__comp({ wide: true })); };
  const tree = render();
  findAll(tree, (n) => n.type === 'button' && n.props['aria-label'] === 'Scheduled messages')[0].props.onClick();
  render();
  react.runEffects();
  await new Promise((r) => setTimeout(r, 5));
  return render;
}
const atDay = (days, hh, mm) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hh, mm, 0, 0); return d.getTime(); };
const pad2 = (n) => String(n).padStart(2, '0');

test('panel: rows are grouped by chat under one heading each, soonest chat first', async () => {
  const soon = Date.now() + 120_000;
  const render = await panelWith([
    { id: 'a1', content: 'first in A', sendAt: soon, conversationId: 'A' },
    { id: 'b1', content: 'first in B', sendAt: soon + 60_000, conversationId: 'B' },
    { id: 'a2', content: 'second in A', sendAt: soon + 120_000, conversationId: 'A' },
  ], { A: { id: 'A', displayTitle: 'Chat A' }, B: { id: 'B', displayTitle: 'Chat B' } });
  const tree = render();
  const groups = findAll(tree, (n) => n.props?.['data-group']);
  assert.deepEqual(groups.map((g) => g.props['data-group']), ['A', 'B']);
  assert.deepEqual(findAll(groups[0], (n) => n.props?.['data-task']).map((r) => r.props['data-task']), ['a1', 'a2']);
  const flat = JSON.stringify(texts(tree));
  assert.equal(flat.split('Chat A').length - 1, 1, 'the chat title appears once, on its heading');
});

test('panel: the whole message is shown, clamped to two lines, no native tooltip', async () => {
  const long = 'x'.repeat(300);
  const render = await panelWith([{ id: 't', content: long, sendAt: Date.now() + 120_000, conversationId: 'A' }], { A: { id: 'A', displayTitle: 'A' } });
  const body = findAll(render(), (n) => n.props && 'data-content' in n.props)[0];
  assert.equal(body.props.title, undefined, 'no native tooltip: the details card shows the full text');
  assert.equal(findAll(render(), (n) => n.props?.['data-task'])[0].props.title, undefined);
  assert.equal(body.props.style.WebkitLineClamp, 2);
  assert.deepEqual(body.props.children, [long], 'not cut to 50 characters any more');
});

test('panel: a day heading wherever the day changes; none for Today', async () => {
  const render = await panelWith([
    { id: 'tom1', content: 'b', sendAt: atDay(1, 9, 0), conversationId: 'A' },
    { id: 'tom2', content: 'c', sendAt: atDay(1, 10, 0), conversationId: 'A' },
    { id: 'later', content: 'd', sendAt: atDay(3, 9, 0), conversationId: 'A' },
    { id: 'today', content: 'a', sendAt: Date.now() + 60_000, conversationId: 'B' },
  ], { A: { id: 'A', displayTitle: 'A' }, B: { id: 'B', displayTitle: 'B' } });
  const tree = render();
  const daysIn = (key) => findAll(findAll(tree, (n) => n.props?.['data-group'] === key)[0], (n) => n.props?.['data-day']).map((n) => n.props['data-day']);
  const a = daysIn('A');
  assert.equal(a.length, 2, 'Tomorrow once for its two rows, then the later day');
  assert.equal(a[0], 'Tomorrow');
  const b = daysIn('B');
  // a message due within the minute is Today unless the test runs at 23:59
  if (new Date(Date.now() + 60_000).getDate() === new Date().getDate()) assert.deepEqual(b, [], 'Today needs no heading');
});

test('panel: Send now opens a confirmation, then PATCHes {now: true}', async () => {
  const calls = [];
  const tasks = [{ id: 't1', content: 'x', sendAt: Date.now() + 600_000, conversationId: 'A' }];
  const render = await panelWith(tasks, { A: { id: 'A', displayTitle: 'A' } }, async (path, opts = {}) => {
    if (opts.method === 'PATCH') { calls.push({ path, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ now: 0, tasks }) };
  });
  findAll(render(), (n) => n.type === 'button' && n.props['aria-label'] === 'Send now')[0].props.onClick({});
  assert.equal(calls.length, 0, 'the icon only asks');
  const dialog = findAll(render(), (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-confirm')[0];
  assert.match(JSON.stringify(texts(dialog)), /Send this message now\?/);
  const confirm = findAll(dialog, (n) => n.type === 'button' && /^Send now$/.test(texts(n).join('')))[0];
  confirm.props.onClick({});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /schedule\?id=t1$/);
  assert.deepEqual(calls[0].body, { now: true });
});

test('panel: Change time edits in place, refuses the past, PATCHes the new sendAt', async () => {
  const calls = [];
  const tasks = [{ id: 't1', content: 'x', sendAt: Date.now() + 600_000, conversationId: 'A' }];
  const render = await panelWith(tasks, { A: { id: 'A', displayTitle: 'A' } }, async (path, opts = {}) => {
    if (opts.method === 'PATCH') { calls.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ now: 0, tasks }) };
  });
  findAll(render(), (n) => n.type === 'button' && n.props['aria-label'] === 'Change time')[0].props.onClick({});
  let input = findAll(render(), (n) => n.type === 'input' && n.props.type === 'datetime-local')[0];
  assert.ok(input, "a time field replaces the row's time line");
  input.props.onChange({ target: { value: '2001-01-01T09:00' } });
  findAll(render(), (n) => n.type === 'button' && /^Save$/.test(texts(n).join('')))[0].props.onClick({});
  assert.match(JSON.stringify(texts(render())), /Pick a time in the future/);
  assert.equal(calls.length, 0, 'nothing sent for a past time');
  const target = new Date(Date.now() + 2 * 86_400_000);
  target.setSeconds(0, 0);
  const value = `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}T${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  input = findAll(render(), (n) => n.type === 'input' && n.props.type === 'datetime-local')[0];
  input.props.onChange({ target: { value } });
  findAll(render(), (n) => n.type === 'button' && /^Save$/.test(texts(n).join('')))[0].props.onClick({});
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, [{ sendAt: target.getTime() }]);
  assert.equal(findAll(render(), (n) => n.type === 'input').length, 0, 'the editor closes');
});

test('panel: Cancel all for a chat asks first, then cancels every message in it', async () => {
  const del = [];
  const tasks = [
    { id: 'a1', content: 'x', sendAt: Date.now() + 120_000, conversationId: 'A' },
    { id: 'a2', content: 'y', sendAt: Date.now() + 180_000, conversationId: 'A' },
    { id: 'b1', content: 'z', sendAt: Date.now() + 240_000, conversationId: 'B' },
  ];
  const render = await panelWith(tasks, { A: { id: 'A', displayTitle: 'A' }, B: { id: 'B', displayTitle: 'B' } }, async (path, opts = {}) => {
    if (opts.method === 'DELETE') { del.push(path); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ now: 0, tasks }) };
  });
  const group = (key) => findAll(render(), (n) => n.props?.['data-group'] === key)[0];
  assert.equal(findAll(group('B'), (n) => n.type === 'button' && /Cancel all/.test(texts(n).join(''))).length, 0, 'no Cancel all for a single message');
  findAll(group('A'), (n) => n.type === 'button' && /Cancel all/.test(texts(n).join('')))[0].props.onClick({});
  assert.equal(del.length, 0, 'asks first');
  const dialog = findAll(render(), (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-confirm')[0];
  assert.match(JSON.stringify(texts(dialog)), /Cancel all 2 scheduled messages\?/);
  findAll(dialog, (n) => n.type === 'button' && /^Cancel 2 messages$/.test(texts(n).join('')))[0].props.onClick({});
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(del.map((p) => p.split('id=')[1]).sort(), ['a1', 'a2']);
});

/* ---- sidebar panel: the details card ------------------------------------- */

const detailOf = (tree) => findAll(tree, (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-detail')[0];

test('details: clicking a message opens its card with the full text, time, chat and author', async () => {
  const long = 'line one\n' + 'y'.repeat(400);
  const render = await panelWith([
    { id: 't1', content: long, sendAt: Date.now() + 600_000, conversationId: 'A', createdAt: Date.now() - 3_600_000, meta: { scheduledBy: 'assistant' } },
  ], { A: { id: 'A', displayTitle: 'Chat A' } });
  assert.equal(detailOf(render()), undefined, 'closed until a row is clicked');
  findAll(render(), (n) => n.props?.['data-task'] === 't1')[0].props.onClick();
  const card = detailOf(render());
  assert.ok(card, 'opened');
  const pre = findAll(card, (n) => n.props && 'data-detail-content' in n.props)[0];
  assert.deepEqual(pre.props.children, [long], 'the whole message, not clamped');
  const flat = JSON.stringify(texts(card));
  assert.match(flat, /Scheduled by the assistant/);
  assert.match(flat, /Chat A/);
  assert.match(flat, /1 h ago/);
  assert.match(flat, /\[Scheduled by the assistant\]/, 'says how it will arrive');
  // clicking the same row again closes it
  findAll(render(), (n) => n.props?.['data-task'] === 't1')[0].props.onClick();
  assert.equal(detailOf(render()), undefined);
});

test('details: a message you scheduled says so; a failed delivery is shown', async () => {
  const render = await panelWith([
    { id: 't1', content: 'x', sendAt: Date.now() + 600_000, conversationId: 'A', attempts: 2, lastError: 'agent busy' },
  ], { A: { id: 'A', displayTitle: 'A' } });
  findAll(render(), (n) => n.props?.['data-task'] === 't1')[0].props.onClick();
  const flat = JSON.stringify(texts(detailOf(render())));
  assert.match(flat, /Scheduled by you/);
  assert.match(flat, /Delivery tried 2 times/);
  assert.match(flat, /agent busy/);
});

test('details: Send now (confirmed), Change time and Cancel act on that message', async () => {
  const calls = [];
  const tasks = [{ id: 't1', content: 'x', sendAt: Date.now() + 600_000, conversationId: 'A' }];
  const render = await panelWith(tasks, { A: { id: 'A', displayTitle: 'A' } }, async (path, opts = {}) => {
    if (opts.method === 'PATCH' || opts.method === 'DELETE') { calls.push({ method: opts.method, path, body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ now: 0, tasks }) };
  });
  const btn = (re) => findAll(detailOf(render()), (n) => n.type === 'button' && re.test(texts(n).join('')))[0];
  findAll(render(), (n) => n.props?.['data-task'] === 't1')[0].props.onClick();

  // Change time opens its editor in the card, not in the row
  btn(/^Change time$/).props.onClick({});
  assert.equal(findAll(detailOf(render()), (n) => n.type === 'input').length, 1, 'editor in the card');
  assert.equal(findAll(render(), (n) => n.type === 'input').length, 1, 'and only there');
  btn(/^Back$/).props.onClick({});

  btn(/^Send now$/).props.onClick({});
  assert.equal(calls.length, 0, 'it asks first');
  const dialog = findAll(render(), (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-confirm')[0];
  findAll(dialog, (n) => n.type === 'button' && /^Send now$/.test(texts(n).join('')))[0].props.onClick({});
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls.map((c) => [c.method, c.body]), [['PATCH', { now: true }]]);
  assert.equal(detailOf(render()), undefined, 'the card closes once it is sent');
});

test('details: Esc closes the card first, then the panel', async () => {
  const dom = fakeDom();
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod, mkSessions({ A: { id: 'A', displayTitle: 'A' } }));
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ now: 0, tasks: [{ id: 't1', content: 'x', sendAt: Date.now() + 600_000, conversationId: 'A' }] }) });
  global.document = dom.document;
  Object.assign(global.window, dom.window);
  const render = () => { react.reset(); return expandFn(captured.sidebar.__comp({ wide: true })); };
  render();
  react.runEffects();
  await new Promise((r) => setTimeout(r, 5));
  findAll(render(), (n) => n.type === 'button' && n.props['aria-label'] === 'Scheduled messages')[0].props.onClick();
  render();
  react.runEffects();
  await new Promise((r) => setTimeout(r, 5));
  findAll(render(), (n) => n.props?.['data-task'] === 't1')[0].props.onClick();
  assert.ok(detailOf(render()), 'card open');
  dom.fire('doc', 'keydown', { key: 'Escape' });
  assert.equal(detailOf(render()), undefined, 'first Esc: the card');
  assert.equal(findAll(render(), (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-sidebar-panel').length, 1, 'the panel stays');
  dom.fire('doc', 'keydown', { key: 'Escape' });
  assert.equal(findAll(render(), (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-sidebar-panel').length, 0, 'second Esc: the panel');
  delete global.document;
});

/* ---- confirmations and tooltips ------------------------------------------- */

const confirmOf = (tree) => findAll(tree, (n) => n.props?.['data-plugin'] === 'dsh-schedule-later-confirm')[0];

test('confirm: says what will happen, shows the message, and Keep / the backdrop do nothing', async () => {
  const calls = [];
  const tasks = [{ id: 't1', content: 'Push the release tag', sendAt: atDay(1, 9, 30), conversationId: 'A' }];
  const render = await panelWith(tasks, { A: { id: 'A', displayTitle: 'Release chat' } }, async (path, opts = {}) => {
    if (opts.method) calls.push(opts.method);
    return { ok: true, json: async () => ({ now: 0, tasks }) };
  });
  const row = () => findAll(render(), (n) => n.props?.['data-task'] === 't1')[0];
  findAll(row(), (n) => n.type === 'button' && /^Cancel$/.test(texts(n).join('')))[0].props.onClick({});
  let dialog = confirmOf(render());
  const flat = JSON.stringify(texts(dialog));
  assert.match(flat, /Cancel this scheduled message\?/);
  assert.match(flat, /9:30 AM/, 'names the time it would have gone out');
  assert.equal(findAll(dialog, (n) => n.props && 'data-confirm-preview' in n.props)[0].props.children[0], 'Push the release tag');
  assert.equal(findAll(dialog, (n) => n.props?.role === 'alertdialog').length, 1);
  findAll(dialog, (n) => n.type === 'button' && /Keep it scheduled/.test(texts(n).join('')))[0].props.onClick({});
  assert.equal(confirmOf(render()), undefined, 'Keep closes it');
  findAll(row(), (n) => n.type === 'button' && n.props['aria-label'] === 'Send now')[0].props.onClick({});
  dialog = confirmOf(render());
  assert.match(JSON.stringify(texts(dialog)), /Release chat/, 'names the chat it goes into');
  dialog.props.onClick({});
  assert.equal(confirmOf(render()), undefined, 'the backdrop closes it');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, [], 'nothing was sent or cancelled');
});

test('confirm: Esc closes the dialog before the card and the panel', async () => {
  const dom = fakeDom();
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod, mkSessions({ A: { id: 'A', displayTitle: 'A' } }));
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ now: 0, tasks: [{ id: 't1', content: 'x', sendAt: Date.now() + 600_000, conversationId: 'A' }] }) });
  global.document = dom.document;
  Object.assign(global.window, dom.window);
  const render = () => { react.reset(); return expandFn(captured.sidebar.__comp({ wide: true })); };
  render();
  react.runEffects();
  await new Promise((r) => setTimeout(r, 5));
  findAll(render(), (n) => n.type === 'button' && n.props['aria-label'] === 'Scheduled messages')[0].props.onClick();
  render();
  react.runEffects();
  await new Promise((r) => setTimeout(r, 5));
  findAll(render(), (n) => n.props?.['data-task'] === 't1')[0].props.onClick();
  findAll(detailOf(render()), (n) => n.type === 'button' && /Cancel message/.test(texts(n).join('')))[0].props.onClick({});
  assert.ok(confirmOf(render()), 'dialog up');
  dom.fire('doc', 'keydown', { key: 'Escape' });
  assert.equal(confirmOf(render()), undefined, 'first Esc: the dialog');
  assert.ok(detailOf(render()), 'the card stays');
  dom.fire('doc', 'keydown', { key: 'Escape' });
  assert.equal(detailOf(render()), undefined, 'second Esc: the card');
  delete global.document;
});

test('confirm: the in-chat list\'s Cancel asks too', async () => {
  const react = makeInteractiveReact();
  const mod = loadBundle(react);
  const captured = applySlots(mod);
  const core = captured.props.dock.core;
  const del = [];
  const tasks = [{ id: 'd1', content: 'check CI', sendAt: Date.now() + 600_000, conversationId: 'sess-1' }];
  globalThis.fetch = async (path, opts = {}) => {
    if (opts.method === 'DELETE') { del.push(path); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ now: 0, tasks }) };
  };
  await core.refresh();
  const render = () => { react.reset(); return expandFn(captured.dock.__comp({ ...captured.props.dock })); };
  findAll(render(), (n) => n.type === 'button' && /^Cancel$/.test(texts(n).join('')))[0].props.onClick();
  assert.equal(del.length, 0, 'asks first');
  const dialog = confirmOf(render());
  assert.match(JSON.stringify(texts(dialog)), /Cancel this scheduled message\?/);
  findAll(dialog, (n) => n.type === 'button' && /Cancel message/.test(texts(n).join('')))[0].props.onClick({});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(del.length, 1);
});

test('tooltips: icon buttons use the styled label, not the native title', async () => {
  const render = await panelWith([{ id: 't1', content: 'x', sendAt: Date.now() + 600_000, conversationId: 'A' }], { A: { id: 'A', displayTitle: 'A' } });
  const icons = findAll(render(), (n) => n.type === 'button' && n.props['data-tip']);
  assert.deepEqual(icons.map((b) => b.props['data-tip']).sort(), ['Change time', 'Send now']);
  for (const b of icons) {
    assert.equal(b.props.title, undefined, 'no native tooltip');
    assert.match(b.props.className, /dsl-tip/);
  }
});

test('confirm: Send now has a red button; its paper plane is amber for a day send, blue for a night one', async () => {
  const tasks = [
    { id: 'day', content: 'x', sendAt: atDay(1, 10, 0), conversationId: 'A' },
    { id: 'night', content: 'y', sendAt: atDay(1, 23, 0), conversationId: 'A' },
  ];
  const render = await panelWith(tasks, { A: { id: 'A', displayTitle: 'A' } });
  const toneFor = (id) => {
    findAll(findAll(render(), (n) => n.props?.['data-task'] === id)[0], (n) => n.type === 'button' && n.props['aria-label'] === 'Send now')[0].props.onClick({});
    const dialog = confirmOf(render());
    const badge = findAll(dialog, (n) => n.type === 'span' && n.props?.['aria-hidden'] === 'true')[0];
    const go = findAll(dialog, (n) => n.type === 'button' && /^Send now$/.test(texts(n).join('')))[0];
    findAll(dialog, (n) => n.type === 'button' && /Keep it scheduled/.test(texts(n).join('')))[0].props.onClick({});
    return { badge: badge.props.style.background, button: go.props.style.background };
  };
  const day = toneFor('day');
  const night = toneFor('night');
  assert.equal(day.button, '#ef4444');
  assert.equal(night.button, '#ef4444');
  assert.match(day.badge, /251,191,36/, 'amber by day');
  assert.match(night.badge, /59,130,246/, 'blue by night');
});
