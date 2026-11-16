import { expect, test } from 'vitest';
import { realGhCli } from '../../src/init/ghCli.js';
import type { ExecFile } from '../../src/secrets.js';

const status = (logins: { login: string; state: string; active?: boolean }[]) => JSON.stringify({ hosts: { 'github.com': logins } });

function fakes(out: string, code = 0, refresh: () => Promise<number> = async () => 0) {
  const execs: string[][] = [];
  const runs: string[][] = [];
  const exec: ExecFile = async (_f, args) => { execs.push(args); return { code, stdout: out, stderr: '' }; };
  const run = async (args: string[]) => { runs.push(args); return args[1] === 'refresh' ? refresh() : 0; };
  return { execs, runs, cli: realGhCli(exec, run) };
}

test('logins keeps the spelling and only working logins', async () => {
  const { cli } = fakes(status([{ login: 'Me', state: 'success' }, { login: 'old', state: 'error' }]));
  expect(await cli.logins()).toEqual(['Me']);
  expect(await fakes('not json').cli.logins()).toEqual([]);
  expect(await fakes(status([{ login: 'me', state: 'success' }]), 1).cli.logins()).toEqual([]);
});

test('login runs auth login interactively', async () => {
  const f = fakes(status([]));
  await f.cli.login();
  expect(f.runs).toEqual([['auth', 'login', '--hostname', 'github.com']]);
});

test('refresh switches to the login first only when there are several', async () => {
  const one = fakes(status([{ login: 'me', state: 'success' }]));
  await one.cli.refreshProjectScope('me');
  expect(one.execs.some((a) => a.includes('switch'))).toBe(false);
  expect(one.runs).toEqual([['auth', 'refresh', '--hostname', 'github.com', '-s', 'project']]);

  const two = fakes(status([{ login: 'me', state: 'success' }, { login: 'work', state: 'success' }]));
  await two.cli.refreshProjectScope('work');
  expect(two.execs.at(-1)).toEqual(['auth', 'switch', '--hostname', 'github.com', '--user', 'work']);
  expect(two.runs).toHaveLength(1);
});

const SWITCH = ['auth', 'switch', '--hostname', 'github.com', '--user'];
const switches = (execs: string[][]) => execs.filter((a) => a[1] === 'switch');

test('refresh switches back to the account that was active before', async () => {
  const f = fakes(status([{ login: 'me', state: 'success', active: true }, { login: 'work', state: 'success', active: false }]));
  await f.cli.refreshProjectScope('work');
  expect(switches(f.execs)).toEqual([[...SWITCH, 'work'], [...SWITCH, 'me']]);
  expect(f.runs).toEqual([['auth', 'refresh', '--hostname', 'github.com', '-s', 'project']]);
});

test('refresh switches back also when the refresh fails or throws', async () => {
  const accounts = status([{ login: 'me', state: 'success', active: true }, { login: 'work', state: 'success', active: false }]);
  const failed = fakes(accounts, 0, async () => 1);
  await failed.cli.refreshProjectScope('work');
  expect(switches(failed.execs)).toEqual([[...SWITCH, 'work'], [...SWITCH, 'me']]);
  const thrown = fakes(accounts, 0, async () => { throw new Error('boom'); });
  await expect(thrown.cli.refreshProjectScope('work')).rejects.toThrow('boom');
  expect(switches(thrown.execs)).toEqual([[...SWITCH, 'work'], [...SWITCH, 'me']]);
});

test('refresh does not switch when the login is already the active account', async () => {
  const f = fakes(status([{ login: 'me', state: 'success', active: false }, { login: 'work', state: 'success', active: true }]));
  await f.cli.refreshProjectScope('work');
  expect(switches(f.execs)).toEqual([]);
});
