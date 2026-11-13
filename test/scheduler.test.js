// Red/green TDD: scheduler — persistent task queue for scheduled sending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fs } from '../src/deps.js';
import { createScheduler } from '../src/scheduler.js';

const mkdtemp = async () => await fs.mkdtemp(join(tmpdir(), 'dss-sched-'));

function manualTimers() {
  const jobs = new Map();
  let seq = 0;
  return {
    setTimeoutAt: (fn, at) => { const id = ++seq; jobs.set(id, { fn, at }); return id; },
    clearTimeout: (id) => jobs.delete(id),
    async runAll() {
      for (const { fn } of [...jobs.values()]) await fn();
      jobs.clear();
    },
    get size() { return jobs.size; },
    get nextAt() { return [...jobs.values()].reduce((m, j) => (m === null || j.at < m ? j.at : m), null); },
  };
}

const fakeClock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

test('schedule persists items to tasks.json (conversationId + model kept)', async () => {
  const dir = await mkdtemp();
  const sched = await createScheduler({
    dataDir: dir, clock: fakeClock(), timers: manualTimers(), deliver: async () => {},
  });
  const item = await sched.schedule({
    content: 'hello\n  indented', sendAt: 5_000, conversationId: 'sess-1', model: { provider: 'p', model: 'm' },
  });
  assert.equal(item.content, 'hello\n  indented');
  assert.equal(item.conversationId, 'sess-1');
  assert.deepEqual(item.model, { provider: 'p', model: 'm' });
  const raw = JSON.parse(await fs.readFile(`${dir}/tasks.json`, 'utf8'));
  assert.equal(raw.items.length, 1);
  assert.equal(raw.items[0].conversationId, 'sess-1');
  await sched.dispose();
});

test('restore after restart: overdue item is re-delivered (catch-up) on tick', async () => {
  const dir = await mkdtemp();
  const clock = fakeClock();
  const delivered = [];
  const s1 = await createScheduler({ dataDir: dir, clock, timers: manualTimers(), deliver: async (it) => delivered.push(it) });
  await s1.schedule({ content: 'catch-up after restart', sendAt: 10_000, conversationId: 'sess-1' });
  await s1.dispose();

  clock.advance(20_000); // now overdue
  const s2 = await createScheduler({ dataDir: dir, clock, timers: manualTimers(), deliver: async (it) => delivered.push(it) });
  await s2.tick();
  assert.equal(delivered.length, 1, 'overdue item delivered after restart');
  assert.equal(delivered[0].content, 'catch-up after restart');
  assert.equal((await fs.readFile(`${dir}/tasks.json`, 'utf8')).match(/catch-up after restart/) ? true : false, false, 'delivered item removed from disk');
  await s2.dispose();
});

test('cancel removes a pending item (returns true/false)', async () => {
  const dir = await mkdtemp();
  const sched = await createScheduler({ dataDir: dir, clock: fakeClock(), timers: manualTimers(), deliver: async () => {} });
  const it = await sched.schedule({ content: 'x', sendAt: 9_000, conversationId: 's' });
  assert.equal(await sched.cancel(it.id), true);
  assert.equal(await sched.cancel(it.id), false);
  assert.equal(sched.list().length, 0);
  await sched.dispose();
});

test('list sorts by sendAt ascending; deliver fires in sendAt order', async () => {
  const dir = await mkdtemp();
  const clock = fakeClock();
  const order = [];
  const sched = await createScheduler({ dataDir: dir, clock, timers: manualTimers(), deliver: async (it) => order.push(it.content) });
  await sched.schedule({ content: 'b', sendAt: 8_000, conversationId: 's' });
  await sched.schedule({ content: 'a', sendAt: 3_000, conversationId: 's' });
  await sched.schedule({ content: 'c', sendAt: 9_000, conversationId: 's' });
  assert.deepEqual(sched.list().map((i) => i.content), ['a', 'b', 'c'], 'list sorted ascending by sendAt');
  clock.advance(10_000);
  await sched.tick();
  assert.deepEqual(order, ['a', 'b', 'c'], 'delivered in sendAt order');
  await sched.dispose();
});

