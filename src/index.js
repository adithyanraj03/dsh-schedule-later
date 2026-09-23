// dsh-schedule-later — host-side cordis plugin entry.
// Assembles the scheduled-send service: persistent task queue (scheduler),
// due-time delivery into the ORIGINAL conversation as a normal user bubble
// (delivery), and the host HTTP routes the browser client talks to
// (host-routes). Model switching has been REMOVED: legacy tasks carrying a
// `model` field deliver normally with the field ignored.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from './scheduler.js';
import { installAgentTracking, createFollowupDelivery } from './delivery.js';
import { registerScheduledSendRoutes } from './host-routes.js';
import { createScheduleLaterTools } from './tools.js';
import { scheduleLaterSkillProvider } from './skill.js';

/**
 * Cordis plugin metadata: the loader reads the named `inject` export to wire
 * required host services into ctx before apply() runs. Without it, reading
 * `ctx.webServer` throws "cannot get property without inject" at boot.
 */
export const inject = ['webServer', 'tools'];
export const name = 'dsh-schedule-later';

/**
 * @param {object} ctx host plugin context
 * @param {object} [config] {dataDir} overrides
 * @param {object} [deps] test hooks: trackAgents(ctx), createUserMessage(spec),
 *        deliverDue(item), clock, timers.
 */
export async function apply(ctx, config = {}, deps = {}) {
  // os.homedir(), not process.env.HOME: PowerShell leaves HOME unset, and the
  // old template then wrote tasks to a folder literally named "undefined".
  const dataDir = config.dataDir || join(homedir(), '.dsh', 'dsh-schedule-later');
  const clock = deps.clock || config.clock || { now: () => Date.now() };
  const timers = deps.timers || config.timers || undefined;

  // agent tracking: agent.id IS the conversation id, so tasks bind back to
  // their original conversation even across restarts (chat binding + catch-up delivery).
  const tracking = deps.trackAgents ? deps.trackAgents(ctx) : installAgentTracking(ctx);

  const cache = {
    dataDir,
    now: () => clock.now(),
  };

  const deliverDue = deps.deliverDue ?? createFollowupDelivery({
    tracking,
    createUserMessage: deps.createUserMessage,
  });

  cache.scheduler = await createScheduler({
    dataDir,
    clock,
    timers,
    deliver: deliverDue,
  });
  cache.agentTracking = tracking;

  // cordis Context is a proxy: arbitrary properties must be registered as
  // services via ctx.provide() — a bare `ctx.scheduledSend = cache` throws
  // "cannot set property without provide" at plugin load time.
  if (typeof ctx.provide === 'function') ctx.provide('scheduledSend', cache);
  else ctx.scheduledSend = cache; // test/plain-object contexts

  if (ctx.webServer?.register) {
    cache.disposeRoutes = registerScheduledSendRoutes(ctx.webServer, cache);
  } else {
    ctx.logger?.warn?.('[dsh-schedule-later] webServer unavailable; client routes not registered');
  }

  // Model-facing tools (schedule_message / list / cancel). Optional in the
  // strict sense: a failure here must not take down the scheduler, the routes
  // or the user's own ⏱️ button, so it is logged and skipped.
  const toolDisposers = [];
  if (ctx.tools?.register) {
    try {
      const defineTool = deps.defineTool ?? (await import('@deepseek-ai/dsh-tools')).defineTool;
      for (const tool of createScheduleLaterTools({ scheduler: cache.scheduler, clock, defineTool, limits: config.limits })) {
        const dispose = ctx.tools.register(tool);
        if (typeof dispose === 'function') toolDisposers.push(dispose);
      }
    } catch (error) {
      ctx.logger?.warn?.('[dsh-schedule-later] model tools not registered: ' + String(error?.message ?? error));
    }
  }

  // The `schedule-later` skill. Its catalog entry is what prompts the model to
  // schedule a check-in on its own initiative, rather than only when told to.
  // Injected, not required: a build without the skills service still boots,
  // and the injection is torn down with this plugin.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['skills'], (skillCtx) => {
        skillCtx.skills.registerProvider(() => scheduleLaterSkillProvider());
      });
    } catch (error) {
      ctx.logger?.warn?.('[dsh-schedule-later] skill not registered: ' + String(error?.message ?? error));
    }
  }

  ctx.on?.('dispose', () => {
    for (const dispose of toolDisposers) dispose();
    cache.scheduler?.dispose?.();
    tracking.dispose?.();
    cache.disposeRoutes?.();
  });

  // cordis treats apply()'s return value as an effect disposer: a plain
  // object here throws "TypeError: Invalid effect" at boot. Cleanup is
  // registered via ctx.on('dispose'); the state is exposed as the
  // 'scheduledSend' service above. Return nothing.
}
