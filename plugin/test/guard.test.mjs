import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../hooks/decide.mjs';
import { isFactoryAgent, isFactoryRoot, resolveFactoryRoot, sessionFile } from '../hooks/lib.mjs';

const root = '/f/root';
const home = '/h';
const wt = '/f/root/.clones/worktrees/T-1';
const session = { taskId: 'T-1', step: 'implement', worktree: wt };
const impl = { agent_type: 'factory:implementer' };

const bash = (command, who = {}) => ({ ...who, tool_name: 'Bash', tool_input: { command } });
const write = (file_path, who = {}, tool_name = 'Write') => ({ ...who, tool_name, tool_input: { file_path } });
const run = (input, s = session) => decide(input, { root, home, session: s });

describe('guard decide', () => {
  const inWt = { ...impl, cwd: wt };
  const cases = [
    ['implementer git commit in wt cwd', bash('git commit -m x', inWt), false],
    ['main git push', bash('git push origin x'), true],
    ['security keychain', bash('security find-generic-password -s x'), true],
    ['secret-tool lookup', bash('secret-tool lookup service the-software-factory account some-credential'), true],
    ['secret-tool search', bash('secret-tool search --all service the-software-factory'), true],
    ['secret-tool store', bash('echo x | secret-tool store --label=x service a account b'), true],
    ['secret-tool clear', bash('secret-tool clear service a'), true],
    ['secret service over dbus', bash('gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets'), true],
    ['grep secret-tool stays allowed', bash('grep -rn secret-tool docs'), false],
    ['gh pr list', bash('gh pr list'), true],
    ['echo ghost', bash('echo ghost'), false],
    ['piped gh', bash('echo a | gh api x'), true],
    ['remote add', bash('git remote add o u'), true],
    ['remote -v', bash('git remote -v'), false],
    ['config set', bash('git config user.email x'), true],
    ['config get', bash('git config --get user.email'), false],
    ['ssh', bash('ssh host'), true],
    ['.ssh', bash('cat ~/.ssh/id_rsa'), true],
    ['token', bash('echo $GH_TOKEN'), true],
    ['api', bash('curl https://api.github.com/x'), true],
    ['main cli', bash('node core/dist/cli.js next'), false],
    ['impl cli', bash('node core/dist/cli.js next', impl), true],
    ['impl factory cmd', bash('factory next', impl), true],
    ['impl checkout file', bash('git checkout -- file.ts', inWt), false],
    ['impl checkout -b', bash('git checkout -b other', impl), true],
    ['impl switch', bash('git switch x', impl), true],
    ['impl rebase', bash('git rebase main', impl), true],
    ['main switch ok', bash('git switch x'), false],
    ['impl write in wt', write(`${wt}/src/a.ts`, impl), false],
    ['impl write core', write(`${root}/core/src/x.ts`, impl), true],
    ['impl write escape', write(`${wt}/../../../core/x.ts`, impl), true],
    ['impl edit in wt', write(`${wt}/a`, impl, 'Edit'), false],
    ['main write runs', write(`${root}/runs/T-1/spec.reply.md`), false],
    ['main write worktrees', write(`${root}/.clones/worktrees/T-1/a`), false],
    ['main write core', write(`${root}/core/x.ts`), true],
    ['home write', write(`${home}/notes/x.md`), true],
    ['home write impl', write(`${home}/notes/x.md`, impl), true],
    ['other checkout write', write(`${home}/src/r/x`), true],
    ['read outside', { tool_name: 'Read', tool_input: { file_path: `${home}/notes/projects/x-overview.md` } }, false],
    ['git -C push', bash('git -C wt push origin x'), true],
    ['git -c push', bash('git -c k=v push'), true],
    ['git --no-pager push', bash('git --no-pager push'), true],
    ['git -C remote add', bash('git -C wt remote add o u'), true],
    ['git -C config set', bash('git -C wt config user.email x'), true],
    ['git -C config get', bash('git -C wt config --get x'), false],
    ['git -C wt commit', bash(`git -C ${wt} commit -m x`, impl), false],
    ['impl git -C checkout -b', bash('git -C wt checkout -b y', impl), true],
    ['impl git -c switch', bash('git -c k=v switch y', impl), true],
    ['impl git -C rebase', bash('git -C wt rebase main', impl), true],
    ['impl git -C merge', bash('git -C wt merge x', impl), true],
    ['impl git -C branch', bash('git -C wt branch x', impl), true],
    ['grep security ok', bash('grep -rn security src', impl), false],
    ['grep -r security ok', bash('grep -r security .', impl), false],
    ['vitest src/security ok', bash('npx vitest run src/security', impl), false],
    ['security add', bash('security add-generic-password -s x'), true],
    ['impl relative write', { ...impl, tool_name: 'Write', tool_input: { file_path: 'core/src/x.ts' } }, true],
    ['main relative write', { tool_name: 'Write', tool_input: { file_path: 'runs/x' } }, true],
    ['multiedit in wt', write(`${wt}/a`, impl, 'MultiEdit'), false],
    ['multiedit outside', write(`${root}/core/a`, impl, 'MultiEdit'), true],
    ['notebook in wt', { ...impl, tool_name: 'NotebookEdit', tool_input: { notebook_path: `${wt}/n.ipynb` } }, false],
    ['no tool name', {}, true],
    ['other tool', { tool_name: 'WebFetch', tool_input: {} }, false],

    // I7: Keychain, hooks
    ['relative word ok', bash('npm test -- api'), false],
    ['relative other dir ok', bash('ls ../other'), false],
    ['security -v find', bash('security -v find-generic-password -s x'), true],
    ['security -i dump', bash('security -q dump-keychain'), true],
    ['find-internet-password anywhere', bash('/usr/bin/x find-internet-password'), true],
    ['dump-keychain anywhere', bash('echo dump-keychain'), true],
    ['.git/hooks', bash('rm .clones/data/.git/hooks/pre-push'), true],
    ['hooksPath', bash('git -c core.hooksPath=/dev/null commit -m x'), true],
    ['--no-verify', bash(`cd "${wt}" && git commit --no-verify -m x`, impl), true],
    ['main core/dist/cli.js ok', bash('node "/f/root/core/dist/cli.js" --mode session next --json'), false],
    ['impl core/dist secrets', bash(`node -e "import('/f/root/core/dist/secrets.js').then(m=>m.readSecret('github-pat'))"`, impl), true],
    ['impl core/src', bash('cat core/src/secrets.ts', impl), true],
    ['impl git --work-tree push', bash('git --work-tree x push', impl), true],
    ['impl git -C quoted push', bash('git -C "a b" push', impl), true],
    ['impl git push after cd', bash(`cd "${wt}" && git push origin x`, impl), true],
    ['impl git log --grep push (over-deny ok)', bash('git log --grep push', impl), true],
    ['impl echo push ok', bash('echo push', impl), false],
    ['impl git status then push word ok', bash('git status; echo push', impl), false],

    // I2: state-changing git for factory agents needs the step worktree
    ['impl git commit no wt', bash('git commit -m x', impl), true],
    ['impl git add no wt', bash('git add -A', impl), true],
    ['impl git cherry-pick no wt', bash('git cherry-pick abc', impl), true],
    ['impl git -C other commit', bash('git -C /f/root commit -m x', impl), true],
    ['impl cd other commit', bash('cd /f/root && git commit -m x', impl), true],
    ['impl cd wt quoted commit', bash(`cd "${wt}" && git commit -m x`, impl), false],
    ['impl cd wt export HUSKY=0 npm ci', bash(`cd "${wt}" && export HUSKY=0 && npm ci`, inWt), false],
    ['impl cd wt/client export HUSKY=0 npm test', bash(`cd "${wt}/client" && export HUSKY=0 && npm test`, impl), false],
    ['impl cd wt HUSKY=0 commit', bash(`cd "${wt}" && HUSKY=0 git commit -m x`, impl), false],
    ['impl HUSKY=0 commit no wt', bash('HUSKY=0 git commit -m x', impl), true],
    ['impl factory new denied', bash('node "/f/root/core/dist/cli.js" new --repo data --title "x" --description "d"', impl), true],
    ['impl HUSKY=0 factory new denied', bash('HUSKY=0 node "/f/root/core/dist/cli.js" --mode session new --repo data --title "x" --description-file "/f/root/runs/.drafts/s.md" --ready', impl), true],
    ['main factory new ok', bash('HUSKY=0 node "/f/root/core/dist/cli.js" --mode session new --repo data --base dev --title "Fix the typo" --description-file "/f/root/runs/.drafts/s.md"'), false],
    ['main factory new --ready ok', bash('node "/f/root/core/dist/cli.js" new --repo data --title "x" --description-file "/f/root/runs/.drafts/s.md" --ready'), false],
    ['main HUSKY=0 core cli ok', bash('HUSKY=0 node "/f/root/core/dist/cli.js" --mode session next --json'), false],
    ['impl cd wt bare commit', bash(`cd ${wt} && git add -A && git commit -m x`, impl), false],
    ['impl -C wt quoted add', bash(`git -C "${wt}" add a.ts`, impl), false],
    ['impl cd wt prefix lookalike', bash(`cd ${wt}0 && git commit -m x`, impl), true],
    ['impl cwd outside wt', bash('git commit -m x', { ...impl, cwd: root }), true],
    ['impl cwd inside wt subdir', bash('git commit -m x', { ...impl, cwd: `${wt}/src` }), false],
    ['impl git status no wt ok', bash('git status', impl), false],
    ['impl git diff no wt ok', bash('git diff HEAD', impl), false],
    ['impl git log no wt ok', bash('git log --oneline -5', impl), false],
    ['main git commit no wt ok', bash('git commit -m x'), false],

    // M8: only branch-creating or deleting forms of git branch
    ['impl git branch --show-current ok', bash(`git -C ${wt} branch --show-current`, impl), false],
    ['impl git branch list ok', bash('git branch', impl), false],
    ['impl git branch -D', bash('git branch -D x', impl), true],
    ['impl git branch -m', bash('git branch -m x y', impl), true],
    ['impl git branch create', bash('git branch newb', impl), true],
  ];
  for (const [name, input, deny] of cases) {
    it(name, () => {
      const r = run(input);
      expect(r.deny).toBe(deny);
      if (deny) expect(r.reason).toMatch(/^factory guard:/);
    });
  }

  describe('worktree subfolders and solution files', () => {
    const w3 = `${root}/.clones/worktrees/T-3`;
    const s3 = { taskId: 'T-3', step: 'implement', worktree: w3 };
    const abs = '/Users/x/src/the-software-factory/.clones/worktrees/T-3';
    const table = [
      ['cd wt quoted', bash(`cd "${w3}" && git commit -m x`, impl), false],
      ['cd wt/server quoted', bash(`cd "${w3}/server" && git commit -m x`, impl), false],
      ['cd wt/server bare', bash(`cd ${w3}/server && git commit -m x`, impl), false],
      ['-C wt/client quoted', bash(`git -C "${w3}/client" add src/a.ts`, impl), false],
      ['cd wt/ trailing slash', bash(`cd "${w3}/" && git commit -m x`, impl), false],
      ['cd wt/../.. escape', bash(`cd "${w3}/../.." && git commit -m x`, impl), true],
      ['cd wt/../T-30 escape', bash(`cd ${w3}/../T-30 && git commit -m x`, impl), true],
      ['-C wt/../../.. escape', bash(`git -C ${w3}/../../.. add .`, impl), true],
      ['cd wt/./../.. escape', bash(`cd "${w3}/./../.." && git commit -m x`, impl), true],
      ['cd T-30 lookalike', bash(`cd "${root}/.clones/worktrees/T-30" && git commit -m x`, impl), true],
      ['cd root', bash(`cd "${root}" && git commit -m x`, impl), true],
      ['dotnet test ../../App.slnx', bash(`cd "${w3}/server/src" && dotnet test ../../App.slnx`, impl), false],
      ['dotnet build ../App.slnx', bash('dotnet build ../App.slnx', impl), false],
      ['absolute wt App.slnx', bash(`dotnet test ${abs}/App.slnx`, impl), false],
    ];
    for (const [name, input, deny] of table) {
      it(name, () => {
        const sess = name.startsWith('absolute') ? { ...s3, worktree: abs } : s3;
        expect(run(input, sess).deny).toBe(deny);
      });
    }
  });

  it('allows everything when no factory work is active', () => {
    expect(decide(bash('git push'), { root, home, session: null, active: false })).toEqual({ deny: false });
    expect(decide({}, { root, home, session: null, active: false })).toEqual({ deny: false });
    expect(decide(bash('git push'), { root, home, session: null, active: true }).deny).toBe(true);
  });

  it('factory new: the main session may run it during a step or in project mode; an agent may not', () => {
    const cmd = bash('HUSKY=0 node "/f/root/core/dist/cli.js" --mode session new --repo data --title "x" --description-file "/f/root/runs/.drafts/s.md"');
    expect(decide(cmd, { root, home, session: null, active: true }).deny).toBe(false);
    expect(decide(cmd, { root, home, session: null, projectMode: true, active: true }).deny).toBe(false);
    expect(decide(cmd, { root, home, session }).deny).toBe(false);
    expect(decide({ ...cmd, ...impl }, { root, home, session: null, active: true }).deny).toBe(true);
  });

  it('implementer write with null session is denied', () => {
    const r = run(write(`${wt}/a`, impl), null);
    expect(r).toEqual({ deny: true, reason: expect.stringContaining('no active factory step') });
    expect(r.reason).toMatch(/^factory guard:/);
  });

  it('notebook_path is resolved', () => {
    const r = run({ ...impl, tool_name: 'NotebookEdit', tool_input: { notebook_path: `${root}/x.ipynb` } });
    expect(r.deny).toBe(true);
    expect(r.reason).toContain('inside the step worktree');
  });

  it('agent with a session lacking worktree is denied', () => {
    const r = run(write(`${wt}/a`, impl), { taskId: 'T-1', step: 'implement' });
    expect(r.deny).toBe(true);
    expect(r.reason).toContain('no active factory step');
  });

  it('state-changing git without the worktree names the subcommand', () => {
    expect(run(bash('git commit -m x', impl)).reason).toBe('factory guard: git commit must run in the step worktree');
    expect(run(bash('git -C x stash', impl)).reason).toBe('factory guard: git stash must run in the step worktree');
  });

  it('state-changing git with no active step is denied', () => {
    expect(run(bash(`cd "${wt}" && git commit -m x`, impl), null).deny).toBe(true);
  });

});

