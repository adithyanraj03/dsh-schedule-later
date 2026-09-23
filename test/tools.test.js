// Model-facing tools: schedule_message / list_scheduled_messages /
// cancel_scheduled_message. Behaviour runs against a pass-through defineTool;
// the parameter spec is additionally checked against the REAL one whenever
// @deepseek-ai/dsh-tools resolves (it does from the installed plugin, not from
// a bare checkout), because a spec it rejects fails at dsh boot, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScheduleLaterTools, resolveWhen, formatIn, chatOf, DEFAULT_LIMITS, SCHEDULED_BY_ASSISTANT,
} from '../src/tools.js';
import { deliveredText, ASSISTANT_MARKER, createFollowupDelivery } from '../src/delivery.js';

const MIN = 60_000;
const NOW = Date.parse('2026-09-18T10:00:00Z');
const passThrough = (spec) => spec;
const realDefineTool = await import('@deepseek-ai/dsh-tools').then((m) => m.defineTool, () => undefined);

/** A scheduler double with the real one's list/schedule/cancel semantics. */
function memoryScheduler() {
  let queue = [];
  let seq = 0;
  return {
    async schedule({ content, sendAt, conversationId, meta }) {
      const item = { id: `task-${++seq}-${sendAt}`, content, sendAt, conversationId, meta: meta || null };
      queue.push(item);
      return item;
    },
    async cancel(id) { const n = queue.length; queue = queue.filter((t) => t.id !== id); return queue.length !== n; },
    list() { return [...queue].sort((a, b) => a.sendAt - b.sendAt).map((t) => ({ ...t })); },
  };
}

const exec = (chat) => ({ agent: { id: chat } });
const setup = (limits) => {
  const scheduler = memoryScheduler();
  const [schedule, list, cancel] = createScheduleLaterTools({ scheduler, clock: { now: () => NOW }, defineTool: passThrough, limits });
  return { scheduler, schedule, list, cancel };
};

/* ------------------------------------------------------------ when */

test('resolveWhen: exactly one of delay_minutes / at', () => {
  assert.equal(resolveWhen({}, NOW).ok, false);
  assert.equal(resolveWhen({ delay_minutes: 5, at: '2026-09-18T12:00:00Z' }, NOW).ok, false);
  assert.deepEqual(resolveWhen({ delay_minutes: 30 }, NOW), { ok: true, sendAt: NOW + 30 * MIN });
  assert.deepEqual(resolveWhen({ at: '2026-09-18T12:00:00Z' }, NOW), { ok: true, sendAt: Date.parse('2026-09-18T12:00:00Z') });
});

test('resolveWhen: refuses the past, too-soon, too-far and unreadable', () => {
  // at least a minute out, so a self-scheduled message cannot loop tightly
  assert.match(resolveWhen({ delay_minutes: 0 }, NOW).error, /at least 1 minute/);
  assert.match(resolveWhen({ delay_minutes: -10 }, NOW).error, /at least 1 minute/);
  assert.match(resolveWhen({ at: '2026-09-18T09:00:00Z' }, NOW).error, /at least 1 minute/);
  assert.match(resolveWhen({ delay_minutes: 31 * 24 * 60 }, NOW).error, /within 30 days/);
  assert.match(resolveWhen({ at: 'next tuesday-ish' }, NOW).error, /ISO 8601/);
  assert.match(resolveWhen({ delay_minutes: 'soon' }, NOW).error, /must be a number/);
});

test('formatIn and chatOf', () => {
  assert.equal(formatIn(NOW + 90 * MIN, NOW), 'in 1h 30m');
  assert.equal(formatIn(NOW + 2 * 24 * 60 * MIN, NOW), 'in 2d 0h');
  assert.equal(chatOf({ agent: { id: 'sess-1' } }), 'sess-1');
  assert.equal(chatOf({ agent: { session: { id: 'sess-2' } } }), 'sess-2');
  assert.equal(chatOf({}), undefined);
});

/* ------------------------------------------------------------ schedule */

test('schedule_message binds to the CALLING chat and marks it as the assistant\'s', async () => {
  const { scheduler, schedule } = setup();
  const out = await schedule.execute({ message: 'Check whether the build went green.', delay_minutes: 45 }, exec('sess-A'));
  assert.match(out.text, /^Scheduled task-1-/);
  assert.match(out.text, /in 45m/);
  const [task] = scheduler.list();
  assert.equal(task.conversationId, 'sess-A');
  assert.equal(task.sendAt, NOW + 45 * MIN);
  assert.equal(task.meta.scheduledBy, SCHEDULED_BY_ASSISTANT);
  assert.equal(task.content, 'Check whether the build went green.');
});

test('schedule_message refuses outside a chat, an empty message, and a bad time — without scheduling', async () => {
  const { scheduler, schedule } = setup();
  assert.match((await schedule.execute({ message: 'x', delay_minutes: 5 }, {})).text, /not running inside a chat/);
  assert.match((await schedule.execute({ message: '   ', delay_minutes: 5 }, exec('s'))).text, /message is empty/);
  assert.match((await schedule.execute({ message: 'x' }, exec('s'))).text, /exactly one/);
  assert.equal(scheduler.list().length, 0);
});

