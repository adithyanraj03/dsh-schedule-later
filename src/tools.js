// Model-facing tools: let the assistant schedule a message into the CURRENT
// chat for later — a reminder, a follow-up check, a task to pick back up.
//
// When it fires it arrives exactly like a user-scheduled message: a user bubble
// that starts a new turn. That is what makes it useful ("at 9:00, check whether
// the build went green") and also what makes it risky: an assistant that can
// wake itself up can wake itself up forever. So:
//
//   - it can only schedule into the chat it is running in (the calling
//     agent's id IS the chat id), never another chat;
//   - a message it schedules is delivered with a visible "[Scheduled by the
//     assistant]" line, so neither the user nor the model mistakes it for the
//     user typing it live;
//   - at least MIN_DELAY_MINUTES in the future, so a self-scheduled message
//     cannot trigger a tight loop;
//   - at most MAX_PENDING_PER_CHAT pending assistant-scheduled messages per
//     chat, and no further out than MAX_HORIZON_DAYS;
//   - it can list everything pending in its chat, but can only CANCEL what it
//     scheduled itself. The user's own scheduled messages are theirs.
//
// Pure apart from the injected `defineTool`, so the tests need no dsh.

export const SCHEDULED_BY_ASSISTANT = 'assistant';
export const ASSISTANT_MARKER = '[Scheduled by the assistant]';

export const DEFAULT_LIMITS = Object.freeze({
  minDelayMinutes: 1,
  maxHorizonDays: 30,
  maxPendingPerChat: 10,
});

const MINUTE = 60_000;

/**
 * Resolve the model's "when" into epoch ms.
 *
 * Exactly one of `delay_minutes` or `at`. Models are unreliable at producing
 * epoch timestamps and at knowing the current time, so the relative form is
 * offered first; `at` takes ISO 8601, and a bare date-time with no offset is
 * read as the HOST's local time, which is the clock the user sees.
 * @returns {{ ok: true, sendAt: number } | { ok: false, error: string }}
 */
export function resolveWhen(args, now, limits = DEFAULT_LIMITS) {
  const hasDelay = args.delay_minutes !== undefined && args.delay_minutes !== null;
  const hasAt = typeof args.at === 'string' && args.at.trim() !== '';
  if (hasDelay === hasAt) {
    return { ok: false, error: 'give exactly one of delay_minutes or at' };
  }

  let sendAt;
  if (hasDelay) {
    const minutes = Number(args.delay_minutes);
    if (!Number.isFinite(minutes)) return { ok: false, error: 'delay_minutes must be a number' };
    sendAt = now + minutes * MINUTE;
  } else {
    sendAt = Date.parse(args.at.trim());
    if (!Number.isFinite(sendAt)) {
      return { ok: false, error: `could not read "${args.at}" as a date-time; use ISO 8601 like 2026-09-18T21:30 or 2026-09-18T21:30:00+05:30` };
    }
  }

  if (sendAt < now + limits.minDelayMinutes * MINUTE) {
    return { ok: false, error: `the send time must be at least ${limits.minDelayMinutes} minute(s) from now (it is ${formatLocal(now)} now)` };
  }
  if (sendAt > now + limits.maxHorizonDays * 24 * 60 * MINUTE) {
    return { ok: false, error: `the send time must be within ${limits.maxHorizonDays} days` };
  }
  return { ok: true, sendAt: Math.round(sendAt) };
}

