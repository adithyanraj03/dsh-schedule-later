// Red/green TDD: host plugin assembly — cordis contract (inject/name/apply
// returns nothing), provide('scheduledSend'), routes registered, dispose
// cleans up, and the full due-time path fires a kind:'user' bubble message.
// Model switching removed: no hub, no model-selected route; legacy tasks.json
// entries with a model field deliver normally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fs } from '../src/deps.js';
import { apply, inject, name } from '../src/index.js';

const mkdtemp = async () => await fs.mkdtemp(join(tmpdir(), 'dss-plugin-'));

function manualTimers() {
  const jobs = new Map();
  let seq = 0;
  return {
    setTimeoutAt: (fn) => { const id = ++seq; jobs.set(id, fn); return id; },
    clearTimeout: (id) => jobs.delete(id),
    async runAll() { for (const fn of [...jobs.values()]) await fn(); jobs.clear(); },
  };
}

function fakeCtx(opts = {}) {
  const routes = new Map();
  const disposers = [];
  const events = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on: (n, fn) => { disposers.push(fn); return () => {}; },
    emit: (n, p) => events.push({ name: n, payload: p }),
    provide: (k, v) => { ctx[`__provided_${k}`] = v; },
    webServer: {
      register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path); },
    },
    __routes: routes,
    __events: events,
  };
  return ctx;
}

test('cordis contract: inject=[webServer, tools], name, apply returns undefined', async () => {
  // tools: the model-facing schedule_message / list / cancel tools register on it
  assert.deepEqual(inject, ['webServer', 'tools']);
  assert.equal(name, 'dsh-schedule-later');
  const dir = await mkdtemp();
  const ctx = fakeCtx();
  const ret = await apply(ctx, { dataDir: dir, clock: { now: () => 1_000 }, timers: manualTimers() }, { trackAgents: () => ({ live: () => [], dispose: () => {} }) });
  assert.ok(ret === undefined, 'apply must not return a plain object (Invalid effect)');
  assert.ok(ctx.__provided_scheduledSend, "state exposed via ctx.provide('scheduledSend')");
});

test('routes registered on webServer and removed on dispose (state + schedule only)', async () => {
  const dir = await mkdtemp();
  const ctx = fakeCtx();
  await apply(ctx, { dataDir: dir, clock: { now: () => 1_000 }, timers: manualTimers() }, { trackAgents: () => ({ live: () => [], dispose: () => {} }) });
  const paths = [...ctx.__routes.keys()].sort();
  assert.deepEqual(paths, [
    '/plugin-data/dsh-schedule-later/schedule',
    '/plugin-data/dsh-schedule-later/state',
  ], 'model-selected route no longer registered');
  ctx.__emitDispose?.();
});

test('end-to-end: POST schedule → due → normal user bubble via runMaintenance+followup', async () => {
  const dir = await mkdtemp();
  const timers = manualTimers();
  const clock = { now: () => 1_000 };
  const messages = [];
  const agent = {
    id: 'sess-1',
    followup: (m) => messages.push(m),
    runMaintenance: async (fn) => fn(),
  };
  const ctx = fakeCtx();
  await apply(ctx, { dataDir: dir, clock, timers }, {
    trackAgents: () => ({ live: () => [agent], dispose: () => {} }),
  });

  // POST a task via the real route
  const route = ctx.__routes.get('/plugin-data/dsh-schedule-later/schedule');
  const body = JSON.stringify({ content: 'send this when due', sendAt: 5_000, conversationId: 'sess-1' });
  const res = { status: 0, body: '', writeHead(s) { this.status = s; }, end(t) { this.body = t; } };
  await route.handler({ method: 'POST', url: '/x', [Symbol.asyncIterator]: async function* () { yield body; } }, res);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // due time arrives
  clock.now = () => 6_000;
  await timers.runAll();

  assert.equal(messages.length, 1, 'delivered exactly once');
  const msg = messages[0];
  assert.equal(msg.role, 'user');
  assert.equal(msg.source.kind, 'user', 'normal user bubble, NOT a plugin injection line');
  assert.equal(msg.content[0].text, 'send this when due');
  assert.ok(typeof msg.id === 'string' && msg.id.length > 10, 'real message id present');

  // task gone from state
  const stateRoute = ctx.__routes.get('/plugin-data/dsh-schedule-later/state');
  const res2 = { status: 0, body: '', writeHead(s) { this.status = s; }, end(t) { this.body = t; } };
  await stateRoute.handler({ method: 'GET', url: '/x' }, res2);
  const state = JSON.parse(res2.body);
  assert.equal(state.tasks.length, 0, 'no pending task after delivery');
  assert.ok(!('recentDelivered' in state), 'fallback-note payload removed with the model feature');
});

test('REMOVED model switch: old tasks.json with a model field is restored and delivered normally', async () => {
  const dir = await mkdtemp();
  // seed a legacy queue written by the previous version (model field present)
  await fs.writeFile(`${dir}/tasks.json`, JSON.stringify({
    items: [{
      id: 'task-9-5000',
      content: 'legacy task that carried a model',
      sendAt: 5_000,
      conversationId: 'sess-1',
      model: { provider: 'zai', model: 'glm-5.3-flash' },
      createdAt: 1_000,
      attempts: 0,
    }],
  }), 'utf8');

  const timers = manualTimers();
  const clock = { now: () => 1_000 };
  const messages = [];
  const agent = {
    id: 'sess-1',
    followup: (m) => messages.push(m),
    runMaintenance: async (fn) => fn(),
    ctx: { on: () => { throw new Error('model override must never be installed'); } },
  };
  const ctx = fakeCtx();
  await apply(ctx, { dataDir: dir, clock, timers }, {
    trackAgents: () => ({ live: () => [agent], dispose: () => {} }),
  });

  clock.now = () => 6_000; // task is overdue → delivered on restore/tick
  await timers.runAll();
  assert.equal(messages.length, 1, 'legacy task delivered despite model field');
  assert.equal(messages[0].content[0].text, 'legacy task that carried a model');
});
