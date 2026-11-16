import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isProtected } from '../src/branches.js';
import { AGENT_MODELS, AGENT_STEPS, DEFAULT_GH_USER, FactoryConfig, GH_USER_PATTERN, ensureMain, protectedFor, validateFactoryDef, validateFactoryRepo, type FactoryDef, type FactoryRepo } from '../src/factories.js';
import { loadFactoriesFromDir, yamlVersion } from '../src/factoriesFs.js';

const checks = {
  server: { cwd: 'server', build: 'b', test: 't' },
  client: { cwd: 'client', install: 'i', typecheck: 'tc', lint: 'l', test: 't' },
  e2e: 'off' as const,
};
const defInput = (over: Record<string, unknown> = {}) => ({ factoryId: 'delta', name: 'Delta', ...over });
const defOf = (id: string): FactoryDef => {
  const r = validateFactoryDef(defInput({ factoryId: id, name: id }));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const repoOf = (def: FactoryDef, repoId: string, remote: string): FactoryRepo => {
  const r = validateFactoryRepo({ repoId, remote, checks }, def);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('ensureMain', () => {
  test('adds main, dedupes and trims', () => {
    expect(ensureMain(['dev'])).toEqual(['dev', 'main']);
    expect(ensureMain(['main', 'main', ' dev '])).toEqual(['main', 'dev']);
  });
});

describe('validateFactoryDef', () => {
  test('the id global is reserved', () => {
    expect(validateFactoryDef(defInput({ factoryId: 'global' }))).toEqual({ ok: false, error: 'factory id global is reserved' });
  });

  test.each(['Delta', '1x', 'a'.repeat(41), 'a_b'])('rejects id %s', (id) => {
    expect(validateFactoryDef(defInput({ factoryId: id })).ok).toBe(false);
  });
  test('accepts delta, forces main, defaults the gh login', () => {
    const r = validateFactoryDef(defInput({ protectedBranches: ['dev'] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.factoryId).toBe('delta');
    expect(r.value.protectedBranches).toEqual(['dev', 'main']);
    expect(r.value.ghUser).toBe(DEFAULT_GH_USER);
    expect(r.value.active).toBe(true);
  });
  test('the default gh login is a "not set" marker that is not a GitHub login', () => {
    expect(DEFAULT_GH_USER).toBe('(not set)');
    expect(GH_USER_PATTERN.test(DEFAULT_GH_USER)).toBe(false);
  });
  test.each(['', '   '])('an empty ghUser (%j) means the default (R16)', (ghUser) => {
    expect(validateFactoryDef(defInput({ ghUser }))).toMatchObject({ ok: true, value: { ghUser: DEFAULT_GH_USER } });
  });
  test.each(['octocat', ' Some-User ', 'a', 'a1-b2', 'x'.repeat(39)])('accepts the GitHub login %j, trimmed (R16)', (ghUser) => {
    expect(validateFactoryDef(defInput({ ghUser }))).toMatchObject({ ok: true, value: { ghUser: ghUser.trim() } });
  });
  test.each(['-lead', 'trail-', 'two--dashes', 'has space', 'under_score', 'x'.repeat(40), 'blocks-credential:x', 'keychain:delta'])(
    'refuses %j as ghUser (R16)',
    (ghUser) => {
      expect(validateFactoryDef(defInput({ ghUser }))).toEqual({ ok: false, error: 'ghUser must be a GitHub login' });
    },
  );
  test('a ghUser that is not text is refused', () => {
    expect(validateFactoryDef(defInput({ ghUser: 3 }))).toMatchObject({ ok: false });
  });
  test.each(['docs', './docs', '~/docs'])('a non-empty docsPath must be absolute (%j) (M5)', (docsPath) => {
    expect(validateFactoryDef(defInput({ docsPath }))).toEqual({ ok: false, error: 'docsPath must be an absolute folder or empty' });
  });
  test('docsPath may be empty or absolute (M5)', () => {
    expect(validateFactoryDef(defInput({ docsPath: '' })).ok).toBe(true);
    expect(validateFactoryDef(defInput({ docsPath: '/Users/me/docs' })).ok).toBe(true);
  });
  test('a non-empty gitEmail needs an @', () => {
    expect(validateFactoryDef(defInput({ gitEmail: 'nope' })).ok).toBe(false);
    expect(validateFactoryDef(defInput({ gitEmail: '' })).ok).toBe(true);
    expect(validateFactoryDef(defInput({ gitEmail: 'a@b.c' })).ok).toBe(true);
  });
  test('agentModels missing, null or empty leaves the field out', () => {
    for (const input of [defInput(), defInput({ agentModels: undefined }), defInput({ agentModels: null }), defInput({ agentModels: {} })]) {
      const r = validateFactoryDef(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect('agentModels' in r.value).toBe(false);
    }
  });
  test('accepts known stages mapped to known models', () => {
    const all = { spec: 'opus', plan: 'sonnet', build: 'haiku', verify: 'fable', review: 'opus' };
    expect(validateFactoryDef(defInput({ agentModels: all }))).toMatchObject({ ok: true, value: { agentModels: all } });
    const one = validateFactoryDef(defInput({ agentModels: { build: 'haiku' } }));
    expect(one.ok && one.value.agentModels).toEqual({ build: 'haiku' });
  });
  test.each(['x', 3, true, ['opus']])('refuses agentModels %j that is not a plain object', (agentModels) => {
    expect(validateFactoryDef(defInput({ agentModels }))).toEqual({ ok: false, error: 'agentModels must map stages to models' });
  });
  test.each(['check', 'ship', 'Spec', 'other'])('refuses the unknown stage %j', (stage) => {
    expect(validateFactoryDef(defInput({ agentModels: { [stage]: 'opus' } }))).toEqual({ ok: false, error: `agentModels has an unknown stage: ${stage}` });
  });
  test.each(['Opus', 'gpt', '', 3, null])('refuses the model %j', (model) => {
    expect(validateFactoryDef(defInput({ agentModels: { build: model } }))).toEqual({
      ok: false, error: 'agentModels.build must be one of opus, sonnet, haiku, fable',
    });
  });
  test('exports the stage and model lists', () => {
    expect(AGENT_STEPS).toEqual(['spec', 'plan', 'build', 'verify', 'review']);
    expect(AGENT_MODELS).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
  });
});

describe('validateFactoryDef github block', () => {
  const statusMap = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress',
    plan_review: 'In progress', build: 'In progress', verify: 'In progress', review: 'In progress',
    pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' };
  const block = (over = {}) => ({ mode: 'github-only', project: 'octo-user/3', statusMap, ...over });
  test('a def without github has no github key', () => {
    const r = validateFactoryDef(defInput());
    expect(r.ok && 'github' in r.value).toBe(false);
  });
  test('a valid block is carried', () => {
    const r = validateFactoryDef(defInput({ github: block() }));
    expect(r).toMatchObject({ ok: true, value: { github: { mode: 'github-only', project: { owner: 'octo-user', number: 3 }, approvers: [DEFAULT_GH_USER] } } });
  });
  test('a bad block fails with its error', () => {
    expect(validateFactoryDef(defInput({ github: block({ mode: 'mirror' }) }))).toEqual({ ok: false, error: 'github.mode must be github-only' });
  });
});

describe('validateFactoryRepo', () => {
  const def = defOf('delta');
  test('a protectedBranches override gets main added; none leaves the field out', () => {
    const r = validateFactoryRepo({ repoId: 'api', remote: 'r', checks, protectedBranches: [' release ', 'release'] }, def);
    expect(r.ok && r.value.protectedBranches).toEqual(['release', 'main']);
    const plain = validateFactoryRepo({ repoId: 'api', remote: 'r', checks }, def);
    expect(plain.ok && 'protectedBranches' in plain.value).toBe(false);
  });
  test('a protectedBranches override must be a list of names', () => {
    expect(validateFactoryRepo({ repoId: 'api', remote: 'r', checks, protectedBranches: 'main' }, def))
      .toEqual({ ok: false, error: 'protectedBranches must be a list of branch names' });
  });
  test('protectedFor: the repo override wins, else the factory list', () => {
    expect(protectedFor(def, { protectedBranches: ['release', 'main'] })).toEqual(['release', 'main']);
    expect(protectedFor(def, {})).toEqual(def.protectedBranches);
    expect(protectedFor(def, undefined)).toEqual(def.protectedBranches);
  });
  test.each(['main', 'refs/heads/main', 'origin/main', ' Main '])('main is never a base (%j)', (baseBranch) => {
    const r = validateFactoryRepo({ repoId: 'api', remote: 'r', baseBranch, checks }, def);
    expect(r).toEqual({ ok: false, error: 'main is never a base' });
  });
  test.each(['-uupload-pack=x', ' --upload-pack=x'])('refuses a remote that starts with - (%j) (M4)', (remote) => {
    expect(validateFactoryRepo({ repoId: 'api', remote, checks }, def)).toEqual({ ok: false, error: 'remote must not start with -' });
  });
  test.each([['/tmp', 'an absolute'], ['../x', 'a ..'], ['a/../../b', 'a ..'], ['a\\..\\b', 'a ..']])('refuses checks cwd %j (%s path) (M6)', (cwd) => {
    const r = validateFactoryRepo({ repoId: 'api', remote: 'r', checks: { ...checks, client: { ...checks.client, cwd } } }, def);
    expect(r).toEqual({ ok: false, error: 'checks.client.cwd: must be a folder inside the repo (relative, no ..)' });
  });
  test.each(['.', 'client', 'apps/web', 'a..b'])('accepts checks cwd %j (M6)', (cwd) => {
    expect(validateFactoryRepo({ repoId: 'api', remote: 'r', checks: { ...checks, server: { ...checks.server, cwd } } }, def).ok).toBe(true);
  });
  test('rejects a bad repoId', () => {
    expect(validateFactoryRepo({ repoId: 'Api', remote: 'r', checks }, def).ok).toBe(false);
  });
  test.each([
    [[{ name: 'a', run: 'x' }, { name: 'a', run: 'y' }], 'checks.1.name: duplicate check name a'],
    [[{ name: 'a', run: 'x', needs: 'b' }], 'checks.0.needs: b is not an earlier check'],
    [[{ name: 'a', run: 'x', cwd: '../up' }], 'checks.0.cwd: must be a folder inside the repo (relative, no ..)'],
    [undefined, 'checks is required'],
  ])('refuses checks %j', (raw, error) => expect(validateFactoryRepo({ repoId: 'r', remote: 'x', checks: raw }, def)).toEqual({ ok: false, error }));
  test('an empty checks list is valid', () => {
    const r = validateFactoryRepo({ repoId: 'r', remote: 'x', checks: [] }, def);
    expect(r.ok && r.value.checks).toEqual([]);
  });
  test('rejects malformed checks with the zod message', () => {
    const r = validateFactoryRepo({ repoId: 'api', remote: 'r', checks: { ...checks, e2e: 'on' } }, def);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/checks/);
  });
  test('accepts base dev, carrying the factory id', () => {
    const r = validateFactoryRepo({ repoId: 'api', remote: 'r', baseBranch: 'dev', checks }, def);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ factoryId: 'delta', repoId: 'api', baseBranch: 'dev' });
  });
});

describe('FactoryConfig', () => {
  test('two factories can both have repo api', () => {
    const delta = defOf('delta');
    const mods = defOf('mods');
    const cfg = new FactoryConfig([delta, mods], [repoOf(delta, 'api', 'git@x:delta/api.git'), repoOf(mods, 'api', 'git@x:mods/api.git')]);
    expect(cfg.factories().map((f) => f.factoryId)).toEqual(['delta', 'mods']);
    expect(cfg.repo('delta', 'api')!.remote).not.toBe(cfg.repo('mods', 'api')!.remote);
    expect(cfg.repos('mods')).toHaveLength(1);
    expect(cfg.factory('nope')).toBeUndefined();
  });
  test('an invalid def is skipped and listed', () => {
    const good = defOf('delta');
    const bad = { ...good, factoryId: 'Bad' };
    const cfg = new FactoryConfig([good, bad], [repoOf(good, 'api', 'r')]);
    expect(cfg.factories().map((f) => f.factoryId)).toEqual(['delta']);
    expect(cfg.skipped()).toEqual([{ id: 'Bad', reason: expect.any(String) }]);
  });
});

describe('isProtected with a factory list', () => {
  test('uses the given list; main always counts', () => {
    expect(isProtected('origin/main', ['dev'])).toBe(true);
    expect(isProtected('rel', ['rel'])).toBe(true);
    expect(isProtected('feature', ['dev'])).toBe(false);
  });
});

describe('loadFactoriesFromDir', () => {
  test('reads factory.yaml and repos/*.yaml per factory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factories-'));
    const yamlChecks = `checks:
  server: { cwd: server, build: b, test: t }
  client: { cwd: client, install: i, typecheck: tc, lint: l, test: t }
  e2e: off
`;
    for (const id of ['delta', 'mods']) {
      mkdirSync(join(dir, id, 'repos'), { recursive: true });
      writeFileSync(join(dir, id, 'factory.yaml'), `factoryId: ${id}\nname: ${id}\nprotectedBranches: [dev]\n`);
      writeFileSync(join(dir, id, 'repos', 'api.yaml'), `repoId: api\nremote: git@x:${id}/api.git\n${yamlChecks}`);
    }
    const { defs, repos } = loadFactoriesFromDir(dir);
    expect(defs.map((d) => d.factoryId).sort()).toEqual(['delta', 'mods']);
    expect(defs[0]!.protectedBranches).toEqual(['dev', 'main']);
    expect(repos.map((r) => `${r.factoryId}/${r.repoId}`).sort()).toEqual(['delta/api', 'mods/api']);
    expect(repos[0]!.baseBranch).toBe('dev');
  });
  test('a factory.yaml with a github block stays in the config the engine builds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factories-'));
    mkdirSync(join(dir, 'f', 'repos'), { recursive: true });
    const statuses = ['inbox', 'ready', 'spec', 'spec_review', 'plan', 'plan_review', 'build', 'verify', 'review', 'pr_open', 'done', 'blocked', 'cancelled'];
    const opt = (s: string) => (s === 'inbox' ? 'Backlog' : s === 'ready' ? 'Todo' : s === 'done' ? 'Merged' : s === 'cancelled' ? 'Backlog' : s === 'pr_open' ? 'In review' : 'In progress');
    writeFileSync(join(dir, 'f', 'factory.yaml'), `factoryId: f\nname: f\nprotectedBranches: [dev]\ngithub:\n  mode: github-only\n  project: o/3\n  statusMap:\n${statuses.map((s) => `    ${s}: ${opt(s)}`).join('\n')}\n`);
    const { defs, repos } = loadFactoriesFromDir(dir);
    expect(defs[0]!.github!.project).toEqual({ owner: 'o', number: 3 });
    const cfg = new FactoryConfig(defs, repos);
    expect(cfg.skipped()).toEqual([]);
    expect(cfg.factories().map((f) => f.factoryId)).toEqual(['f']);
  });
  test('a missing directory is empty', () => {
    expect(loadFactoriesFromDir(join(tmpdir(), 'no-such-factories-dir'))).toEqual({ defs: [], repos: [], gates: {}, owned: [], problems: [] });
  });
  const objChecks = 'checks:\n  server: { cwd: s, build: b, test: t }\n  client: { cwd: c, install: i, typecheck: tc, lint: l, test: t }\n  e2e: "off"\n';
  const newShape = (id: string) => `factory:\n  id: ${id}\n  name: N\naccounts:\n  github: me\ngates: { plan: true }\nrepos:\n  list:\n`
    + `    - id: api\n      remote: git@github.com:o/api.git\n      checks:\n        server: { cwd: s, build: b, test: t }\n`
    + `        client: { cwd: c, install: i, typecheck: tc, lint: l, test: t }\n        e2e: "off"\n`;
  test('a new-shape factory.yaml with repos.list loads, and old repos/*.yaml join it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factories-'));
    mkdirSync(join(dir, 'delta', 'repos'), { recursive: true });
    writeFileSync(join(dir, 'delta', 'factory.yaml'), newShape('delta'));
    writeFileSync(join(dir, 'delta', 'repos', 'web.yaml'), `repoId: web\nremote: git@github.com:o/web.git\n${objChecks}`);
    const got = loadFactoriesFromDir(dir);
    expect(got.problems).toEqual([]);
    expect(got.defs.map((d) => d.factoryId)).toEqual(['delta']);
    expect(got.repos.map((r) => r.repoId)).toEqual(['api', 'web']);
    expect(got.gates).toEqual({ delta: { plan: true } });
    expect(got.owned).toEqual(['delta']);
  });
  test('a repo in repos.list and repos/<id>.yaml is a problem; the list entry stays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factories-'));
    mkdirSync(join(dir, 'delta', 'repos'), { recursive: true });
    writeFileSync(join(dir, 'delta', 'factory.yaml'), newShape('delta'));
    writeFileSync(join(dir, 'delta', 'repos', 'api.yaml'), `repoId: api\nremote: git@github.com:o/other.git\n${objChecks}`);
    const skipped: string[] = [];
    const got = loadFactoriesFromDir(dir, (f, r) => skipped.push(`${f}: ${r}`));
    expect(got.repos.map((r) => r.remote)).toEqual(['git@github.com:o/api.git']);
    expect(got.problems).toEqual([{ factoryId: 'delta', file: join(dir, 'delta', 'repos', 'api.yaml'), reason: 'repo id api is in repos.list and repos/api.yaml' }]);
    expect(skipped).toHaveLength(1);
  });
  test('versions are content hashes and change when the file changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factories-'));
    mkdirSync(join(dir, 'delta', 'repos'), { recursive: true });
    const text = newShape('delta');
    const repoText = `repoId: web\nremote: git@github.com:o/web.git\n${objChecks}`;
    writeFileSync(join(dir, 'delta', 'factory.yaml'), text);
    writeFileSync(join(dir, 'delta', 'repos', 'web.yaml'), repoText);
    const a = loadFactoriesFromDir(dir);
    expect(yamlVersion(text)).toBe(Number.parseInt(createHash('sha256').update(text).digest('hex').slice(0, 12), 16));
    expect(a.defs[0]!.version).toBe(yamlVersion(text));
    expect(a.repos.find((r) => r.repoId === 'api')!.version).toBe(yamlVersion(text));
    expect(a.repos.find((r) => r.repoId === 'web')!.version).toBe(yamlVersion(repoText));
    writeFileSync(join(dir, 'delta', 'factory.yaml'), text.replace('name: N', 'name: M'));
    const b = loadFactoriesFromDir(dir);
    expect(b.defs[0]!.version).not.toBe(a.defs[0]!.version);
    expect(b.repos.find((r) => r.repoId === 'web')!.version).toBe(yamlVersion(repoText));
  });
  test('a factory-app factory.yaml is a config problem: that store is not part of this build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factories-'));
    mkdirSync(join(dir, 'app'), { recursive: true });
    writeFileSync(join(dir, 'app', 'factory.yaml'), 'factory:\n  id: app\n  name: App\n  source: factory-app\nboard:\n  source: factory-app\n');
    const file = join(dir, 'app', 'factory.yaml');
    const reason = 'factory.source: factory-app: the factory-app store is not part of this build';
    const skipped: [string, string][] = [];
    const got = loadFactoriesFromDir(dir, (f, r) => skipped.push([f, r]));
    expect(got).toEqual({ defs: [], repos: [], gates: {}, owned: ['app'], problems: [{ factoryId: 'app', file, reason }] });
    expect(skipped).toEqual([[file, reason]]);
    // Without onSkip the problem throws with the file's path, as any bad file does.
    expect(() => loadFactoriesFromDir(dir)).toThrow(`${file}: ${reason}`);
  });
  test('an unreadable factory.yaml or repo yaml is that factory\'s problem, not a crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factories-'));
    mkdirSync(join(dir, 'broken', 'factory.yaml'), { recursive: true }); // EISDIR on read
    mkdirSync(join(dir, 'delta', 'repos', 'x.yaml'), { recursive: true });
    writeFileSync(join(dir, 'delta', 'factory.yaml'), 'factory:\n  id: delta\n  name: Delta\n');
    const skipped: string[] = [];
    const got = loadFactoriesFromDir(dir, (f) => skipped.push(f));
    expect(got.owned).toEqual(['broken', 'delta']);
    expect(got.problems.map((p) => p.file)).toEqual([join(dir, 'broken', 'factory.yaml'), join(dir, 'delta', 'repos', 'x.yaml')]);
    expect(skipped).toHaveLength(2);
    expect(() => loadFactoriesFromDir(dir)).toThrow(new RegExp(`${join(dir, 'broken', 'factory.yaml').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}: .*EISDIR`));
  });
  test('an invalid factory.yaml is owned and reported with the field path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factories-'));
    mkdirSync(join(dir, 'delta'), { recursive: true });
    writeFileSync(join(dir, 'delta', 'factory.yaml'), 'factory:\n  id: delta\n  agents:\n    build: gpt\n');
    const got = loadFactoriesFromDir(dir, () => {});
    expect(got.defs).toEqual([]);
    expect(got.owned).toEqual(['delta']);
    expect(got.problems).toEqual([{ factoryId: 'delta', file: join(dir, 'delta', 'factory.yaml'), reason: expect.stringContaining('factory.agents.build:') }]);
    expect(() => loadFactoriesFromDir(dir)).toThrow(/factory\.agents\.build:/);
  });
});