/** "2026-09-18 21:30 (+05:30)" in the host's local time, offset included. */
export function formatLocal(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${zone})`;
}

/** "in 2h 5m" / "in 45s" — for the model, which cannot see the dock's countdown. */
export function formatIn(sendAt, now) {
  const total = Math.max(0, Math.round((sendAt - now) / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  if (m > 0) return `in ${m}m`;
  return `in ${total % 60}s`;
}

/** The chat this call came from. agent.id IS the session / conversation id. */
export function chatOf(exec) {
  const id = exec?.agent?.id ?? exec?.agent?.session?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

const isAssistant = (task) => task?.meta?.scheduledBy === SCHEDULED_BY_ASSISTANT;

function describe(task, now) {
  const who = isAssistant(task) ? 'you' : 'the user';
  const preview = String(task.content).replace(/\s+/g, ' ').trim().slice(0, 120);
  return `- ${task.id} · ${formatLocal(task.sendAt)} (${formatIn(task.sendAt, now)}) · scheduled by ${who}\n  "${preview}"`;
}

const TEXT_OUTPUT = {
  schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

/**
 * Build the three tools.
 * @param {object} p
 * @param {{schedule:Function, cancel:Function, list:Function}} p.scheduler
 * @param {{now:()=>number}} p.clock
 * @param {Function} p.defineTool  from @deepseek-ai/dsh-tools
 * @param {object} [p.limits]
 */
export function createScheduleLaterTools({ scheduler, clock, defineTool, limits = DEFAULT_LIMITS }) {
  const now = () => clock.now();
  const forChat = (chat) => scheduler.list().filter((t) => t.conversationId === chat);

  const scheduleTool = defineTool({
    name: 'schedule_message',
    description:
      'Schedule a message to be sent into THIS chat at a later time. When it fires it arrives as a new ' +
      'user turn (marked "[Scheduled by the assistant]") and you respond to it then — so use it to come ' +
      'back to something later: a reminder the user asked for, re-checking a long-running build or job, ' +
      'following up on a task. Write the message as the instruction you want to receive at that time, ' +
      'with enough context to act on it cold (the conversation so far will still be there). ' +
      `Give either delay_minutes or at. At least ${limits.minDelayMinutes} minute(s) ahead, at most ` +
      `${limits.maxHorizonDays} days, and at most ${limits.maxPendingPerChat} pending at once in a chat. ` +
      'Only schedule when the user asked for it or it clearly serves what they asked; say that you did.',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'What to send at that time — the instruction your future turn should act on.',
      },
      delay_minutes: {
        type: 'number',
        description: 'Send this many minutes from now (e.g. 30, 90, 1440 for a day). Use this OR at.',
      },
      at: {
        type: 'string',
        description:
          'Send at this date-time, ISO 8601. With no offset it is read as the local time of the machine ' +
          'dsh runs on (e.g. 2026-09-18T21:30). Use this OR delay_minutes.',
      },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const chat = chatOf(exec);
      if (chat === undefined) return { text: 'Could not schedule: this call is not running inside a chat.' };
      const content = String(args.message ?? '').trim();
      if (content === '') return { text: 'Could not schedule: the message is empty.' };

      const current = now();
      const when = resolveWhen(args, current, limits);
      if (!when.ok) return { text: `Could not schedule: ${when.error}.` };

      const mine = forChat(chat).filter(isAssistant);
      if (mine.length >= limits.maxPendingPerChat) {
        return {
          text: `Could not schedule: this chat already has ${mine.length} pending messages you scheduled ` +
            `(limit ${limits.maxPendingPerChat}). Cancel one with cancel_scheduled_message first.`,
        };
      }

      const task = await scheduler.schedule({
        content,
        sendAt: when.sendAt,
        conversationId: chat,
        meta: { scheduledBy: SCHEDULED_BY_ASSISTANT, createdVia: 'schedule_message' },
      });
      return {
        text: `Scheduled ${task.id} for ${formatLocal(task.sendAt)} (${formatIn(task.sendAt, current)}). ` +
          'It will arrive in this chat as a new turn. The user can see and cancel it in the Scheduled panel.',
      };
    },
  });

  const listTool = defineTool({
    name: 'list_scheduled_messages',
    description:
      'List the messages scheduled to be sent into THIS chat later — both ones you scheduled and ones the ' +
      'user scheduled — with their ids, times and a preview. Also tells you the current local time.',
    parameters: {},
    output: TEXT_OUTPUT,
    execute: async (_args, exec) => {
      const chat = chatOf(exec);
      if (chat === undefined) return { text: 'This call is not running inside a chat.' };
      const current = now();
      const tasks = forChat(chat);
      const head = `It is ${formatLocal(current)} now.`;
      if (tasks.length === 0) return { text: `${head} Nothing is scheduled in this chat.` };
      return { text: `${head} ${tasks.length} scheduled in this chat:\n${tasks.map((t) => describe(t, current)).join('\n')}` };
    },
  });

  const cancelTool = defineTool({
    name: 'cancel_scheduled_message',
    description:
      'Cancel a message YOU scheduled in this chat, by the id from schedule_message or ' +
      "list_scheduled_messages. You cannot cancel the user's own scheduled messages — ask them to.",
    parameters: {
      id: { type: 'string', required: true, description: 'The scheduled message id, e.g. task-3-1789000000000.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const chat = chatOf(exec);
      if (chat === undefined) return { text: 'Could not cancel: this call is not running inside a chat.' };
      const id = String(args.id ?? '').trim();
      const task = scheduler.list().find((t) => t.id === id);
      // "Not found" for another chat's id too: confirming it exists elsewhere
      // would leak that chat's schedule into this one.
      if (task === undefined || task.conversationId !== chat) {
        return { text: `Could not cancel: no scheduled message ${id} in this chat (it may already have been sent).` };
      }
      if (!isAssistant(task)) {
        return { text: `Could not cancel ${id}: the user scheduled it. Ask them to cancel it from the Scheduled panel if they want it gone.` };
      }
      const removed = await scheduler.cancel(id);
      return { text: removed ? `Cancelled ${id}.` : `Could not cancel ${id}: it was already sent or removed.` };
    },
  });

  return [scheduleTool, listTool, cancelTool];
}