describe('guard symlinks (M3)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-ln-')));
  const fhome = path.join(tmp, 'home');
  const froot = path.join(tmp, 'root');
  const fwt = path.join(froot, '.clones', 'worktrees', 'T-1');
  const outside = path.join(fhome, 'notes');
  fs.mkdirSync(fwt, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(froot, 'core'), { recursive: true });
  fs.symlinkSync(froot, path.join(fwt, 'up'));
  fs.symlinkSync(outside, path.join(fwt, 'v'));
  // The same worktree reached through a symlinked parent still counts as the worktree.
  fs.symlinkSync(froot, path.join(tmp, 'alias'));
  const ctx = { root: froot, home: fhome, session: { taskId: 'T-1', step: 'build', worktree: fwt } };
  const go = (p, who = impl) => decide(write(p, who), ctx);

  it('a plain write in the worktree is allowed', () => {
    expect(go(path.join(fwt, 'src', 'a.ts')).deny).toBe(false);
  });
  it('a write through a worktree symlink that leaves it is denied', () => {
    const r = go(path.join(fwt, 'up', 'core', 'x.ts'));
    expect(r.deny).toBe(true);
    expect(r.reason).toContain('inside the step worktree');
  });
  it('a write through a symlink to a missing deeper path is denied', () => {
    expect(go(path.join(fwt, 'up', 'newdir', 'deeper', 'x.ts')).deny).toBe(true);
  });
  it('a write through a worktree symlink to a folder outside it is denied for everyone', () => {
    expect(go(path.join(fwt, 'v', 'journal', 'x.md')).reason).toContain('inside the step worktree');
    expect(go(path.join(fwt, 'v', 'x.md'), {}).reason).toContain('main session may write only');
  });
  it('the worktree through a symlinked parent is still the worktree', () => {
    expect(go(path.join(tmp, 'alias', '.clones', 'worktrees', 'T-1', 'a.ts')).deny).toBe(false);
  });
  it('a git commit from a symlinked cwd inside the worktree is allowed', () => {
    const cwd = path.join(tmp, 'alias', '.clones', 'worktrees', 'T-1');
    expect(decide(bash('git commit -m x', { ...impl, cwd }), ctx).deny).toBe(false);
  });
});

