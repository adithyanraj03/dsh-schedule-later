// Red/green TDD: delivery — due tasks become NORMAL user bubbles via the
// live agent (runMaintenance + followup with a kind:'user' source message).
// Model switching is REMOVED: legacy tasks carrying a model field deliver
// normally on the current model, field ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installAgentTracking, createFollowupDelivery, defaultCreateUserMessage } from '../src/delivery.js';

function mkCtx() {
  const listeners = new Map();
  return {
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    emit: (name, payload) => { for (const fn of listeners.get(name) || []) fn(payload); },
  };
}

function mkAgent(id, extra = {}) {
  const agent = {
    id,
    messages: [],
    runMaintenance: extra.runMaintenance || (async (fn) => fn()),
    ...extra,
  };
  if (!extra.followup) agent.followup = (m) => agent.messages.push(m);
  return agent;
}

test('installAgentTracking adopts agents created after load, drops them on dispose', () => {
  const ctx = mkCtx();
  const t = installAgentTracking(ctx);
  const a = mkAgent('sess-1');
  ctx.emit('agent/created', { agent: a });
  assert.equal(t.live().length, 1);
  ctx.emit('agent/disposed', { agent: a });
  assert.equal(t.live().length, 0, 'disposed agent no longer live');
  t.dispose();
});

test('defaultCreateUserMessage: real user-message shape (id + role user + via source)', () => {
  const m = defaultCreateUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user', via: 'dsh-schedule-later' },
  });
  assert.equal(m.role, 'user', 'role user → renders as a normal user bubble');
  assert.ok(typeof m.id === 'string' && m.id.length > 10, 'has a fresh message id (UUID)');
  assert.deepEqual(m.content, [{ type: 'text', text: 'hi' }]);
  assert.equal(m.source.kind, 'user');
  assert.equal(m.source.via, 'dsh-schedule-later');
  const m2 = defaultCreateUserMessage({ content: [], source: { kind: 'user' } });
  assert.notEqual(m.id, m2.id, 'fresh id per message');
});

test('deliver injects a kind:user message through runMaintenance+followup', async () => {
  const ctx = mkCtx();
  const tracking = installAgentTracking(ctx);
  const agent = mkAgent('sess-1');
  ctx.emit('agent/created', { agent });
  const deliver = createFollowupDelivery({ tracking });
  const ok = await deliver({ id: 't1', content: 'due message', conversationId: 'sess-1' });
  assert.equal(ok, true);
  assert.equal(agent.messages.length, 1);
  const msg = agent.messages[0];
  assert.equal(msg.role, 'user');
  assert.equal(msg.source.kind, 'user', 'NOT plugin-source (that renders as an injected line, not a bubble)');
  assert.equal(msg.content[0].text, 'due message');
});

test('deliver binds to the task conversationId, not just any live agent', async () => {
  const ctx = mkCtx();
  const tracking = installAgentTracking(ctx);
  const other = mkAgent('sess-other');
  const mine = mkAgent('sess-mine');
  ctx.emit('agent/created', { agent: other });
  ctx.emit('agent/created', { agent: mine });
  const deliver = createFollowupDelivery({ tracking });
  await deliver({ id: 't1', content: 'x', conversationId: 'sess-mine' });
  assert.equal(mine.messages.length, 1);
  assert.equal(other.messages.length, 0, 'wrong session untouched');
});

test('no live agent for the conversation → NO_LIVE_AGENT error keeps the task queued', async () => {
  const ctx = mkCtx();
  const tracking = installAgentTracking(ctx);
  ctx.emit('agent/created', { agent: mkAgent('sess-1') });
  const deliver = createFollowupDelivery({ tracking });
  await assert.rejects(
    () => deliver({ id: 't1', content: 'x', conversationId: 'sess-gone' }),
    (err) => err.code === 'NO_LIVE_AGENT',
  );
});

test('REMOVED model switch: legacy task.model field is IGNORED — plain delivery, no override, no error', async () => {
  const ctx = mkCtx();
  const tracking = installAgentTracking(ctx);
  const agent = mkAgent('sess-1');
  // legacy agents may still carry an agent/request-capable ctx — the removed
  // override must never be installed
  agent.ctx = { on: () => { throw new Error('no listener expected'); } };
  ctx.emit('agent/created', { agent });
  const deliver = createFollowupDelivery({ tracking });
  const r = await deliver({ id: 't1', content: 'legacy task', conversationId: 'sess-1', model: { provider: 'p', model: 'm' } });
  assert.equal(r, true, 'delivered normally, model field silently ignored');
  assert.equal(agent.messages.length, 1);
});

test('busy agent (runMaintenance throws) propagates so the scheduler retries', async () => {
  const ctx = mkCtx();
  const tracking = installAgentTracking(ctx);
  const agent = mkAgent('sess-1', { runMaintenance: async () => { throw new Error('busy'); } });
  ctx.emit('agent/created', { agent });
  const deliver = createFollowupDelivery({ tracking });
  await assert.rejects(() => deliver({ id: 't1', content: 'x', conversationId: 'sess-1' }), /busy/);
});
