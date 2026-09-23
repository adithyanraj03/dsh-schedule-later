// Client-layer core for dsh-schedule-later (browser side, framework-free and
// testable in Node). The lib/client.js bundle wraps this with React/slots.

/** Media query marking the mobile layout (FIX 5). */
export const MOBILE_QUERY = '(max-width: 480px)';

/**
 * Grace window during which a freshly POSTed task survives a refresh whose
 * server snapshot was taken BEFORE the task existed (FIX 4 race).
 */
export const LOCAL_ADD_GRACE_MS = 10_000;

/** Safe matchMedia probe: never throws, false when unavailable. */
export function isMobileViewport(matchMedia) {
  try {
    if (typeof matchMedia !== 'function') return false;
    return !!matchMedia(MOBILE_QUERY)?.matches;
  } catch {
    return false;
  }
}

/** Sort a task list by sendAt ascending (display order). */
export function sortTasks(tasks) {
  return [...(tasks || [])].sort((a, b) => (a.sendAt || 0) - (b.sendAt || 0));
}

/**
 * Collapse rule for the dock (FIX 2):
 *  - default (desktop): >1 entry → show ONLY the soonest (sendAt-min) entry
 *    plus a "N more scheduled ⌄" summary toggle; ≤1 entry → expanded.
 *  - default (mobile): fully collapsed (summary only).
 *  - user 'expanded' → all entries; user 'collapsed' → nothing but the
 *    summary (manual collapse-all works for ANY count, including 1).
 * @param {Array} tasks already sorted ascending by sendAt
 * @param {{user?: 'expanded'|'collapsed'|null, mobile?: boolean}} [opts]
 */
export function collapseState(tasks, { user = null, mobile = false } = {}) {
  const list = tasks || [];
  if (!list.length) {
    return { display: 'expanded', visibleCount: 0, hiddenCount: 0, summary: null, collapsed: false };
  }
  let display = mobile ? 'summary' : (list.length > 1 ? 'one' : 'expanded');
  if (user === 'expanded') display = 'expanded';
  else if (user === 'collapsed') display = list.length > 1 ? 'one' : 'summary';
  if (display === 'one') {
    return { display, visibleCount: 1, hiddenCount: list.length - 1, summary: `${list.length - 1} more scheduled ⌄`, collapsed: true };
  }
  if (display === 'summary') {
    return { display, visibleCount: 0, hiddenCount: list.length, summary: `${list.length} scheduled ⌄`, collapsed: true };
  }
  return { display: 'expanded', visibleCount: list.length, hiddenCount: 0, summary: 'Collapse ⌃', collapsed: false };
}

