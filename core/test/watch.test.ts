import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'watch.sh');

/** Fake CLI and claude: the CLI answers the peek with `out` and `code`; claude writes its arguments to a file. */
function fakes(out: string, code: number) {
  const dir = mkdtempSync(join(tmpdir(), 'watch-'));
  const calls = join(dir, 'claude-calls');
  const peeks = join(dir, 'peeks');
  const cli = join(dir, 'cli.sh');
  const claude = join(dir, 'claude.sh');
  writeFileSync(cli, `#!/usr/bin/env bash\necho "$*" >> "${peeks}"\necho "${out}"\nexit ${code}\n`);
  writeFileSync(claude, `#!/usr/bin/env bash\necho "$*" >> "${calls}"\n`);
  chmodSync(cli, 0o755);
  chmodSync(claude, 0o755);
  const run = (...args: string[]) =>
    spawnSync('bash', [SCRIPT, '--once', ...args], { env: { ...process.env, FACTORY_CLI: cli, FACTORY_CLAUDE: claude, FACTORY_WATCH_DIR: join(dir, 'state') }, encoding: 'utf8' });
  return { run, calls, peeks };
}

describe('tools/watch.sh', () => {
  test('starts one headless /factory:run when the peek finds work', () => {
    const f = fakes('work T-3', 0);
    const r = f.run('--factory', 'tsf');
    expect(r.status).toBe(0);
    expect(readFileSync(f.peeks, 'utf8').trim()).toBe('--mode loop next --peek --factory tsf');
    expect(readFileSync(f.calls, 'utf8').trim()).toBe('-p --permission-mode auto -- /factory:run --loop tsf');
    expect(r.stdout).toContain('work T-3: starting /factory:run');
  });

  test('starts nothing when the peek says there is no work', () => {
    const f = fakes('nothing to do', 1);
    const r = f.run();
    expect(r.status).toBe(0);
    expect(existsSync(f.calls)).toBe(false);
    expect(r.stdout).toContain('idle: nothing to do');
  });

  test('starts nothing and says so when the check fails', () => {
    const f = fakes('error: blocks: getFactoryDefs failed (HTTP 400)', 2);
    const r = f.run();
    expect(existsSync(f.calls)).toBe(false);
    expect(r.stdout).toContain('check failed (exit 2): error: blocks: getFactoryDefs failed (HTTP 400)');
  });

  test('a second watcher on the same state folder refuses to start', () => {
    const f = fakes('nothing to do', 1);
    const state = join(dirname(f.calls), 'state');
    // `flock` keeps holding the lock while the watcher runs under it, as a second watcher would find it.
    const hold = spawnSync('bash', ['-c', `mkdir -p "${state}" && FACTORY_CLI=/bin/false FACTORY_WATCH_DIR="${state}" flock -n "${state}/lock" bash "${SCRIPT}" --once`], { encoding: 'utf8' });
    expect(hold.status).toBe(3);
    expect(hold.stderr).toContain('another watcher is running');
  });

  test.each([
    [['--every', '5'], '--every must be'],
    [['--max', '0'], '--max must be 1 to 10'],
    [['--factory', 'Bad Id'], '--factory must be a factory id'],
  ])('refuses %j', (args, message) => {
    const r = fakes('work T-1', 0).run(...args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(message);
  });
});
