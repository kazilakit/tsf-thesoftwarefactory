import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFactoryRoot, claimantFor, replyTarget, shouldRenew, renewCommand, AGENT_FOR } from '../hooks/lib.mjs';
import { AGENT_FOR as CORE_AGENT_FOR } from '../../core/src/defaults.ts';

const hooks = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const root = '/f/root';
const session = { taskId: 'T-1', step: 'build', mode: 'session', store: 'other' }; // a stale store field is ignored

describe('claimantFor', () => {
  it('uses host and first 8 chars', () => {
    expect(claimantFor('0123456789ab', 'mac')).toBe('claude:mac:01234567');
  });
  it('differs per session', () => {
    expect(claimantFor('aaaaaaaa1', 'h')).not.toBe(claimantFor('bbbbbbbb1', 'h'));
  });
});

describe('AGENT_FOR', () => {
  it('matches core', () => {
    expect(AGENT_FOR).toEqual(CORE_AGENT_FOR);
  });
});

describe('replyTarget', () => {
  it('returns the reply path for a matching stop', () => {
    expect(replyTarget({ agent_type: 'factory:implementer' }, { root, session }))
      .toBe('/f/root/runs/T-1/build.reply.md');
  });
  it('null for other agent types', () => {
    expect(replyTarget({ agent_type: 'general-purpose' }, { root, session })).toBeNull();
  });
  it('null when the step does not match the agent', () => {
    expect(replyTarget({ agent_type: 'factory:reviewer' }, { root, session: { ...session, step: 'spec' } })).toBeNull();
  });
  it('null without a session', () => {
    expect(replyTarget({ agent_type: 'factory:implementer' }, { root, session: null })).toBeNull();
  });
});

describe('shouldRenew', () => {
  it('renews when never renewed or 60s elapsed', () => {
    expect(shouldRenew(null, 0)).toBe(true);
    expect(shouldRenew(0, 59_999)).toBe(false);
    expect(shouldRenew(0, 60_000)).toBe(true);
  });
});

describe('renewCommand', () => {
  it('builds the CLI invocation', () => {
    const c = renewCommand({ root, session, sessionId: '0123456789ab', host: 'mac', node: 'node', env: {} });
    expect(c.file).toBe('node');
    expect(c.args).toEqual(['/f/root/core/dist/cli.js', '--mode', 'session', '--store', 'local', 'renew', 'T-1']);
    expect(c.env.FACTORY_CLAIMANT).toBe('claude:mac:01234567');
    expect(c.env.FACTORY_ROOT).toBe('/f/root');
    expect(c.log).toBe('/f/root/runs/T-1/renew.log');
  });
  const args = (env) => renewCommand({ root, session, sessionId: '0123456789ab', host: 'mac', node: 'node', env });
  it('takes the store from the hook env, not the session file', () => {
    expect(args({ FACTORY_STORE: 'file' }).args).toContain('file');
    expect(args({ FACTORY_STORE: 'file' }).args).not.toContain('other');
  });
  it('renew accepts local and file and defaults to local', () => {
    const store = (env) => { const a = args(env).args; return a[a.indexOf('--store') + 1]; };
    expect(store({})).toBe('local');
    expect(store({ FACTORY_STORE: 'local' })).toBe('local');
    expect(store({ FACTORY_STORE: 'file' })).toBe('file');
  });
  it('skips an invalid store, and factory-app (not part of this build)', () => {
    expect(args({ FACTORY_STORE: 'sqlite' })).toBeNull();
    expect(args({ FACTORY_STORE: 'factory-app' })).toBeNull();
    expect(args({ FACTORY_STORE: 'blocks' })).toBeNull();
  });
  it('passes the factory recorded for the step', () => {
    const c = renewCommand({ root, session: { ...session, factory: 'myapp' }, sessionId: '0123456789ab', host: 'mac', node: 'node', env: { FACTORY_STORE: 'local' } });
    expect(c.args).toEqual(['/f/root/core/dist/cli.js', '--mode', 'session', '--store', 'local', 'renew', 'T-1', '--factory', 'myapp']);
  });
  it('leaves out a recorded factory that is not a factory id', () => {
    for (const factory of ['Bad_Id', '--store=file', 42, '']) {
      const c = renewCommand({ root, session: { ...session, factory }, sessionId: '0123456789ab', host: 'mac', node: 'node', env: {} });
      expect(c.args).not.toContain('--factory');
    }
  });
});

