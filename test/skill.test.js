// The `schedule-later` skill: its catalog entry is what makes the model schedule a
// check-in on its own, so the description must be there, must name the tool,
// and must reach the skills service through apply().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkill, scheduleLaterSkillProvider, SKILL_NAME, SKILL_PROVIDER } from '../src/skill.js';
import { apply } from '../src/index.js';

test('the shipped SKILL.md parses, and its description names the tool and the cues', async () => {
  const raw = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const { description, content } = parseSkill(raw);
  assert.match(description, /schedule_message/);
  for (const cue of ['remind me', 'check back', 'tomorrow', 'build']) assert.ok(description.includes(cue), cue);
  assert.match(content, /## When to schedule without being asked/);
  assert.ok(!content.startsWith('---'), 'frontmatter is stripped from the body');
});

test('frontmatter: quoted descriptions are unquoted, CRLF files parse', () => {
  const { description, content } = parseSkill('---\r\nname: x\r\ndescription: "a \\"b\\" c"\r\n---\r\nbody\r\n');
  assert.equal(description, 'a "b" c');
  assert.equal(content, 'body\n');
});

test('frontmatter: a file without it is refused rather than half-read', () => {
  assert.throws(() => parseSkill('no frontmatter'), /invalid frontmatter/);
  assert.throws(() => parseSkill('---\nname: x\n---\nbody'), /no description/);
});

test('the provider lists one model-invocable skill and serves its body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-later-skill-'));
  const path = join(dir, 'SKILL.md');
  await writeFile(path, '---\nname: schedule-later\ndescription: Come back later.\n---\n# Body\n');
  const provider = scheduleLaterSkillProvider(path);
  assert.equal(provider.name, SKILL_PROVIDER);

  const [entry, ...rest] = await provider.list();
  assert.equal(rest.length, 0);
  assert.equal(entry.name, SKILL_NAME);
  assert.equal(entry.description, 'Come back later.');
  assert.deepEqual(entry.invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(entry.source, 'bundled');

  const full = await provider.get(SKILL_NAME);
  assert.equal(full.content, '# Body\n');
});

test('an edit to SKILL.md shows on the next read, without a rebuild', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-later-skill-'));
  const path = join(dir, 'SKILL.md');
  await writeFile(path, '---\ndescription: one\n---\nx');
  const provider = scheduleLaterSkillProvider(path);
  assert.equal((await provider.list())[0].description, 'one');
  await writeFile(path, '---\ndescription: two\n---\nx');
  assert.equal((await provider.list())[0].description, 'two');
});

function hostCtx({ withInject }) {
  const providers = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on: () => () => {},
    provide: () => {},
  };
  if (withInject) {
    ctx.inject = (names, fn) => {
      assert.deepEqual(names, ['skills']);
      fn({ skills: { registerProvider: (create) => providers.push(create({ signal: new AbortController().signal })) } });
      return () => {};
    };
  }
  return { ctx, providers };
}

test('apply() registers the skill through the skills service', async () => {
  const { ctx, providers } = hostCtx({ withInject: true });
  const dataDir = await mkdtemp(join(tmpdir(), 'schedule-later-apply-'));
  await apply(ctx, { dataDir }, { trackAgents: () => ({ dispose() {} }), deliverDue: async () => {} });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].name, SKILL_PROVIDER);
  const [entry] = await providers[0].list();
  assert.match(entry.description, /schedule_message/);
});

test('apply() still boots on a host with no skills service', async () => {
  const { ctx } = hostCtx({ withInject: false });
  const dataDir = await mkdtemp(join(tmpdir(), 'schedule-later-apply-'));
  await assert.doesNotReject(apply(ctx, { dataDir }, { trackAgents: () => ({ dispose() {} }), deliverDue: async () => {} }));
});
