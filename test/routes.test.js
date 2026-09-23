// Red/green TDD: host routes — state GET / schedule POST / cancel DELETE on
// the host webServer. Display-safe: no secrets. Model-switch routes REMOVED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fs } from '../src/deps.js';
import { registerScheduledSendRoutes, STATE_PATH, SCHEDULE_PATH } from '../src/host-routes.js';
import { createScheduler } from '../src/scheduler.js';

// --- tiny fakes ------------------------------------------------------------
function fakeWebServer() {
  const routes = new Map();
  return {
    routes,
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
  };
}
const fakeReq = async (method, url, body) => {
  const req = { method, url };
  if (body !== undefined) {
    const text = JSON.stringify(body);
    req[Symbol.asyncIterator] = async function* () { yield text; };
  }
  return req;
};
const fakeRes = () => {
  const r = { status: 0, headers: null, body: '', ended: false };
  r.writeHead = (status, headers) => { r.status = status; r.headers = headers; };
  r.end = (text) => { r.body = String(text ?? ''); r.ended = true; };
  return r;
};
const jsonOf = (r) => JSON.parse(r.body);

const mkdtemp = async () => await fs.mkdtemp(join(tmpdir(), 'dss-routes-'));

async function mkStack(opts = {}) {
  const ws = fakeWebServer();
  const dir = await mkdtemp();
  const clock = { now: () => 1_000 };
  const scheduler = await createScheduler({ dataDir: dir, clock, timers: manualTimers(), deliver: opts.deliver || (async () => {}) });
  const cache = { scheduler, now: () => clock.now() };
  registerScheduledSendRoutes(ws, cache);
  const call = async (method, url, body) => {
    const route = [...ws.routes.values()].find((r) => url.startsWith(r.path.split('?')[0]));
    const res = fakeRes();
    await route.handler(await fakeReq(method, url, body), res);
    return res;
  };
  return { ws, scheduler, cache, call, clock, dir };
}
function manualTimers() {
  const jobs = new Map();
  let seq = 0;
  return {
    setTimeoutAt: (fn) => { const id = ++seq; jobs.set(id, fn); return id; },
    clearTimeout: (id) => jobs.delete(id),
    async runAll() { for (const fn of [...jobs.values()]) await fn(); jobs.clear(); },
  };
}

// --- tests -----------------------------------------------------------------
test('paths are namespaced to this plugin; model-selected route is GONE', () => {
  assert.equal(STATE_PATH, '/plugin-data/dsh-schedule-later/state');
  assert.equal(SCHEDULE_PATH, '/plugin-data/dsh-schedule-later/schedule');
});

test('REMOVED model switch: only state + schedule routes exist', async () => {
  const { ws } = await mkStack();
  const paths = [...ws.routes.keys()].sort();
  assert.deepEqual(paths, [SCHEDULE_PATH, STATE_PATH], 'no model-selected route registered');
});

test('GET state returns tasks (ascending) + now, display-safe', async () => {
  const { call } = await mkStack();
  await call('POST', SCHEDULE_PATH, { content: 'b', sendAt: 9_000, conversationId: 's' });
  await call('POST', SCHEDULE_PATH, { content: 'a', sendAt: 4_000, conversationId: 's' });
  const res = await call('GET', STATE_PATH);
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = jsonOf(res);
  assert.equal(body.now, 1_000);
  assert.deepEqual(body.tasks.map((t) => t.content), ['a', 'b'], 'tasks sorted ascending by sendAt');
  assert.ok(!JSON.stringify(body).match(/apiKey|token|password/i), 'no secret-ish keys anywhere');
  assert.ok(!('modelSwitchPending' in body), 'model-switch payload removed');
});