test('NO_LIVE_AGENT keeps the ORIGINAL due time, waits without spinning, recovers', async () => {
  const dir = await mkdtemp();
  const clock = fakeClock();
  const timers = manualTimers();
  let attempts = 0;
  let fail = true;
  const delivered = [];
  const sched = await createScheduler({
    dataDir: dir, clock, timers,
    deliver: async (it) => {
      attempts++;
      if (fail) { const e = new Error('no live'); e.code = 'NO_LIVE_AGENT'; throw e; }
      delivered.push(it.content);
    },
  });
  const it = await sched.schedule({ content: 'keep', sendAt: 5_000, conversationId: 's' });
  clock.advance(6_000);
  await sched.tick();
  assert.equal(attempts, 1);
  const waiting = sched.list()[0];
  assert.equal(waiting.sendAt, 5_000, 'original due time preserved for display/order');
  assert.equal(waiting.id, it.id);
  assert.equal(waiting.waitingForChat, true, 'waiting is a state, not a failure');
  assert.equal(waiting.attempts, 0, 'no attempt counting while waiting');
  assert.equal(waiting.lastError, undefined, 'no error banner while waiting');
  assert.ok(timers.nextAt >= clock.now() + 30_000, 'next re-check is bounded, not delay 0 (no hot loop)');
  // the periodic re-check fires and, once the chat can be resumed, delivers
  fail = false;
  clock.advance(30_000);
  await timers.runAll();
  assert.deepEqual(delivered, ['keep'], 'catch-up delivery on the re-check');
  assert.equal(sched.list().length, 0);
  await sched.dispose();
});

test('other errors re-queue with bounded backoff', async () => {
  const dir = await mkdtemp();
  const clock = fakeClock(0);
  let attempts = 0;
  const sched = await createScheduler({
    dataDir: dir, clock, timers: manualTimers(),
    deliver: async () => { attempts++; throw new Error('boom'); },
  });
  await sched.schedule({ content: 'retry', sendAt: 1_000, conversationId: 's' });
  clock.advance(2_000);
  await sched.tick();
  assert.equal(attempts, 1);
  const again = sched.list()[0];
  assert.ok(again.sendAt > 2_000, 'due time pushed into the future (backoff)');
  assert.equal(again.attempts, 1);
  await sched.dispose();
});

test('schedule validates content and sendAt', async () => {
  const dir = await mkdtemp();
  const sched = await createScheduler({ dataDir: dir, clock: fakeClock(), timers: manualTimers(), deliver: async () => {} });
  await assert.rejects(() => sched.schedule({ content: '  ', sendAt: 5 }), /content/);
  await assert.rejects(() => sched.schedule({ content: 'x' }), /sendAt/);
  await sched.dispose();
});

test('arms a real timer for the next due item and disposes cleanly', async () => {
  const dir = await mkdtemp();
  const timers = manualTimers();
  const sched = await createScheduler({ dataDir: dir, clock: fakeClock(), timers, deliver: async () => {} });
  await sched.schedule({ content: 'x', sendAt: 5_000, conversationId: 's' });
  assert.equal(timers.size, 1, 'one timer armed');
  await sched.dispose();
  assert.equal(timers.size, 0, 'timer cleared on dispose');
});

test("setModel sets and clears a pending task's per-message model selection", async () => {
  const dir = await mkdtemp();
  const sched = await createScheduler({ dataDir: dir, clock: fakeClock(), timers: manualTimers(), deliver: async () => {} });
  const t = await sched.schedule({ content: 'x', sendAt: 5_000, conversationId: 's' });
  const updated = await sched.setModel(t.id, { provider: 'p', model: 'm', reasoningEffort: 'high' });
  assert.deepEqual(updated.model, { provider: 'p', model: 'm', reasoningEffort: 'high' });
  const raw = JSON.parse(await fs.readFile(`${dir}/tasks.json`, 'utf8'));
  assert.deepEqual(raw.items[0].model, { provider: 'p', model: 'm', reasoningEffort: 'high' }, 'persisted to tasks.json');
  assert.equal((await sched.setModel(t.id, null)).model, null, 'null clears back to the chat default');
  assert.equal(await sched.setModel('nope', { provider: 'p', model: 'm' }), null, 'unknown id → null');
  await sched.dispose();
});