// Temp folders: a factory root (core/package.json, plugin manifest), a plain project folder, and a home with no factory.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')));
const makeRoot = (r) => {
  for (const d of ['core', 'plugin/.claude-plugin']) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, 'core', 'package.json'), '{}');
  fs.writeFileSync(path.join(r, 'plugin', '.claude-plugin', 'plugin.json'), '{"name":"factory"}');
  return r;
};
const froot = makeRoot(path.join(tmp, 'factory'));
const plain = path.join(tmp, 'plain');
fs.mkdirSync(plain);
const bareHome = path.join(tmp, 'home');
fs.mkdirSync(bareHome);
const baseEnv = () => {
  const env = { ...process.env, HOME: bareHome };
  for (const k of ['FACTORY_ROOT', 'FACTORY_STORE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE', 'CLAUDE_CONFIG_DIR']) delete env[k];
  return env;
};
// The hooks find the clone that holds them; run a copy outside any factory clone so each test controls the root.
const isolatedHooks = path.join(tmp, 'iso', 'plugin', 'hooks');
fs.cpSync(hooks, isolatedHooks, { recursive: true });
const runHook = (name, input, env, dir = isolatedHooks) =>
  spawnSync('node', [path.join(dir, name)], { input: typeof input === 'string' ? input : JSON.stringify(input), env, encoding: 'utf8' });

describe('resolveFactoryRoot from the plugin clone', () => {
  it('finds the root as the clone that holds the plugin', () => {
    const home = path.join(tmp, 'home3');
    fs.mkdirSync(home, { recursive: true });
    const clone = makeRoot(path.join(tmp, 'clone'));
    expect(resolveFactoryRoot({ CLAUDE_PROJECT_DIR: plain }, home, undefined, undefined, clone)).toEqual({ root: clone, projectMode: false });
    expect(resolveFactoryRoot({ CLAUDE_PROJECT_DIR: froot }, home, undefined, undefined, clone)).toEqual({ root: froot, projectMode: true });
    // A plugin folder that is not inside a factory clone, with no marketplace record: no root.
    expect(resolveFactoryRoot({}, home, undefined, undefined, plain)).toBeNull();
  });
  it('the default plugin root is two levels above lib.mjs', () => {
    expect(resolveFactoryRoot({}, null)?.root).toBe(path.resolve(hooks, '..', '..'));
  });
});

describe('resolveFactoryRoot through the marketplace record', () => {
  const cfgWith = (name, content) => {
    const cfg = fs.mkdtempSync(path.join(tmp, 'cfg-'));
    if (content !== undefined) {
      fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(cfg, 'plugins', 'known_marketplaces.json'), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return cfg;
  };
  const clone = makeRoot(path.join(tmp, 'mclone'));
  const home = path.join(tmp, 'home4');
  fs.mkdirSync(home, { recursive: true });
  const find = (cfg, extra = {}) => resolveFactoryRoot({ CLAUDE_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: plain, ...extra }, home, undefined, undefined, plain);

  it('uses installLocation or source.path of the the-software-factory entry', () => {
    expect(find(cfgWith('a', { 'the-software-factory': { installLocation: clone } }))).toEqual({ root: clone, projectMode: false });
    expect(find(cfgWith('b', { 'the-software-factory': { source: { path: clone } } }))?.root).toBe(clone);
  });
  it('defaults the config dir to ~/.claude', () => {
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'the-software-factory': { installLocation: clone } }));
    expect(resolveFactoryRoot({ CLAUDE_PROJECT_DIR: plain }, home, undefined, undefined, plain)?.root).toBe(clone);
  });
  it('a missing, garbled or non-factory record falls through without throwing', () => {
    const none = path.join(tmp, 'nohome');
    const noRoot = (cfg) => resolveFactoryRoot({ CLAUDE_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: plain }, none, undefined, undefined, plain);
    expect(noRoot(cfgWith('c'))).toBeNull();
    expect(noRoot(cfgWith('d', '{oops'))).toBeNull();
    expect(noRoot(cfgWith('e', '[1]'))).toBeNull();
    expect(noRoot(cfgWith('f', { 'the-software-factory': 7 }))).toBeNull();
    expect(noRoot(cfgWith('g', { 'the-software-factory': { installLocation: plain } }))).toBeNull();
    expect(noRoot(cfgWith('h', { other: { installLocation: clone } }))).toBeNull();
  });
  it('a hook run from the plugin cache finds the clone through the record', () => {
    const cfg = cfgWith('i', { 'the-software-factory': { installLocation: clone } });
    const cached = path.join(cfg, 'plugins', 'cache', 'the-software-factory', 'factory', '0.2.0', 'hooks');
    fs.cpSync(hooks, cached, { recursive: true });
    const file = path.join(fs.mkdtempSync(path.join(tmp, 'ss-')), 'env');
    const r = runHook('session-start.mjs', { session_id: 'abcdef123456' }, { ...baseEnv(), CLAUDE_CONFIG_DIR: cfg, CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: plain }, cached);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toContain(`export FACTORY_ROOT="${clone}"\n`);
  });
});

