// Red/green TDD: client core — pure logic testable in Node (sorting, collapse,
// immediate server-authoritative enqueue after POST, session-switch refresh,
// mobile detection, cancel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sortTasks, collapseState, formatLocalTime, formatCountdown, sendsIn,
  createScheduledClientState, defaultSendAt, isMobileViewport,
  summarizeContent, annotateSessions,
} from '../src/client-core.js';

test('sortTasks orders by sendAt ascending', () => {
  const tasks = [
    { id: 'b', sendAt: 3 }, { id: 'a', sendAt: 1 }, { id: 'c', sendAt: 2 },
  ];
  assert.deepEqual(sortTasks(tasks).map((t) => t.id), ['a', 'c', 'b']);
  assert.deepEqual(sortTasks(null), []);
});

test('collapseState: 0/1 entries default expanded; >1 default shows ONLY the soonest entry + "N more scheduled ⌄"', () => {
  assert.deepEqual(
    collapseState([]),
    { display: 'expanded', visibleCount: 0, hiddenCount: 0, summary: null, collapsed: false },
  );
  const one = collapseState([{ id: 1 }]);
  assert.equal(one.display, 'expanded');
  assert.equal(one.visibleCount, 1);
  assert.equal(one.summary, 'Collapse ⌃', 'single entry still manually collapsible');
  const two = collapseState([{ id: 1 }, { id: 2 }]);
  assert.equal(two.display, 'one', '>1 entries default to one-visible');
  assert.equal(two.visibleCount, 1);
  assert.equal(two.hiddenCount, 1);
  assert.equal(two.summary, '1 more scheduled ⌄');
  const four = collapseState([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  assert.equal(four.display, 'one');
  assert.equal(four.summary, '3 more scheduled ⌄');
});

test('collapseState: manual expand shows all; manual collapse works for ANY count including 1', () => {
  const expanded = collapseState([{ id: 1 }, { id: 2 }, { id: 3 }], { user: 'expanded' });
  assert.equal(expanded.display, 'expanded');
  assert.equal(expanded.visibleCount, 3);
  assert.equal(expanded.summary, 'Collapse ⌃');
  const collapsedTwo = collapseState([{ id: 1 }, { id: 2 }], { user: 'collapsed' });
  assert.equal(collapsedTwo.display, 'one', '>1 entries collapse back to 1 + rest-summary');
  assert.equal(collapsedTwo.visibleCount, 1);
  assert.equal(collapsedTwo.summary, '1 more scheduled ⌄');
  const oneCollapsed = collapseState([{ id: 1 }], { user: 'collapsed' });
  assert.equal(oneCollapsed.display, 'summary', 'a single entry can be collapsed entirely');
  assert.equal(oneCollapsed.visibleCount, 0);
  assert.equal(oneCollapsed.summary, '1 scheduled ⌄');
});

test('collapseState: mobile defaults to fully collapsed (summary only) even for 1 entry', () => {
  const m1 = collapseState([{ id: 1 }], { mobile: true });
  assert.equal(m1.display, 'summary');
  assert.equal(m1.visibleCount, 0);
  assert.equal(m1.summary, '1 scheduled ⌄');
  const m3 = collapseState([{ id: 1 }, { id: 2 }, { id: 3 }], { mobile: true });
  assert.equal(m3.display, 'summary');
  assert.equal(m3.summary, '3 scheduled ⌄');
  // manual expand wins over the mobile default
  const me = collapseState([{ id: 1 }], { mobile: true, user: 'expanded' });
  assert.equal(me.display, 'expanded');
  assert.equal(me.visibleCount, 1);
});

test('isMobileViewport reads matchMedia((max-width:480px)) safely', () => {
  const mm = (q) => ({ matches: q.includes('480') });
  assert.equal(isMobileViewport(mm), true);
  const mmNo = () => ({ matches: false });
  assert.equal(isMobileViewport(mmNo), false);
  assert.equal(isMobileViewport(null), false, 'no matchMedia → desktop');
  assert.equal(isMobileViewport(() => { throw new Error('x'); }), false, 'never throws');
});

test('formatLocalTime renders local YYYY-MM-DD HH:mm', () => {
  const d = new Date(2026, 0, 5, 7, 9);
  assert.equal(formatLocalTime(d.getTime()), '2026-01-05 07:09');
});

test('formatCountdown renders remaining time until sendAt', () => {
  const now = 1_000_000;
  assert.equal(formatCountdown(now + 90_000, now), '1m 30s');
  assert.equal(formatCountdown(now + 3_600_000, now), '1h 0m');
  assert.equal(formatCountdown(now + 2 * 86400_000 + 3 * 3600_000, now), '2d 3h');
  assert.equal(formatCountdown(now - 5, now), 'now');
  // the phrase callers render: verb first in English, and no "Sends in now"
  assert.equal(sendsIn(now + 90_000, now), 'Sends in 1m 30s');
  assert.equal(sendsIn(now - 5, now), 'Sending now');
  assert.equal(sendsIn(now, now), 'Sending now');
});

test('defaultSendAt = now + 5 minutes', () => {
  assert.equal(defaultSendAt(1_000), 1_000 + 5 * 60_000);
});

test('scheduleMessage POSTs and shows the server task IMMEDIATELY (no refresh needed)', async () => {
  const posted = [];
  const core = createScheduledClientState({
    fetchState: async () => ({ now: 0, tasks: [] }),
    postSchedule: async (payload) => {
      posted.push(payload);
      return { task: { id: 't1', ...payload } };
    },
    cancelSchedule: async () => true,
    now: () => 0,
  });
  const task = await core.scheduleMessage({ content: 'hi', sendAt: 5_000, conversationId: 's1' });
  assert.equal(task.id, 't1');
  assert.deepEqual(posted[0], { content: 'hi', sendAt: 5_000, conversationId: 's1' });
  assert.equal(core.visibleTasks().length, 1, 'server-returned task enqueued right after POST');
  assert.equal(core.visibleTasks()[0].content, 'hi');
});

test('scheduleMessage failure enqueues NOTHING (no optimistic ghost entry)', async () => {
  const core = createScheduledClientState({
    fetchState: async () => ({ now: 0, tasks: [] }),
    postSchedule: async () => { throw new Error('HTTP 500'); },
    cancelSchedule: async () => true,
    now: () => 0,
  });
  await assert.rejects(() => core.scheduleMessage({ content: 'x', sendAt: 5, conversationId: 's' }), /HTTP 500/);
  assert.equal(core.visibleTasks().length, 0, 'nothing added on failure → form can be kept');
});

test('cancelTask removes the entry locally', async () => {
  const core = createScheduledClientState({
    fetchState: async () => ({ now: 0, tasks: [] }),
    postSchedule: async (p) => ({ task: { id: 't1', ...p } }),
    cancelSchedule: async () => true,
    now: () => 0,
  });
  await core.scheduleMessage({ content: 'x', sendAt: 5_000, conversationId: 's' });
  await core.cancelTask('t1');
  assert.equal(core.visibleTasks().length, 0);
});

test('refresh replaces the task list with the server view (sorted, id-deduped)', async () => {
  let server = { now: 0, tasks: [] };
  const core = createScheduledClientState({
    fetchState: async () => server,
    postSchedule: async () => ({}),
    cancelSchedule: async () => true,
    now: () => 0,
  });
  server = { now: 0, tasks: [{ id: 'z', sendAt: 9 }, { id: 'y', sendAt: 2 }] };
  await core.refresh();
  assert.deepEqual(core.visibleTasks().map((t) => t.id), ['y', 'z']);
  // server list containing the same id as a local add → no duplicate
  server = { now: 0, tasks: [{ id: 'z', sendAt: 9 }, { id: 'y', sendAt: 2 }, { id: 't9', sendAt: 5 }] };
  await core.refresh();
  assert.equal(core.visibleTasks().filter((t) => t.id === 't9').length, 1, 'id dedupe on merge');
});

test('refresh failure keeps the LAST data and surfaces an error (no flash-to-empty)', async () => {
  let fail = false;
  const core = createScheduledClientState({
    fetchState: async () => {
      if (fail) throw new Error('state HTTP 500');
      return { now: 0, tasks: [{ id: 'a', sendAt: 2, conversationId: 's' }] };
    },
    postSchedule: async () => ({}),
    cancelSchedule: async () => true,
    now: () => 0,
  });
  core.setSession('s');
  await core.refresh();
  assert.equal(core.visibleTasks().length, 1);
  fail = true;
  await core.refresh();
  assert.equal(core.visibleTasks().length, 1, 'old data retained on failure');
  assert.match(core.lastError(), /500/);
  fail = false;
  await core.refresh();
  assert.equal(core.lastError(), null, 'error cleared on next success');
});

// --- FIX 4: stale-refresh race ------------------------------------------------
test('FIX4 race: a refresh initiated BEFORE the POST but resolved AFTER does not wipe the new entry', async () => {
  let resolveStale;
  const stale = new Promise((r) => { resolveStale = r; });
  let serverList = { now: 0, tasks: [] }; // stale snapshot WITHOUT the new task
  const core = createScheduledClientState({
    fetchState: async () => (await stale) ?? serverList,
    postSchedule: async (p) => ({ task: { id: 't-new', ...p } }),
    cancelSchedule: async () => true,
    now: () => 0,
  });
  core.setSession('s');
  const pending = core.refresh(); // poll fired before the POST was registered server-side
  await core.scheduleMessage({ content: 'mine', sendAt: 9_000, conversationId: 's' });
  assert.equal(core.visibleTasks().map((t) => t.id).includes('t-new'), true);
  resolveStale({ now: 0, tasks: [] }); // stale response arrives late
  await pending;
  assert.equal(core.visibleTasks().map((t) => t.id).includes('t-new'), true, 'recent local add survives a stale overwrite');
});

test('FIX4: local add eventually yields to the authoritative server view (grace expires)', async () => {
  const clock = { t: 0 };
  const core = createScheduledClientState({
    fetchState: async () => ({ now: 0, tasks: [] }),
    postSchedule: async (p) => ({ task: { id: 't-new', ...p } }),
    cancelSchedule: async () => true,
    now: () => clock.t,
  });
  await core.scheduleMessage({ content: 'mine', sendAt: 9_000, conversationId: null });
  clock.t = 60_000; // far past the local-add grace window
  await core.refresh();
  assert.equal(core.visibleTasks().length, 0, 'server list wins once the grace window is over');
});

// --- FIX 1: session switch ----------------------------------------------------
test('FIX1 core: setSession reports the change and the next refresh filters to the new session', async () => {
  let server = { now: 0, tasks: [] };
  const core = createScheduledClientState({
    fetchState: async () => server,
    postSchedule: async () => ({}),
    cancelSchedule: async () => true,
    now: () => 0,
  });
  core.setSession('sess-A');
  assert.equal(core.setSession('sess-A'), false, 'same session → no change');
  assert.equal(core.setSession('sess-B'), true, 'switch detected');
  server = {
    now: 0,
    tasks: [
      { id: 'a', sendAt: 2, conversationId: 'sess-A' },
      { id: 'b', sendAt: 3, conversationId: 'sess-B' },
    ],
  };
  await core.refresh();
  assert.deepEqual(core.visibleTasks().map((t) => t.id), ['b'], 'only the NEW session tasks survive the refresh');
});

test('FIX2 session isolation: setSession filters tasks; other-session leftovers cleared; own-session schedule shows', async () => {
  let server = { now: 0, tasks: [] };
  const core = createScheduledClientState({
    fetchState: async () => server,
    postSchedule: async (p) => ({ task: { id: 't9', ...p } }),
    cancelSchedule: async () => true,
    now: () => 0,
  });
  core.setSession('sess-A');
  server = {
    now: 0,
    tasks: [
      { id: 'a', sendAt: 2, conversationId: 'sess-A' },
      { id: 'b', sendAt: 3, conversationId: 'sess-B' },
    ],
  };
  await core.refresh();
  assert.deepEqual(core.visibleTasks().map((t) => t.id), ['a'], 'only own-session tasks visible');
  await core.scheduleMessage({ content: 'mine', sendAt: 9, conversationId: 'sess-A' });
  assert.deepEqual(core.visibleTasks().map((t) => t.id), ['a', 't9']);
});

test('start/stop poll loop drives refresh', async () => {
  let fetched = 0;
  const core = createScheduledClientState({
    fetchState: async () => { fetched++; return { now: 0, tasks: [] }; },
    postSchedule: async () => ({}),
    cancelSchedule: async () => true,
    now: () => 0,
  });
  core.start(5);
  await new Promise((r) => setTimeout(r, 20));
  core.stop();
  assert.ok(fetched >= 1, 'at least one fetch happened');
});

// instant session swap: switching sessions shows the cached list immediately
test('setSession swaps to the cached list of the target session instantly', async () => {
  const sidA = 'conv-a', sidB = 'conv-b';
  let serverTasks = [{ id: 'a1', content: 'task A', sendAt: 5, conversationId: sidA }];
  const core = createScheduledClientState({ fetchState: async () => ({ tasks: serverTasks }), now: () => 0 });
  core.setSession(sidA);
  await core.refresh();
  assert.equal(core.visibleTasks().length, 1, 'session A shows its task');
  // switch away and back: list must appear WITHOUT awaiting refresh()
  core.setSession(sidB);
  assert.equal(core.visibleTasks().length, 0, 'B empty before any fetch');
  const changed = core.setSession(sidA);
  assert.equal(changed, true);
  assert.equal(core.visibleTasks().length, 1, 'A cache restored instantly, before refresh resolves');
});

// --- sidebar panel (0.3.0): all-conversations list ----------------------------
test('summarizeContent: first line, trimmed, ellipsized past the cap', () => {
  assert.equal(summarizeContent('short task'), 'short task');
  assert.equal(summarizeContent('  first line\nsecond line  '), 'first line');
  const long = 'a'.repeat(80);
  const out = summarizeContent(long, 50);
  assert.equal(out.length, 50);
  assert.ok(out.endsWith('…'), 'cap-overflow ends with an ellipsis');
  assert.equal(summarizeContent('   '), '');
  assert.equal(summarizeContent(null), '');
});

test('annotateSessions: maps titles from the session list, flags missing sessions', () => {
  const byId = {
    's1': { id: 's1', displayTitle: 'Chat one', title: 'Chat one' },
    's2': { id: 's2', displayTitle: 'fallback' },
  };
  const out = annotateSessions([
    { id: 't1', conversationId: 's1' },
    { id: 't2', conversationId: 's2' },
    { id: 't3', conversationId: 'gone' },
    { id: 't4' }, // no conversation id at all → treated as missing
  ], byId);
  assert.equal(out[0].sessionTitle, 'Chat one');
  assert.equal(out[0].sessionExists, true);
  assert.equal(out[2].sessionExists, false, 'unknown session flagged missing');
  assert.equal(out[3].sessionExists, false);
  // null byId map → everything missing but never throws
  const out2 = annotateSessions([{ id: 't1', conversationId: 's1' }], null);
  assert.equal(out2[0].sessionExists, false);
});

test('panel mode: an UNBOUND client (setSession(null)) sees ALL sessions sorted ascending', async () => {
  const served = [
    { id: 'b', content: 'B', sendAt: 6, conversationId: 's2' },
    { id: 'a', content: 'A', sendAt: 5, conversationId: 's1' },
    { id: 'c', content: 'C', sendAt: 7, conversationId: 's1' },
  ];
  const core = createScheduledClientState({
    fetchState: async () => ({ now: 0, tasks: served }),
    cancelSchedule: async () => true,
    now: () => 0,
  });
  core.setSession(null); // panel binding: no conversation filter
  await core.refresh();
  assert.deepEqual(core.visibleTasks().map((t) => t.id), ['a', 'b', 'c'], 'ALL sessions, sendAt ascending');
  await core.cancelTask('b');
  assert.deepEqual(core.visibleTasks().map((t) => t.id), ['a', 'c'], 'cross-session cancel drops the entry');
});

// instant cancel: local removal happens before the DELETE roundtrip, and the
// cross-instance onChanged hook lets the sidebar panel refresh immediately
test('cancelTask removes locally without waiting for DELETE and notifies onChanged', async () => {
  const deletes = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const core = createScheduledClientState({
    fetchState: async () => ({ tasks: [{ id: 't1', content: 'x', sendAt: 1, conversationId: 's1' }] }),
    cancelSchedule: async (id) => { deletes.push(id); await gate; return true; },
    now: () => 0,
  });
  core.setSession('s1');
  await core.refresh();
  assert.equal(core.visibleTasks().length, 1);
  let notified = false;
  core.onChanged = () => { notified = true; };
  const p = core.cancelTask('t1');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(core.visibleTasks().length, 0, 'removed locally BEFORE the DELETE resolves');
  assert.deepEqual(deletes, ['t1']);
  assert.equal(notified, true, 'onChanged fired immediately');
  release();
  await p;
});
