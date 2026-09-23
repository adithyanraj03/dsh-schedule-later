// Real injection channel for scheduled tasks. When a task comes due, we
// build a REAL user message (role 'user', fresh id, source kind 'user' with a
// `via` tag — NOT kind 'plugin', which the UI renders as an injected line
// instead of a normal user bubble) and hand it to the live agent of the task's
// ORIGINAL conversation via agent.runMaintenance(() => agent.followup(msg)).
// This mirrors the host's real prompt path
// (@deepseek-ai/dsh-api-session-controller prompt(): createUserMessage with
// kind:"user" source + followup). If the session is not live or the agent is
// busy, delivery throws so the scheduler keeps the task queued and retries.
//
// Model switching has been REMOVED. Legacy tasks may still carry a `model`
// field (written by earlier versions); it is silently ignored — the task
// delivers on the conversation's current model.

export const PLUGIN_NAME = 'dsh-schedule-later';

/**
 * First line of a message the ASSISTANT scheduled (see tools.js). It arrives
 * as a user bubble like any scheduled message, so without this neither the
 * user nor the model could tell a self-set reminder from the user typing live.
 * Kept literal here rather than imported so delivery stays dependency-free.
 */
export const ASSISTANT_MARKER = '[Scheduled by the assistant]';

/** The text to deliver: the task's content, marked when the assistant set it. */
export function deliveredText(item) {
  return item?.meta?.scheduledBy === 'assistant' ? ASSISTANT_MARKER + '\n' + item.content : item.content;
}

/**
 * Inline equivalent of @deepseek-ai/dsh-llm createUserMessage: completes the
 * message with role 'user' and a fresh stable UUID id, then freezes it before
 * publication (same contract as the host's createUserMessage, which is not
 * resolvable from a plugin directory).
 */
export function defaultCreateUserMessage(spec) {
  const message = {
    id: crypto.randomUUID(),
    role: 'user',
    content: spec.content,
    source: spec.source,
  };
  return Object.freeze(message);
}

/**
 * Track root agents published after plugin load (same install rule as
 * dsh-schedule: agents live at load time are not adopted). agent.id IS the
 * conversation/session id (dsh-agent: agent id must equal session id), so
 * tasks bind back to their original conversation after restarts.
 * @param {object} ctx host plugin context exposing ctx.on
 * @returns {{agents:()=>any[], live:()=>any[], dispose:()=>void}}
 */
export function installAgentTracking(ctx) {
  const agents = new Set();
  let stopped = false;
  const offCreated = ctx?.on?.('agent/created', ({ agent }) => {
    if (stopped || !agent || typeof agent.followup !== 'function') return;
    agents.add(agent);
  });
  const offDisposed = ctx?.on?.('agent/disposed', ({ agent }) => {
    agents.delete(agent);
  });
  return {
    agents: () => [...agents],
    live: () => [...agents].filter((a) => typeof a.followup === 'function'),
    dispose: () => {
      stopped = true; // stop accepting new ones
      if (typeof offCreated === 'function') offCreated();
      if (typeof offDisposed === 'function') offDisposed();
    },
  };
}

/**
 * Build the delivery callback for the scheduler: inject one due task into the
 * live session of its conversation as a follow-up user message.
 * @param {object} p
 * @param {{live:()=>any[]}} p.tracking agent tracking from installAgentTracking
 * @param {(spec:object)=>object} [p.createUserMessage] message factory (injectable)
 * @param {string} [p.pluginName]
 * @returns {(item:{id:string, content:string, conversationId?:string, model?:object}) => Promise<true>}
 */
export function createFollowupDelivery({
  tracking,
  createUserMessage = defaultCreateUserMessage,
  pluginName = PLUGIN_NAME,
} = {}) {
  return async function deliver(item) {
    const live = tracking.live();
    // bind to the task's conversation (agent.id === conversationId): a task
    // bound to a conversation NEVER falls through to another live session
    // (chat binding); only legacy tasks without a conversationId may use any agent.
    const agent = item.conversationId
      ? live.find((a) => a.id === item.conversationId) ?? null
      : live[0] ?? null;
    if (!agent) {
      const err = new Error('no live agent for this chat; the task stays queued and is delivered once the chat is back');
      err.code = 'NO_LIVE_AGENT';
      throw err;
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: deliveredText(item) }],
      source: { kind: 'user', via: pluginName },
    });
    // runMaintenance throws when the agent is mid-turn (busy) — the throw
    // propagates so the scheduler re-queues with backoff.
    await agent.runMaintenance(async () => {
      agent.followup(message);
      return true;
    });
    return true;
  };
}
