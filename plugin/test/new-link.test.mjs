import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLink } from '../skills/new/link.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/new/link.mjs');
const BOARD = 'https://board.test';
const draft = (over = {}) => ({ title: 'Fix it', description: 'Details', factory: 'blocks', repo: 'os', base: 'dev', ...over });
const params = (url) => new URL(url).searchParams;

function runCli(d, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-link-'));
  const file = path.join(dir, 'draft.json');
  fs.writeFileSync(file, JSON.stringify(d));
  const { FACTORY_BOARD_URL, ...rest } = process.env;
  return spawnSync(process.execPath, [script, file], { encoding: 'utf8', env: { ...rest, ...env } });
}

describe('buildLink', () => {
  it('builds /?new=1 with the five fields', () => {
    const url = buildLink(draft(), BOARD);
    expect(url.startsWith(`${BOARD}/?new=1&title=`)).toBe(true);
    const p = params(url);
    expect([p.get('new'), p.get('title'), p.get('description'), p.get('factory'), p.get('repo'), p.get('base')]).toEqual(['1', 'Fix it', 'Details', 'blocks', 'os', 'dev']);
  });

  it('encodes spaces, ampersands, hashes, newlines and non-ASCII so they round-trip', () => {
    const text = 'a b & c # d\nline two é 日本 100%';
    const url = buildLink(draft({ title: text, description: text }), BOARD);
    expect(url).not.toMatch(/[\n #](?!$)/);
    expect(url.includes('#')).toBe(false);
    expect(params(url).get('title')).toBe(text);
    expect(params(url).get('description')).toBe(text);
  });

  it('caps the title at 200 and the description at 8000 characters', () => {
    const p = params(buildLink(draft({ title: 't'.repeat(300), description: 'd'.repeat(9000) }), BOARD));
    expect(p.get('title')).toHaveLength(200);
    expect(p.get('description')).toHaveLength(8000);
  });

  it('accepts any repo id of the right shape (the Board checks membership)', () => {
    for (const repo of ['os', 'my-repo2', 'x']) expect(params(buildLink(draft({ repo }), BOARD)).get('repo')).toBe(repo);
  });

  it('rejects a malformed repo id', () => {
    for (const repo of ['Nope', '1x', 'a b', '', 'a'.repeat(41), undefined]) {
      expect(() => buildLink(draft({ repo }), BOARD)).toThrow(/factory: unknown repo/);
    }
  });

  it('rejects a malformed or missing factory id', () => {
    for (const factory of ['Blocks', '1x', 'a&b', '', 'a'.repeat(41), undefined]) {
      expect(() => buildLink(draft({ factory }), BOARD)).toThrow(/factory: unknown factory/);
    }
    expect(params(buildLink(draft({ factory: 'a'.repeat(40) }), BOARD)).get('factory')).toBe('a'.repeat(40));
  });

  it('rejects a blank title', () => {
    expect(() => buildLink(draft({ title: '   ' }), BOARD)).toThrow(/title/);
    expect(() => buildLink(draft({ title: undefined }), BOARD)).toThrow(/title/);
  });

  it('rejects base main', () => {
    expect(() => buildLink(draft({ base: 'main' }), BOARD)).toThrow('factory: the factory never targets main');
    expect(() => buildLink(draft({ base: ' main ' }), BOARD)).toThrow('factory: the factory never targets main');
  });

  it('strips trailing slashes from the board url', () => {
    expect(buildLink(draft(), `${BOARD}/`).startsWith(`${BOARD}/?new=1`)).toBe(true);
    expect(buildLink(draft(), `${BOARD}//`).startsWith(`${BOARD}/?new=1`)).toBe(true);
  });

  it('leaves base empty rather than inventing one', () => {
    expect(params(buildLink(draft({ base: undefined }), BOARD)).get('base')).toBe('');
  });
});

describe('link.mjs command line', () => {
  it('prints one url', () => {
    const r = runCli(draft(), { FACTORY_BOARD_URL: BOARD });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().startsWith(`${BOARD}/?new=1&title=`)).toBe(true);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('builds no link when FACTORY_BOARD_URL is not set', () => {
    for (const env of [{}, { FACTORY_BOARD_URL: '' }, { FACTORY_BOARD_URL: '  ' }]) {
      const r = runCli(draft(), env);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr.trim()).toBe('factory: no Board link (FACTORY_BOARD_URL is not set)');
    }
  });

  it('takes the board url from FACTORY_BOARD_URL', () => {
    const r = runCli(draft(), { FACTORY_BOARD_URL: 'https://other.test/' });
    expect(r.stdout.trim().startsWith('https://other.test/?new=1')).toBe(true);
  });

  it('exits 1 with the message for a malformed repo', () => {
    const r = runCli(draft({ repo: 'No pe' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('factory: unknown repo No pe');
    expect(r.stdout).toBe('');
  });

  it('exits 1 for base main', () => {
    const r = runCli(draft({ base: 'main' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('factory: the factory never targets main');
    expect(r.stdout).toBe('');
  });

  it('warns on stderr about a link longer than 8000 characters, but still prints it', () => {
    const long = runCli(draft({ description: 'é'.repeat(3000) }), { FACTORY_BOARD_URL: BOARD });
    expect(long.status).toBe(0);
    expect(long.stderr).toContain('long link; some browsers or proxies may refuse it');
    expect(long.stdout.trim().length).toBeGreaterThan(8000);
    expect(runCli(draft(), { FACTORY_BOARD_URL: BOARD }).stderr).toBe('');
  });

  it('exits 1 for a missing or unreadable draft file', () => {
    const r = spawnSync(process.execPath, [script, '/nonexistent/draft.json'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('factory:');
  });
});