test('schedule_message caps pending assistant messages per chat, per chat', async () => {
  const { scheduler, schedule } = setup({ ...DEFAULT_LIMITS, maxPendingPerChat: 2 });
  await schedule.execute({ message: 'one', delay_minutes: 5 }, exec('s'));
  await schedule.execute({ message: 'two', delay_minutes: 6 }, exec('s'));
  const third = await schedule.execute({ message: 'three', delay_minutes: 7 }, exec('s'));
  assert.match(third.text, /already has 2 pending/);
  // the user's own scheduled messages do not count against the assistant's cap
  await scheduler.schedule({ content: 'user one', sendAt: NOW + 9 * MIN, conversationId: 'other' });
  assert.match((await schedule.execute({ message: 'elsewhere', delay_minutes: 5 }, exec('other'))).text, /^Scheduled/);
});

/* ------------------------------------------------------------ list */

test('list_scheduled_messages shows only this chat, says who scheduled each, and the time now', async () => {
  const { scheduler, schedule, list } = setup();
  await schedule.execute({ message: 'mine', delay_minutes: 10 }, exec('A'));
  await scheduler.schedule({ content: 'the user\'s', sendAt: NOW + 20 * MIN, conversationId: 'A' });
  await scheduler.schedule({ content: 'another chat', sendAt: NOW + 5 * MIN, conversationId: 'B' });
  const out = (await list.execute({}, exec('A'))).text;
  assert.match(out, /now\./);
  assert.match(out, /2 scheduled in this chat/);
  assert.match(out, /scheduled by you/);
  assert.match(out, /scheduled by the user/);
  assert.ok(!out.includes('another chat'), 'never leaks another chat\'s schedule');
  assert.match((await list.execute({}, exec('C'))).text, /Nothing is scheduled/);
});

/* ------------------------------------------------------------ cancel */

test('cancel_scheduled_message: own tasks only, this chat only', async () => {
  const { scheduler, schedule, cancel } = setup();
  await schedule.execute({ message: 'mine', delay_minutes: 10 }, exec('A'));
  const user = await scheduler.schedule({ content: 'user', sendAt: NOW + 20 * MIN, conversationId: 'A' });
  const other = await scheduler.schedule({ content: 'B task', sendAt: NOW + 20 * MIN, conversationId: 'B', meta: { scheduledBy: 'assistant' } });
  const mine = scheduler.list().find((t) => t.content === 'mine');

  assert.match((await cancel.execute({ id: user.id }, exec('A'))).text, /the user scheduled it/);
  // another chat's id reads as absent, not as "exists but not yours"
  assert.match((await cancel.execute({ id: other.id }, exec('A'))).text, /no scheduled message .* in this chat/);
  assert.match((await cancel.execute({ id: 'task-nope' }, exec('A'))).text, /no scheduled message/);
  assert.equal(scheduler.list().length, 3, 'none of those removed anything');

  assert.equal((await cancel.execute({ id: mine.id }, exec('A'))).text, `Cancelled ${mine.id}.`);
  assert.equal(scheduler.list().length, 2);
});

/* ------------------------------------------------------------ delivery */

test('an assistant-scheduled message is delivered with a visible marker; a user one is untouched', async () => {
  assert.equal(deliveredText({ content: 'hi', meta: null }), 'hi');
  assert.equal(deliveredText({ content: 'check the build', meta: { scheduledBy: 'assistant' } }), `${ASSISTANT_MARKER}\ncheck the build`);

  const sent = [];
  const agent = { id: 'A', followup: (m) => sent.push(m), runMaintenance: async (fn) => fn() };
  const deliver = createFollowupDelivery({ tracking: { live: () => [agent] } });
  await deliver({ id: 't', content: 'check the build', conversationId: 'A', meta: { scheduledBy: 'assistant' } });
  assert.equal(sent[0].content[0].text, `${ASSISTANT_MARKER}\ncheck the build`);
  assert.equal(sent[0].source.kind, 'user', 'still a normal user bubble, so it starts a turn');
});

/* ------------------------------------------------------------ real defineTool */

test('the parameter specs are accepted by the real defineTool', { skip: realDefineTool === undefined && 'dsh-tools not resolvable from here' }, async () => {
  const tools = createScheduleLaterTools({ scheduler: memoryScheduler(), clock: { now: () => NOW }, defineTool: realDefineTool });
  assert.deepEqual(tools.map((t) => t.name), ['schedule_message', 'list_scheduled_messages', 'cancel_scheduled_message']);
  // real validation runs: a wrong type is rejected before execute
  await assert.rejects(() => tools[0].execute({ message: 5, delay_minutes: 5 }, exec('A')));
  const ok = await tools[0].execute({ message: 'x', delay_minutes: 5 }, exec('A'));
  assert.match(ok.text, /^Scheduled/);
});
