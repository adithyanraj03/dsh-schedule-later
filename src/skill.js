// The `schedule-later` skill, shipped inside this plugin so it can never drift
// from the tools it teaches. Its description sits in the skill catalog the
// model sees every turn — that is what lets the model reach for
// schedule_message on its own initiative, which a tool description alone
// (read only once the model is already considering the tool) does not.
//
// Registered through the skills service's provider path, the same shape
// dsh-genui uses, so it gets bundled precedence.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'schedule-later';
export const SKILL_PROVIDER = 'dsh-schedule-later';

/** Standard precedence rank for packaged skill providers (dsh-skill's BUNDLED_SKILL_RANK). */
const BUNDLED_RANK = 600;

const INVOCATION = { modelInvocable: true, userInvocable: true };

/**
 * Split a SKILL.md into its frontmatter description and body.
 * @param {string} raw
 * @returns {{description: string, content: string}}
 */
export function parseSkill(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const end = text.indexOf('\n---\n', 4);
  if (!text.startsWith('---\n') || end < 0) throw new Error('schedule-later SKILL.md has invalid frontmatter');
  const front = text.slice(4, end);
  const match = /^description:\s*(.+)$/m.exec(front);
  if (!match) throw new Error('schedule-later SKILL.md has no description');
  let description = match[1].trim();
  if (description.startsWith('"') && description.endsWith('"')) description = JSON.parse(description);
  return { description, content: text.slice(end + 5) };
}

/**
 * The skill provider. Reads SKILL.md from the package root on each call, so
 * an edit to it shows up on the next catalog refresh without a rebuild.
 * @param {string} [path] - override for tests
 */
export function scheduleLaterSkillProvider(path = resolve(dirname(fileURLToPath(import.meta.url)), '../SKILL.md')) {
  const load = () => parseSkill(readFileSync(path, 'utf8'));
  const base = {
    name: SKILL_NAME,
    invocation: INVOCATION,
    source: 'bundled',
    provider: SKILL_PROVIDER,
    path,
    resourceBase: { kind: 'directory', path: dirname(path) },
  };
  return {
    name: SKILL_PROVIDER,
    list: async () => [{ ...base, description: load().description, rank: BUNDLED_RANK, locator: path }],
    get: async () => {
      const { description, content } = load();
      return { ...base, description, content };
    },
  };
}