describe('lib', () => {
  it('isFactoryAgent', () => {
    expect(isFactoryAgent({ agent_type: 'factory:verifier' })).toBe(true);
    expect(isFactoryAgent({})).toBe(false);
    expect(isFactoryAgent({ agent_type: 'other:x' })).toBe(false);
  });
  describe('resolveFactoryRoot', () => {
    // A fake file system: a folder is a factory root when core/package.json and the plugin manifest (name factory) exist in it.
    const MANIFEST = (r) => path.join(r, 'plugin', '.claude-plugin', 'plugin.json');
    const fsWith = (...roots) => {
      const paths = new Set(roots.flatMap((r) => [path.join(r, 'core', 'package.json'), MANIFEST(r)]));
      return (p) => paths.has(p);
    };
    const readFactory = () => '{"name":"factory"}';
    const home = '/h';
    const exists = fsWith('/env', '/proj');
    const resolve = (env, h, ex = exists, rd = readFactory) => resolveFactoryRoot(env, h, ex, rd, '/nowhere');

    it('FACTORY_ROOT wins first', () => {
      expect(resolve({ FACTORY_ROOT: '/env', CLAUDE_PROJECT_DIR: '/proj' }, home, exists))
        .toEqual({ root: '/env', projectMode: false });
    });
    it('CLAUDE_PROJECT_DIR wins second, in project mode', () => {
      expect(resolve({ CLAUDE_PROJECT_DIR: '/proj' }, home, exists))
        .toEqual({ root: '/proj', projectMode: true });
    });
    it('there is no default path under home', () => {
      expect(resolve({ CLAUDE_PROJECT_DIR: '/elsewhere' }, home, exists)).toBeNull();
      expect(resolve({}, home, exists)).toBeNull();
    });
    it('a set but invalid FACTORY_ROOT returns null without falling through', () => {
      expect(resolve({ FACTORY_ROOT: '/nope', CLAUDE_PROJECT_DIR: '/proj' }, home, exists)).toBeNull();
    });
    it('projectMode only when the root is the project dir', () => {
      expect(resolve({ FACTORY_ROOT: '/proj', CLAUDE_PROJECT_DIR: '/proj' }, home, exists).projectMode).toBe(true);
      expect(resolve({ FACTORY_ROOT: '/env', CLAUDE_PROJECT_DIR: '/proj' }, home, exists).projectMode).toBe(false);
      expect(resolve({ CLAUDE_PROJECT_DIR: '/nofactory' }, home, exists)).toBeNull();
    });
    it('a folder with only core/ is not a factory root', () => {
      const partial = (p) => p === '/proj/core/package.json';
      expect(resolve({ CLAUDE_PROJECT_DIR: '/proj' }, home, partial)).toBeNull();
    });
    it('core/ and plugin/ without the manifest is not a root', () => {
      const noManifest = (p) => ['/proj/core/package.json', '/proj/plugin'].includes(p);
      expect(resolve({ CLAUDE_PROJECT_DIR: '/proj' }, home, noManifest)).toBeNull();
    });
    it('a manifest named something else is not a root', () => {
      expect(resolve({ CLAUDE_PROJECT_DIR: '/proj' }, home, fsWith('/proj'), () => '{"name":"other"}')).toBeNull();
    });
    it('a malformed manifest is not a root', () => {
      expect(resolve({ CLAUDE_PROJECT_DIR: '/proj' }, home, fsWith('/proj'), () => '{oops')).toBeNull();
      expect(resolve({ CLAUDE_PROJECT_DIR: '/proj' }, home, fsWith('/proj'), () => { throw new Error('EACCES'); })).toBeNull();
    });
    it('a root without repos/ resolves', () => {
      expect(fsWith('/proj')('/proj/repos')).toBe(false);
      expect(resolve({ CLAUDE_PROJECT_DIR: '/proj' }, home)).toEqual({ root: '/proj', projectMode: true });
    });
    it('null when nothing qualifies', () => {
      expect(resolveFactoryRoot({ CLAUDE_PROJECT_DIR: '/proj' }, home, () => false)).toBeNull();
      expect(resolveFactoryRoot({}, home, fsWith('/env'))).toBeNull();
    });
  });
  it('isFactoryRoot needs core/package.json and the factory manifest, not repos/', () => {
    const has = (...ds) => (p) => ds.some((d) => p === `/r/${d}`);
    const files = ['core/package.json', 'plugin/.claude-plugin/plugin.json'];
    const rd = () => '{"name":"factory"}';
    expect(isFactoryRoot('/r', has(...files), rd)).toBe(true);
    expect(isFactoryRoot('/r', has(...files, 'repos'), rd)).toBe(true);
    expect(isFactoryRoot('/r', has('core/package.json'), rd)).toBe(false);
    expect(isFactoryRoot('/r', has('repos', 'core/package.json'), rd)).toBe(false);
  });
  it('sessionFile', () => {
    expect(sessionFile('/r', 's1')).toBe('/r/runs/.sessions/s1.json');
  });
});