describe('session-start.mjs', () => {
  const envFile = () => path.join(fs.mkdtempSync(path.join(tmp, 'ss-')), 'env');
  const start = (env) => runHook('session-start.mjs', { session_id: 'abcdef123456' }, env);

  it('writes the export lines with HUSKY=0 in project mode', () => {
    const file = envFile();
    const r = start({ ...baseEnv(), CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: froot });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual([
      `export FACTORY_ROOT="${froot}"`,
      `export FACTORY_CLAIMANT=claude:${os.hostname()}:abcdef12`,
      'export FACTORY_STORE="${FACTORY_STORE:-local}"',
      'export HUSKY=0',
    ]);
  });
  it('exports the root found through FACTORY_ROOT from another folder, without HUSKY', () => {
    const file = envFile();
    start({ ...baseEnv(), CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: plain, FACTORY_ROOT: froot });
    expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual([
      `export FACTORY_ROOT="${froot}"`,
      `export FACTORY_CLAIMANT=claude:${os.hostname()}:abcdef12`,
      'export FACTORY_STORE="${FACTORY_STORE:-local}"',
    ]);
  });
  it('has no default root under home', () => {
    const home = path.join(tmp, 'home2');
    fs.mkdirSync(path.join(home, 'src', 'the-software-factory'), { recursive: true });
    makeRoot(path.join(home, 'src', 'the-software-factory'));
    const file = envFile();
    start({ ...baseEnv(), HOME: home, CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: plain });
    expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').toBe('');
  });
  it('writes nothing when no root resolves', () => {
    const file = envFile();
    const r = start({ ...baseEnv(), CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: plain });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').toBe('');
  });
  it('keeps a FACTORY_STORE from the launch shell and defaults it to local', () => {
    const file = envFile();
    start({ ...baseEnv(), CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: froot });
    const sh = (env) => spawnSync('sh', ['-c', `. "${file}" && printf %s "$FACTORY_STORE"`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).stdout;
    expect(sh({})).toBe('local');
    expect(sh({ FACTORY_STORE: 'file' })).toBe('file');
  });
  it('quotes a root with spaces so the env file stays valid shell', () => {
    const spaced = makeRoot(path.join(tmp, 'my root'));
    const file = envFile();
    start({ ...baseEnv(), CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: spaced });
    const r = spawnSync('sh', ['-c', `. "${file}" && printf %s "$FACTORY_ROOT"`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(r.stdout).toBe(spaced);
  });
  it('exits 0 without CLAUDE_ENV_FILE', () => {
    const r = start({ ...baseEnv(), CLAUDE_PROJECT_DIR: froot });
    expect(r.status).toBe(0);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });
});

describe('subagent-stop.mjs', () => {
  const withStep = (r, sid) => {
    fs.mkdirSync(path.join(r, 'runs', '.sessions'), { recursive: true });
    fs.writeFileSync(path.join(r, 'runs', '.sessions', `${sid}.json`), JSON.stringify(session));
  };
  const stop = (sid, env) => runHook('subagent-stop.mjs', { session_id: sid, agent_type: 'factory:implementer', last_assistant_message: 'hello' }, env);

  it('writes the reply file in project mode', () => {
    withStep(froot, 's1');
    const r = stop('s1', { ...baseEnv(), CLAUDE_PROJECT_DIR: froot });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(froot, 'runs', 'T-1', 'build.reply.md'), 'utf8')).toBe('hello');
  });
  it('writes the reply file under FACTORY_ROOT when started elsewhere', () => {
    const r2 = makeRoot(path.join(tmp, 'factory2'));
    withStep(r2, 's2');
    const r = stop('s2', { ...baseEnv(), CLAUDE_PROJECT_DIR: plain, FACTORY_ROOT: r2 });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(r2, 'runs', 'T-1', 'build.reply.md'), 'utf8')).toBe('hello');
  });
  it('does nothing when no root resolves', () => {
    const r = stop('s3', { ...baseEnv(), CLAUDE_PROJECT_DIR: plain });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(plain, 'runs'))).toBe(false);
  });
});

describe('renew.mjs', () => {
  const renew = (sid, env) => runHook('renew.mjs', { session_id: sid, agent_type: 'factory:implementer', tool_name: 'Read' }, env);
  const marker = (r, sid) => path.join(r, 'runs', '.sessions', `${sid}.renew`);

  it('renews under FACTORY_ROOT when started elsewhere', () => {
    const r3 = makeRoot(path.join(tmp, 'factory3'));
    fs.mkdirSync(path.join(r3, 'runs', '.sessions'), { recursive: true });
    fs.writeFileSync(path.join(r3, 'runs', '.sessions', 'r1.json'), JSON.stringify(session));
    const r = renew('r1', { ...baseEnv(), CLAUDE_PROJECT_DIR: plain, FACTORY_ROOT: r3 });
    expect(r.status).toBe(0);
    expect(fs.existsSync(marker(r3, 'r1'))).toBe(true);
  });
  it('does nothing when no root resolves', () => {
    const r = renew('r2', { ...baseEnv(), CLAUDE_PROJECT_DIR: plain });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(fs.existsSync(path.join(plain, 'runs'))).toBe(false);
  });
});