test('POST schedule validates: empty content / past sendAt / missing conversationId → 400', async () => {
  const { call, scheduler } = await mkStack();
  assert.equal((await call('POST', SCHEDULE_PATH, { content: '  ', sendAt: 5_000, conversationId: 's' })).status, 400);
  assert.equal((await call('POST', SCHEDULE_PATH, { content: 'x', sendAt: 999, conversationId: 's' })).status, 400, 'past sendAt rejected');
  assert.equal((await call('POST', SCHEDULE_PATH, { content: 'x', sendAt: 5_000 })).status, 400, 'missing conversationId rejected');
  assert.equal(scheduler.list().length, 0, 'nothing enqueued');
});

test('POST schedule success: 200 with the created task; body.model IGNORED (legacy clients)', async () => {
  const { call } = await mkStack();
  const res = await call('POST', SCHEDULE_PATH, { content: 'hello', sendAt: 5_000, conversationId: 'sess-1', model: { provider: 'p', model: 'flash' } });
  assert.equal(res.status, 200, 'model field does not error');
  const task = jsonOf(res).task;
  assert.equal(task.content, 'hello');
  assert.equal(task.conversationId, 'sess-1');
  assert.equal(task.model, null, 'model never stored anymore');
});

test('POST schedule rejects a non-JSON body with 400', async () => {
  const { call, ws } = await mkStack();
  const route = ws.routes.get(SCHEDULE_PATH);
  const res = fakeRes();
  await route.handler({ method: 'POST', url: SCHEDULE_PATH, [Symbol.asyncIterator]: async function* () { yield '{oops'; } }, res);
  assert.equal(res.status, 400);
});

test('DELETE ?id cancels: 200 when removed, 404 otherwise', async () => {
  const { call } = await mkStack();
  const res = await call('POST', SCHEDULE_PATH, { content: 'x', sendAt: 5_000, conversationId: 's' });
  const id = jsonOf(res).task.id;
  assert.equal((await call('DELETE', SCHEDULE_PATH + '?id=' + encodeURIComponent(id))).status, 200);
  assert.equal((await call('DELETE', SCHEDULE_PATH + '?id=' + encodeURIComponent(id))).status, 404);
  assert.equal((await call('DELETE', SCHEDULE_PATH)).status, 400, 'missing id → 400');
});

test('unsupported methods → 405', async () => {
  const { call } = await mkStack();
  assert.equal((await call('PUT', SCHEDULE_PATH, {})).status, 405);
  assert.equal((await call('POST', STATE_PATH, {})).status, 405);
});

// --- FIX 2: session isolation -------------------------------------------------
test('FIX2 GET state ?conversationId= filters tasks to that conversation', async () => {
  const cache = {
    scheduler: { list: () => [
      { id: 'a1', content: 'A task', sendAt: 5_000, conversationId: 'sess-A' },
      { id: 'b1', content: 'B task', sendAt: 6_000, conversationId: 'sess-B' },
    ] },
    now: () => 1_000,
  };
  const ws = fakeWebServer();
  registerScheduledSendRoutes(ws, cache);
  const route = ws.routes.get(STATE_PATH);
  const res = fakeRes();
  await route.handler({ method: 'GET', url: STATE_PATH + '?conversationId=sess-A' }, res);
  const body = jsonOf(res);
  assert.deepEqual(body.tasks.map((t) => t.id), ['a1'], 'only session A tasks');
});

// --- 0.3.0: sidebar panel full mode ------------------------------------------
test('0.3.0 GET state WITHOUT conversationId returns ALL sessions’ tasks (panel mode), each carrying conversationId', async () => {
  const { call } = await mkStack();
  await call('POST', SCHEDULE_PATH, { content: 'task A', sendAt: 4_000, conversationId: 'sess-A' });
  await call('POST', SCHEDULE_PATH, { content: 'task B', sendAt: 9_000, conversationId: 'sess-B' });
  const res = await call('GET', STATE_PATH); // no filter
  assert.equal(res.status, 200);
  const body = jsonOf(res);
  assert.deepEqual(body.tasks.map((t) => t.conversationId), ['sess-A', 'sess-B'], 'all sessions, ascending');
  assert.ok(body.tasks.every((t) => typeof t.conversationId === 'string' && t.conversationId), 'conversationId present on every task');
});
