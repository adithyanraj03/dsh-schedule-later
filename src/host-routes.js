// Host-side HTTP routes for the browser client. The web GUI cannot subscribe
// to host cordis events directly; the browser client polls GET state and
// calls POST/DELETE for scheduling. Payloads are display-safe only (no
// secrets ever leave the host).
//
//   GET    /plugin-data/dsh-schedule-later/state          → {now, tasks[]}
//   POST   /plugin-data/dsh-schedule-later/schedule       → create {content, sendAt, conversationId}
//   DELETE /plugin-data/dsh-schedule-later/schedule?id=…  → cancel
//
// The model-switch feature (popover dropdown, model-selected confirm route,
// pending-switch payload) has been REMOVED. A legacy POST body containing a
// `model` field is accepted and ignored.

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
      // PATCH ?id= {sendAt} moves a pending task; {now: true} sends it now.
      if (method === 'PATCH') {
        const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id');
        if (!id) { sendJson(res, 400, { error: 'missing id parameter' }); return; }
        const body = await readBody(req);
        if (body === null || typeof body !== 'object') { sendJson(res, 400, { error: 'request body must be a JSON object' }); return; }
        let sendAt;
        if (body.now === true) {
          sendAt = now();
        } else if (typeof body.sendAt === 'number' && Number.isFinite(body.sendAt) && body.sendAt > now()) {
          sendAt = body.sendAt;
        } else {
          sendJson(res, 400, { error: 'give {now: true}, or a future sendAt (epoch ms)' });
          return;
        }
        const task = await cache.scheduler?.reschedule?.(id, sendAt);
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
      // body.model intentionally ignored (model switching removed)
      try {
        const task = await cache.scheduler.schedule({ content, sendAt, conversationId });
        sendJson(res, 200, { task });
      } catch (err) {
        sendJson(res, 400, { error: String(err?.message || err) });
      }
    },
  }));

  return () => { for (const d of disposers) d(); };
}
