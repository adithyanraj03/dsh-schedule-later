// Scheduled sending: persistent task queue in <dataDir>/tasks.json.
// Each task carries {content, sendAt, conversationId, model?} and fires via
// the deliver callback at sendAt. The queue survives restarts (restored +
// re-armed; overdue tasks are re-delivered to their ORIGINAL conversation),
// NO_LIVE_AGENT failures keep the original due time so the task is resent as
// soon as the session reappears (catch-up delivery), other failures retry with
// bounded backoff. Clock and timers are injectable for tests.

import { fs } from './deps.js';

function queuePath(dataDir) {
  return `${dataDir}/tasks.json`;
}

/**
 * Create the scheduler.
 * @param {object} opts
 * @param {string} opts.dataDir persistence directory
 * @param {{now:()=>number}} [opts.clock] injectable clock (default Date)
 * @param {{setTimeoutAt:(fn,atMs)=>id, clearTimeout:(id)=>void}} [opts.timers]
 *        injectable timer queue; defaults to global setTimeout/clearTimeout
 * @param {(item:object)=>Promise<void>} opts.deliver deliver one due task
 */
export async function createScheduler({ dataDir, clock = { now: () => Date.now() }, timers = defaultTimers(), deliver } = {}) {
  if (typeof deliver !== 'function') throw new Error('createScheduler: deliver callback required');
  await fs.mkdir(dataDir, { recursive: true });
  const path = queuePath(dataDir);

  // restore persisted queue (best-effort)
  let queue = [];
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
    if (Array.isArray(parsed.items)) queue = parsed.items.filter((it) => it && it.id && typeof it.sendAt === 'number');
  } catch {
    /* missing/corrupt → start empty */
  }

  let seq = queue.reduce((m, it) => Math.max(m, Number(String(it.id).split('-')[1]) || 0), 0);
  let armed = null; // { timerId }

  const persist = async () => {
    await fs.writeFile(path, JSON.stringify({ items: queue }, null, 2) + '\n', 'utf8');
  };

  const nextDue = () => queue.reduce((m, it) => (m === null || it.sendAt < m ? it.sendAt : m), null);

  const fireDue = async () => {
    const now = clock.now();
    // fire in sendAt order (ascending)
    const due = queue.filter((it) => it.sendAt <= now).sort((a, b) => a.sendAt - b.sendAt);
    for (const item of due) {
      queue = queue.filter((it) => it.id !== item.id); // remove first; re-queue on failure
      try {
        await deliver(item);
      } catch (err) {
        item.attempts = (item.attempts || 0) + 1;
        item.lastError = String(err && err.message);
        if (err && err.code === 'NO_LIVE_AGENT') {
          // target session not live yet: keep the ORIGINAL due time so the
          // task is resent as soon as the session appears (catch-up delivery), not
          // delayed by delivery backoff.
        } else {
          // keep for retry: re-add with backoff pushed due time
          item.sendAt = Math.max(clock.now(), now) + Math.min(60_000 * 2 ** (item.attempts - 1), 300_000);
        }
        queue.push(item);
      }
    }
    if (due.length) await persist().catch(() => {});
    arm();
  };

  const arm = () => {
    if (armed) {
      timers.clearTimeout(armed.timerId);
      armed = null;
    }
    const due = nextDue();
    if (due === null) return;
    const delay = Math.max(0, due - clock.now());
    const timerId = timers.setTimeoutAt(() => {
      armed = null;
      return fireDue(); // return the promise so injectable timer queues can await
    }, clock.now() + delay);
    armed = { timerId };
  };

  arm();
  await persist().catch(() => {}); // ensure the file exists after first create

  return {
    /** Schedule a task. sendAt (epoch ms) is required; default is computed by the caller. */
    async schedule({ content, sendAt, conversationId, model, meta }) {
      if (typeof content !== 'string' || !content.trim()) throw new Error('scheduled content must not be empty');
      if (typeof sendAt !== 'number' || !Number.isFinite(sendAt)) throw new Error('sendAt must be a timestamp (epoch ms)');
      const item = {
        id: `task-${++seq}-${sendAt}`,
        content,
        sendAt,
        conversationId: conversationId || null,
        model: model || null,
        meta: meta || null,
        createdAt: clock.now(),
        attempts: 0,
      };
      queue.push(item);
      await persist();
      arm();
      return item;
    },
    /** Cancel a pending task before it fires. Returns true when removed. */
    async cancel(id) {
      const before = queue.length;
      queue = queue.filter((it) => it.id !== id);
      if (queue.length !== before) {
        await persist();
        arm();
        return true;
      }
      return false;
    },
    /** Pending tasks sorted by sendAt ascending (display order). */
    list() {
      return [...queue].sort((a, b) => a.sendAt - b.sendAt).map((it) => ({ ...it }));
    },
    /** Manual tick (for tests / external loops). */
    tick: fireDue,
    async dispose() {
      if (armed) timers.clearTimeout(armed.timerId);
      armed = null;
    },
  };
}

function defaultTimers() {
  return {
    // setTimeoutAt receives an ABSOLUTE epoch-ms target (same contract as the
    // injectable test timers); convert to a relative delay for real setTimeout.
    setTimeoutAt: (fn, atMs) => {
      const t = setTimeout(fn, Math.max(0, atMs - Date.now()));
      t.unref?.();
      return t;
    },
    clearTimeout: (t) => clearTimeout(t),
  };
}
