import { describe, expect, it } from 'vitest';
import { formatReport, runChecks, shellExec, type Exec } from '../src/checks.js';
import { normaliseChecks } from '../src/checksSchema.js';
import type { RepoConfig } from '../src/repoConfig.js';

const OLD = {
  server: { cwd: 'server', build: 'dotnet build', test: 'dotnet test' },
  client: { cwd: 'client', install: 'npm ci', typecheck: 'npm run tc', lint: 'npm run lint', test: 'npm test' },
  e2e: 'off',
};
const converted = normaliseChecks(OLD);
if (!converted.ok) throw new Error(converted.error);
const cfg: Pick<RepoConfig, 'checks'> = { checks: converted.value };

function stub(failing: string[] = [], output = 'ok') {
  const calls: { cmd: string; cwd: string }[] = [];
  const exec: Exec = async (cmd, cwd) => {
    calls.push({ cmd, cwd });
    return { code: failing.includes(cmd) ? 1 : 0, output };
  };
  return { calls, exec };
}

describe('normaliseChecks', () => {
  it('the old shape converts to the same names and order as today', () => {
    const r = normaliseChecks(OLD);
    expect(r.ok && r.value.map((c) => [c.name, c.needs ?? null])).toEqual([
      ['server.build', null], ['server.test', 'server.build'], ['client.install', null],
      ['client.typecheck', 'client.install'], ['client.lint', 'client.install'], ['client.test', 'client.install']]);
  });
  it('defaults cwd to . and accepts a list', () => {
    expect(normaliseChecks([{ name: 'a', run: 'x' }])).toEqual({ ok: true, value: [{ name: 'a', cwd: '.', run: 'x' }] });
  });
  it('an empty list is valid', () => expect(normaliseChecks([])).toEqual({ ok: true, value: [] }));
  it.each([
    [[{ name: 'a', run: 'x' }, { name: 'a', run: 'y' }], 'checks.1.name: duplicate check name a'],
    [[{ name: 'a', run: 'x', needs: 'b' }], 'checks.0.needs: b is not an earlier check'],
    [[{ name: 'a', run: 'x' }, { name: 'b', run: 'y', needs: 'c' }, { name: 'c', run: 'z' }], 'checks.1.needs: c is not an earlier check'],
    [[{ name: 'a', run: 'x', cwd: '../up' }], 'checks.0.cwd: must be a folder inside the repo (relative, no ..)'],
    [[{ name: '-a', run: 'x' }], 'checks.0.name: must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'],
    [[{ name: 'a', run: '' }], 'checks.0.run: must not be empty'],
    [undefined, 'checks is required'],
    ['nope', 'checks must be a list'],
  ])('refuses %j', (raw, error) => expect(normaliseChecks(raw)).toEqual({ ok: false, error }));
});

describe('runChecks', () => {
  it('skips a check whose needs failed, others still run', async () => {
    const r = await runChecks({ checks: [
      { name: 'install', cwd: '.', run: 'i' }, { name: 'test', cwd: '.', run: 't', needs: 'install' }, { name: 'lint', cwd: '.', run: 'l' }] }, '/wt', stub(['i']).exec);
    expect(r.steps.map((s) => s.exitCode)).toEqual([1, null, 0]);
    expect(r.passed).toBe(false);
  });
  it('a skipped check also skips its dependants', async () => {
    const { calls, exec } = stub(['a']);
    const r = await runChecks({ checks: [
      { name: 'a', cwd: '.', run: 'a' }, { name: 'b', cwd: '.', run: 'b', needs: 'a' }, { name: 'c', cwd: 'sub', run: 'c', needs: 'b' }] }, '/wt', exec);
    expect(r.steps.map((s) => s.exitCode)).toEqual([1, null, null]);
    expect(calls.map((c) => c.cmd)).toEqual(['a']);
  });
  it('an empty list passes with no steps', async () => {
    expect(await runChecks({ checks: [] }, '/wt', stub().exec)).toEqual({ passed: true, steps: [] });
  });
  it('skips server.test when build fails but still runs client steps', async () => {
    const { calls, exec } = stub(['dotnet build']);
    const r = await runChecks(cfg, '/wt', exec);
    expect(r.passed).toBe(false);
    expect(r.steps.map((s) => s.name)).toEqual([
      'server.build', 'server.test', 'client.install', 'client.typecheck', 'client.lint', 'client.test',
    ]);
    const t = r.steps[1]!;
    expect(t.exitCode).toBeNull();
    expect(t.output).toBe('');
    expect(calls.map((c) => c.cmd)).not.toContain('dotnet test');
    expect(calls.map((c) => c.cmd)).toContain('npm test');
  });

  it('passes cwd per group', async () => {
    const { calls, exec } = stub();
    const r = await runChecks(cfg, '/wt', exec);
    expect(r.passed).toBe(true);
    expect(calls.find((c) => c.cmd === 'dotnet build')!.cwd).toBe('/wt/server');
    expect(calls.find((c) => c.cmd === 'npm ci')!.cwd).toBe('/wt/client');
  });

  it('skips remaining client steps when install fails', async () => {
    const { exec } = stub(['npm ci']);
    const r = await runChecks(cfg, '/wt', exec);
    expect(r.steps.slice(2).map((s) => s.exitCode)).toEqual([1, null, null, null]);
    expect(r.steps[0]!.exitCode).toBe(0);
  });

  it('keeps the last 4000 characters of output', async () => {
    const { exec } = stub([], 'a'.repeat(6000) + 'b'.repeat(4000));
    const r = await runChecks(cfg, '/wt', exec);
    expect(r.steps[0]!.output).toBe('b'.repeat(4000));
  });
});

describe('formatReport', () => {
  it('lists a line per step', async () => {
    const { exec } = stub(['dotnet build']);
    const text = formatReport(await runChecks(cfg, '/wt', exec));
    expect(text.split('\n').slice(0, 2)).toEqual(['## Checks: failed', '']);
    expect(text).toContain('- ❌ server.build (exit 1)');
    expect(text).toContain('- ✅ client.lint');
    expect(text).toContain('- ⏭ server.test (skipped)');
  });

  it('says passed when all pass', async () => {
    const { exec } = stub();
    expect(formatReport(await runChecks(cfg, '/wt', exec)).startsWith('## Checks: passed\n\n')).toBe(true);
  });
});

describe('shellExec', () => {
  it('returns exit code and merged output', async () => {
    const r = await shellExec('echo hi && exit 3', process.cwd());
    expect(r.code).toBe(3);
    expect(r.output).toContain('hi');
  });
});
