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

test('per-message model override: switches for the delivery, then restores the chat selection', async () => {
  const ctx = mkCtx();
  const tracking = installAgentTracking(ctx);
  const calls = [];
  let current = { provider: 'chat', model: 'default', reasoningEffort: 'medium' };
  const agent = mkAgent('sess-1', {
    model: { current: () => current, select: (sel) => { calls.push(sel); current = sel; } },
  });
  ctx.emit('agent/created', { agent });
  const deliver = createFollowupDelivery({ tracking });
  await deliver({ id: 't1', content: 'x', conversationId: 'sess-1', model: { provider: 'p', model: 'm', reasoningEffort: 'high' } });
  assert.deepEqual(calls[0], { provider: 'p', model: 'm', reasoningEffort: 'high' }, 'switched before the message');
  assert.deepEqual(calls[1], { provider: 'chat', model: 'default', reasoningEffort: 'medium' }, 'restored after it');
  assert.equal(agent.messages.length, 1, 'delivered');
});

test('per-message model override is restored even when the delivery throws (busy agent)', async () => {
  const ctx = mkCtx();
  const tracking = installAgentTracking(ctx);
  const calls = [];
  const agent = mkAgent('sess-1', {
    runMaintenance: async () => { throw new Error('busy'); },
    model: { current: () => ({ provider: 'chat', model: 'default' }), select: (sel) => calls.push(sel) },
  });
  ctx.emit('agent/created', { agent });
  const deliver = createFollowupDelivery({ tracking });
  await assert.rejects(() => deliver({ id: 't1', content: 'x', conversationId: 'sess-1', model: { provider: 'p', model: 'm' } }), /busy/);
  assert.equal(calls.length, 2, 'switched then restored despite the failure');
  assert.deepEqual(calls[1], { provider: 'chat', model: 'default' });
});

test('no model override → the chat model is never touched; missing agent.model degrades quietly', async () => {
  const ctx = mkCtx();
  const tracking = installAgentTracking(ctx);
  let touched = 0;
  const agent = mkAgent('sess-1', { model: { current: () => ({ provider: 'c', model: 'd' }), select: () => { touched += 1; } } });
  ctx.emit('agent/created', { agent });
  const deliver = createFollowupDelivery({ tracking });
  await deliver({ id: 't1', content: 'x', conversationId: 'sess-1' });
  assert.equal(touched, 0, 'no override, no switch');
  // a host whose agent carries no model selection still delivers
  const agent2 = mkAgent('sess-2');
  ctx.emit('agent/created', { agent: agent2 });
  const ok = await deliver({ id: 't2', content: 'y', conversationId: 'sess-2', model: { provider: 'p', model: 'm' } });
  assert.equal(ok, true);
  assert.equal(agent2.messages.length, 1);
});

test('closed chat: resolveAgent resumes the agent so delivery works without opening the chat', async () => {
  const ctx = mkCtx();
  const tracking = installAgentTracking(ctx); // no agents tracked at all
  const resumed = mkAgent('sess-closed');
  const asked = [];
  const deliver = createFollowupDelivery({
    tracking,
    resolveAgent: async (sid) => { asked.push(sid); return resumed; },
  });
  const ok = await deliver({ id: 't1', content: 'while closed', conversationId: 'sess-closed' });
  assert.equal(ok, true);
  assert.deepEqual(asked, ['sess-closed'], 'host asked to resume exactly the task chat');
  assert.equal(resumed.messages.length, 1, 'delivered into the resumed agent');
  assert.equal(resumed.messages[0].content[0].text, 'while closed');
});

test('resolveAgent failure or {error} result still degrades to NO_LIVE_AGENT', async () => {
  const ctx = mkCtx();
  const tracking = installAgentTracking(ctx);
  const deliverErr = createFollowupDelivery({ tracking, resolveAgent: async () => ({ error: { code: 'session/not-found' } }) });
  await assert.rejects(() => deliverErr({ id: 't1', content: 'x', conversationId: 'gone' }), (e) => e.code === 'NO_LIVE_AGENT');
  const deliverThrow = createFollowupDelivery({ tracking, resolveAgent: async () => { throw new Error('resume exploded'); } });
  await assert.rejects(() => deliverThrow({ id: 't2', content: 'x', conversationId: 'gone' }), (e) => e.code === 'NO_LIVE_AGENT');
});

test('a tracked live agent wins over resolveAgent (no needless resume)', async () => {
  const ctx = mkCtx();
  const tracking = installAgentTracking(ctx);
  const live = mkAgent('sess-1');
  ctx.emit('agent/created', { agent: live });
  let asked = 0;
  const deliver = createFollowupDelivery({ tracking, resolveAgent: async () => { asked++; return mkAgent('other'); } });
  await deliver({ id: 't1', content: 'x', conversationId: 'sess-1' });
  assert.equal(asked, 0, 'host not asked when the chat is already live');
  assert.equal(live.messages.length, 1);
});
