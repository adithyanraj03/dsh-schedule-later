// Host-side HTTP routes for the browser client. The web GUI cannot subscribe
// to host cordis events directly; the browser client polls GET state and
// calls POST/DELETE for scheduling. Payloads are display-safe only (no
// secrets ever leave the host).
//
//   GET    /plugin-data/dsh-schedule-later/state          → {now, tasks[]}
//   POST   /plugin-data/dsh-schedule-later/schedule       → create {content, sendAt, conversationId, model?}
//   PATCH  /plugin-data/dsh-schedule-later/schedule?id=…  → {sendAt}|{now:true}|{model}|both
//   DELETE /plugin-data/dsh-schedule-later/schedule?id=…  → cancel
//
// `model` is an optional per-message override, {provider, model,
// reasoningEffort?} — the same shape dsh's AgentModel.select() takes. The host
// switches the chat's agent to it for that one delivery and restores the chat's
// own selection afterwards (see delivery.js applyTaskModel). null clears it.

export const STATE_PATH = '/plugin-data/dsh-schedule-later/state';
export const SCHEDULE_PATH = '/plugin-data/dsh-schedule-later/schedule';

/**
 * Register the routes on the host webServer.
 * @param {object} webServer ctx.webServer (dsh-host-webserver service)
 * @param {object} cache ctx.scheduledSend state: {scheduler, now}
 * @returns {() => void} disposer
 */
export function registerScheduledSendRoutes(webServer, cache) {
  const now = () => (typeof cache.now === 'function' ? cache.now() : Date.now());
  const sendJson = (res, status, payload) => {
    // dsh-host-webserver contract: the handler owns the raw node response —
    // it must writeHead/end itself; returning an object writes nothing.
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  const readBody = async (req) => {
    let text = '';
    for await (const chunk of req || []) text += chunk;
    if (!text) return {};
    try { return JSON.parse(text); } catch { return null; }
  };

  // A task's model selection is {provider, model, reasoningEffort?} — the same
  // shape dsh's AgentModel.select() takes. null (or absent) clears the override.
  const INVALID_MODEL = Symbol('invalid-model');
  const normalizeModel = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') return INVALID_MODEL;
    const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
    const model = typeof value.model === 'string' ? value.model.trim() : '';
    if (!provider || !model) return INVALID_MODEL;
    const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : '';
    return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
  };

  const disposers = [];

  // GET state (?conversationId= filters tasks to that conversation)
  disposers.push(webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: async (req = {}, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const cid = new URL(req.url ?? '/', 'http://x').searchParams.get('conversationId');
      const own = (it) => !cid || it?.conversationId === cid;
      sendJson(res, 200, {
        now: now(),
        tasks: (cache.scheduler?.list?.() ?? []).filter(own),
      });
    },
  }));

  // POST/DELETE schedule
  disposers.push(webServer.register({
    kind: 'exact',
    path: SCHEDULE_PATH,
    handler: async (req = {}, res) => {
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'POST' && method !== 'DELETE' && method !== 'PATCH') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      // PATCH ?id= {sendAt} moves a pending task; {now: true} sends it now;
      // {model} (alone or beside either) sets/clears its model selection.
      if (method === 'PATCH') {
        const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id');
        if (!id) { sendJson(res, 400, { error: 'missing id parameter' }); return; }
        const body = await readBody(req);
        if (body === null || typeof body !== 'object') { sendJson(res, 400, { error: 'request body must be a JSON object' }); return; }
        const hasModel = Object.prototype.hasOwnProperty.call(body, 'model');
        const model = hasModel ? normalizeModel(body.model) : undefined;
        if (model === INVALID_MODEL) {
          sendJson(res, 400, { error: 'model must be null, or {provider, model, reasoningEffort?}' });
          return;
        }
        let sendAt;
        if (body.now === true) {
          sendAt = now();
        } else if (typeof body.sendAt === 'number' && Number.isFinite(body.sendAt) && body.sendAt > now()) {
          sendAt = body.sendAt;
        }
        if (!hasModel && sendAt === undefined) {
          sendJson(res, 400, { error: 'give {now: true}, a future sendAt (epoch ms), or a model' });
          return;
        }
        if (sendAt === undefined) {
          // model-only patch: the time (and the armed timer) stay as they are
          const task = await cache.scheduler?.setModel?.(id, model);
          sendJson(res, task ? 200 : 404, task ? { task } : { error: 'task not found, or already sent' });
          return;
        }
        let task = await cache.scheduler?.reschedule?.(id, sendAt);
        if (task && hasModel) task = (await cache.scheduler?.setModel?.(id, model)) ?? task;
        sendJson(res, task ? 200 : 404, task ? { task } : { error: 'task not found, or already sent' });
        return;
      }
      if (method === 'DELETE') {
        const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id');
        if (!id) { sendJson(res, 400, { error: 'missing id parameter' }); return; }
        const ok = await cache.scheduler?.cancel?.(id);
        sendJson(res, ok ? 200 : 404, ok ? { cancelled: id } : { error: 'task not found, or already sent' });
        return;
      }
      const body = await readBody(req);
      if (body === null || typeof body !== 'object') { sendJson(res, 400, { error: 'request body must be a JSON object' }); return; }
      const content = typeof body.content === 'string' ? body.content : '';
      const sendAt = body.sendAt;
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
      if (!content.trim()) { sendJson(res, 400, { error: 'scheduled content must not be empty' }); return; }
      if (typeof sendAt !== 'number' || !Number.isFinite(sendAt) || sendAt <= now()) {
        sendJson(res, 400, { error: 'sendAt must be a future timestamp (epoch ms)' });
        return;
      }
      if (!conversationId) { sendJson(res, 400, { error: 'missing conversationId (the task is bound to a chat)' }); return; }
      // optional per-message model override: {provider, model, reasoningEffort?}
      const model = normalizeModel(body.model);
      if (model === INVALID_MODEL) {
        sendJson(res, 400, { error: 'model must be null, or {provider, model, reasoningEffort?}' });
        return;
      }
      try {
        const task = await cache.scheduler.schedule({ content, sendAt, conversationId, model });
        sendJson(res, 200, { task });
      } catch (err) {
        sendJson(res, 400, { error: String(err?.message || err) });
      }
    },
  }));

  return () => { for (const d of disposers) d(); };
}