describe('entry script', () => {
  const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')));
  const link = path.join(tmp, 'link');
  fs.symlinkSync(pluginDir, link);
  const makeRoot = (r) => {
    for (const d of ['core', 'plugin/.claude-plugin', 'runs/.sessions']) fs.mkdirSync(path.join(r, d), { recursive: true });
    fs.writeFileSync(path.join(r, 'core', 'package.json'), '{}');
    fs.writeFileSync(path.join(r, 'plugin', '.claude-plugin', 'plugin.json'), '{"name":"factory"}');
    return r;
  };
  // A home, a factory root named by FACTORY_ROOT, a home without one, a project root, and a plain project folder.
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const envRoot = makeRoot(path.join(tmp, 'env-factory'));
  const bareHome = path.join(tmp, 'bare-home');
  fs.mkdirSync(bareHome);
  const projRoot = makeRoot(path.join(tmp, 'factory'));
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  const projectMode = { HOME: bareHome, CLAUDE_PROJECT_DIR: projRoot };
  const elsewhere = { HOME: home, CLAUDE_PROJECT_DIR: plain, FACTORY_ROOT: envRoot };

  // The hooks find the clone that holds them; run a copy outside any factory clone so these tests control the root.
  const isolated = path.join(tmp, 'iso', 'plugin');
  fs.cpSync(path.join(pluginDir, 'hooks'), path.join(isolated, 'hooks'), { recursive: true });
  const runScript = (dir, stdin, env = projectMode) =>
    spawnSync('node', [path.join(dir === pluginDir ? isolated : dir, 'hooks', 'guard.mjs')], { input: stdin, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const call = (tool_input, extra = {}, tool_name = 'Bash') => JSON.stringify({ tool_name, tool_input, ...extra });
  const gitPush = call({ command: 'git push' }, { session_id: 's' });
  const reason = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  const denied = (r) => r.status === 0 && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny';

  describe('project mode', () => {
    it('denies through a symlinked plugin dir', () => {
      expect(denied(runScript(link, gitPush))).toBe(true);
    });
    it('denies git push by the main session with no step file', () => {
      expect(reason(runScript(pluginDir, call({ command: 'git push' }, { session_id: 'no-step' })))).toBe('factory guard: Bash denied (git push)');
    });
    it('stays on when FACTORY_ROOT is set but not a factory root', () => {
      expect(denied(runScript(pluginDir, call({ command: 'git push' }, { session_id: 'no-step' }), { ...projectMode, FACTORY_ROOT: plain }))).toBe(true);
    });
    it('stays on when FACTORY_ROOT names another factory', () => {
      const other = makeRoot(path.join(tmp, 'other-factory'));
      expect(denied(runScript(pluginDir, call({ command: 'git push' }, { session_id: 'no-step' }), { ...projectMode, FACTORY_ROOT: other }))).toBe(true);
    });
    it('stays on when the project dir is a symlink to the factory', () => {
      const alias = path.join(tmp, 'factory-alias');
      fs.symlinkSync(projRoot, alias);
      const push = call({ command: 'git push' }, { session_id: 'no-step' });
      expect(denied(runScript(pluginDir, push, { ...projectMode, CLAUDE_PROJECT_DIR: alias }))).toBe(true);
      expect(denied(runScript(pluginDir, push, { ...projectMode, CLAUDE_PROJECT_DIR: alias, FACTORY_ROOT: projRoot }))).toBe(true);
    });
    it('allows a harmless call with no output', () => {
      const r = runScript(pluginDir, call({ command: 'ls' }));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
    it('denies on empty stdin', () => {
      expect(reason(runScript(pluginDir, ''))).toContain('no tool name');
    });
    it('denies on invalid stdin with a guard error', () => {
      expect(reason(runScript(pluginDir, '{not json'))).toMatch(/^factory guard error:/);
    });
  });

  describe('outside factory work (user-scoped install)', () => {
    it('allows git push by the main session in a non-factory project, with no output', () => {
      const r = runScript(pluginDir, call({ command: 'git push' }, { session_id: 'idle' }), elsewhere);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
    it('allows a Write to the home folder, with no output', () => {
      const r = runScript(pluginDir, call({ file_path: path.join(home, 'x.txt') }, { session_id: 'idle' }, 'Write'), elsewhere);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
    it('allows malformed input without output', () => {
      for (const stdin of ['', '{not json', '{}']) {
        const r = runScript(pluginDir, stdin, elsewhere);
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      }
    });
    it('allows the main session when no factory root resolves', () => {
      const r = runScript(pluginDir, gitPush, { HOME: bareHome, CLAUDE_PROJECT_DIR: plain });
      expect(r.stdout).toBe('');
    });
  });

  describe('during a /factory:run step', () => {
    const sid = 'stepping';
    fs.writeFileSync(path.join(envRoot, 'runs', '.sessions', `${sid}.json`), JSON.stringify({ taskId: 'T-1', step: 'build' }));

    it('denies git push by the main session whose step file exists, naming the step file', () => {
      const file = path.join(envRoot, 'runs', '.sessions', `${sid}.json`);
      expect(reason(runScript(pluginDir, call({ command: 'git push' }, { session_id: sid }), elsewhere)))
        .toBe(`factory guard: Bash denied (git push) (step file ${file} exists)`);
    });
    it('denies a main-session Write outside runs/ and .clones/worktrees/', () => {
      const r = runScript(pluginDir, call({ file_path: path.join(home, 'x.txt') }, { session_id: sid }, 'Write'), elsewhere);
      expect(reason(r)).toContain('main session may write only');
    });
    it('finds the step file under FACTORY_ROOT', () => {
      fs.writeFileSync(path.join(projRoot, 'runs', '.sessions', 'via-env.json'), '{}');
      const env = { HOME: bareHome, CLAUDE_PROJECT_DIR: plain, FACTORY_ROOT: projRoot };
      expect(denied(runScript(pluginDir, call({ command: 'git push' }, { session_id: 'via-env' }), env))).toBe(true);
      expect(runScript(pluginDir, call({ command: 'git push' }, { session_id: 'other' }), env).stdout).toBe('');
    });
  });

  describe('factory agents', () => {
    const agentPush = call({ command: 'git push' }, { session_id: 'idle', agent_type: 'factory:implementer' });
    it('are denied git push everywhere', () => {
      for (const env of [projectMode, elsewhere, { HOME: bareHome, CLAUDE_PROJECT_DIR: plain, FACTORY_ROOT: projRoot }]) {
        expect(reason(runScript(pluginDir, agentPush, env))).toMatch(/^factory guard: Bash denied/);
      }
    });
    it('are denied with factory root not found when no root resolves', () => {
      const r = runScript(pluginDir, call({ command: 'ls' }, { agent_type: 'factory:verifier' }), { HOME: bareHome, CLAUDE_PROJECT_DIR: plain });
      expect(reason(r)).toBe('factory guard: factory root not found');
    });
    it('are denied when FACTORY_ROOT is set but not a factory root', () => {
      const r = runScript(pluginDir, call({ command: 'ls' }, { agent_type: 'factory:verifier' }), { ...elsewhere, FACTORY_ROOT: plain });
      expect(reason(r)).toBe('factory guard: factory root not found');
    });
  });
});