/** Local-timezone "YYYY-MM-DD HH:mm" for a planned send time. */
export function formatLocalTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Countdown until sendAt ("1m 30s" / "1h 0m" / "2d 3h"), or "now" once due. */
export function formatCountdown(sendAt, now) {
  const ms = sendAt - now;
  if (ms <= 0) return 'now';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  // a bare duration: callers frame it ("Sends in …") via sendsIn below
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * The countdown as a phrase: "Sends in 4m 12s", or "Sending now" once due.
 *
 * English puts the verb in front of the duration, where the original appended
 * it after the duration. Doing that at each call site as "Sends in " + countdown
 * would print "Sends in now" for a due task, so the phrasing lives here.
 */
export function sendsIn(sendAt, now) {
  const left = formatCountdown(sendAt, now);
  return left === 'now' ? 'Sending now' : `Sends in ${left}`;
}

/** Default confirmation time = now + 5 minutes. */
export function defaultSendAt(now = Date.now(), offsetMs = 5 * 60_000) {
  return now + offsetMs;
}

/**
 * One-line content summary for the sidebar panel list (0.3.0): first line,
 * trimmed; capped with an ellipsis past `max` chars. Empty input → ''.
 */
export function summarizeContent(text, max = 50) {
  if (typeof text !== 'string') return '';
  const first = text.split(/\r?\n/, 1)[0].trim();
  if (!first) return '';
  return first.length > max ? first.slice(0, max - 1) + '…' : first;
}

/**
 * Attach session identity to panel rows (0.3.0): `sessionTitle` from the
 * client session list's displayTitle, `sessionExists` false when the session
 * is gone (deleted / not in the list) — those rows gray out but stay
 * cancellable. Never throws on a missing/empty map.
 */
export function annotateSessions(tasks, sessionsById) {
  const byId = sessionsById || {};
  return (tasks || []).map((t) => {
    const s = t?.conversationId ? byId[t.conversationId] : null;
    return {
      ...t,
      sessionExists: !!s,
      sessionTitle: s ? (s.displayTitle || s.title || t.conversationId) : '',
    };
  });
}

/**
 * Stateful client controller: polls the host state route, holds the visible
 * task list (extended with the server-confirmed task right after POST so new
 * entries show WITHOUT a refresh), and exposes cancel.
 *
 * FIX 1: setSession() reports session changes so the view can refresh
 * immediately; refresh failures keep the LAST data and surface an error
 * instead of flashing empty.
 *
 * FIX 4: refresh() merges by id — a recently POSTed task (within
 * LOCAL_ADD_GRACE_MS) survives a stale server snapshot that predates it.
 *
 * @param {object} deps
 * @param {() => Promise<object>} deps.fetchState GET the host state route
 * @param {(payload:object)=>Promise<{task:object}>} deps.postSchedule
 * @param {(id:string)=>Promise<boolean>} deps.cancelSchedule
 * @param {() => number} [deps.now]
 */
export function createScheduledClientState({ fetchState, postSchedule, cancelSchedule, now = () => Date.now() } = {}) {
  let tasks = [];
  let error = null;
  let timer = null;
  let stopped = false;
  let sessionId = null; // this dock belongs to exactly one conversation
  const recentAdds = new Map(); // id → addedAt (FIX 4 grace window)
  // per-conversation cache: switching sessions shows the cached list
  // INSTANTLY (no ~1s wait for the network), then refresh() revalidates.
  const sessionCache = new Map(); // sid → task[]

  // strict conversation filter: with a session bound, only entries belonging
  // to THIS conversation are ever visible; other-session tasks are dropped
  // from the local list on every refresh.
  const own = (it) => !sessionId || !it?.conversationId || it.conversationId === sessionId;
  const dedupeById = (list) => {
    const seen = new Set();
    return list.filter((t) => (t?.id && !seen.has(t.id) ? (seen.add(t.id), true) : false));
  };

  return {
    /**
     * Bind this client to one conversation. Returns true when the session
     * actually CHANGED (the view refreshes immediately in that case — FIX 1).
     */
    setSession(sid) {
      const next = sid || null;
      const changed = next !== sessionId;
      if (sessionId !== null) sessionCache.set(sessionId, tasks.filter(own));
      sessionId = next;
      if (changed) {
        // instant swap: show the cached list for the target session first
        tasks = sessionId !== null && sessionCache.has(sessionId)
          ? [...sessionCache.get(sessionId)]
          : [];
        error = null;
      }
      return changed;
    },

    /** Session this client is currently bound to (view fetch uses it). */
    currentSession() {
      return sessionId;
    },

    /** Pending tasks sorted ascending by sendAt, own session only. */
    visibleTasks() {
      return sortTasks(tasks).filter(own);
    },
    /** Last refresh error, or null (view shows old data + this line). */
    lastError() {
      return error;
    },
    snapshot() {
      return { tasks: sortTasks(tasks).filter(own), error, fetchedAt: now() };
    },

    async refresh() {
      let s;
      try {
        s = await fetchState();
      } catch (err) {
        // FIX 1 failure mode: keep the previous list, surface the error —
        // never flash an empty dock on a transient failure.
        error = String(err?.message || err);
        return this.snapshot();
      }
      error = null;
      const server = (s?.tasks ?? []).filter(own);
      // FIX 4: keep freshly POSTed tasks whose id the (possibly stale) server
      // snapshot does not know yet; the server list stays authoritative for
      // everything else (cancellations included).
      const t = now();
      const freshLocal = tasks.filter(
        (it) => it?.id && !server.some((x) => x.id === it.id) && own(it) && t - (recentAdds.get(it.id) ?? -Infinity) < LOCAL_ADD_GRACE_MS,
      );
      for (const id of [...recentAdds.keys()]) {
        if (t - recentAdds.get(id) >= LOCAL_ADD_GRACE_MS || server.some((x) => x.id === id)) recentAdds.delete(id);
      }
      tasks = dedupeById([...server, ...freshLocal]);
      if (sessionId !== null) sessionCache.set(sessionId, tasks); // keep the instant-swap cache fresh
      return this.snapshot();
    },

    /**
     * User-facing schedule entry: POST to the host route and locally enqueue
     * the SERVER-RETURNED task so it is visible IMMEDIATELY (no refresh needed,
     * id-deduped). Nothing is added on failure, so the view keeps the form
     * with its content intact (a failure rolls back and keeps the form).
     */
    async scheduleMessage(payload) {
      if (!postSchedule) throw new Error('postSchedule is not configured');
      const result = await postSchedule(payload);
      const task = result?.task ?? result;
      if (task?.id && own(task)) {
        tasks = dedupeById([...tasks, task]);
        recentAdds.set(task.id, now());
      }
      return task;
    },

    /** Cancel a pending task: DELETE on the host + drop locally. */
    /** Cross-instance optimistic removal by id (no fetch). */
    removeTask(id) {
      tasks = tasks.filter((t) => t.id !== id);
      recentAdds.delete(id);
    },

    async cancelTask(id) {
      // optimistic: drop locally FIRST so the row disappears instantly; the
      // DELETE then persists it. onChanged lets the sibling instance (dock ↔
      // sidebar panel) refresh immediately instead of waiting for its poll.
      tasks = tasks.filter((t) => t.id !== id);
      recentAdds.delete(id);
      if (typeof this.onChanged === 'function') this.onChanged(id);
      if (cancelSchedule) await cancelSchedule(id);
    },

    start(intervalMs = 4_000) {
      if (timer) return;
      stopped = false;
      const loop = async () => {
        if (stopped) return;
        await this.refresh().catch(() => {});
        timer = setTimeout(loop, intervalMs);
        timer.unref?.();
      };
      void loop();
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}
