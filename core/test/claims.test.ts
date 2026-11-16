import { describe, expect, test } from 'vitest';
import { claim, claimExpired, release, renew } from '../src/claims.js';
import { MemoryStore } from '../src/store.js';

const NOW = new Date('2026-01-01T00:00:00Z');
const setup = async () => {
  const s = new MemoryStore();
  const t = await s.createTask({ factoryId: 'blocks', title: 'a', description: '', repo: 'data' });
  return { s, t };
};

describe('claims', () => {
  test('two claimers on the same version: one wins, one gets null', async () => {
    const { s, t } = await setup();
    const [a, b] = await Promise.all([claim(s, t, 'sdk:A', NOW), claim(s, t, 'sdk:B', NOW)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
  test('held claim blocks others until it expires after 10 minutes', async () => {
    const { s, t } = await setup();
    const held = (await claim(s, t, 'sdk:A', NOW))!;
    expect(await claim(s, held, 'sdk:B', new Date(NOW.getTime() + 599_000))).toBeNull();
    expect((await claim(s, held, 'sdk:B', new Date(NOW.getTime() + 600_001)))?.claimBy).toBe('sdk:B');
  });
  test('claimant can re-claim its own unexpired claim', async () => {
    const { s, t } = await setup();
    const held = (await claim(s, t, 'sdk:A', NOW))!;
    expect((await claim(s, held, 'sdk:A', new Date(NOW.getTime() + 1000)))?.claimBy).toBe('sdk:A');
  });
  test('claimExpired', async () => {
    const { s, t } = await setup();
    expect(claimExpired(t, NOW)).toBe(true);
    const held = (await claim(s, t, 'sdk:A', NOW))!;
    expect(claimExpired(held, NOW)).toBe(false);
    expect(claimExpired(held, new Date(NOW.getTime() + 600_000))).toBe(true);
  });
  test('renew extends only your own claim', async () => {
    const { s, t } = await setup();
    const held = (await claim(s, t, 'sdk:A', NOW))!;
    expect((await renew(s, held, 'sdk:A', new Date(NOW.getTime() + 60_000)))?.claimUntil).toBe(new Date(NOW.getTime() + 660_000).toISOString());
    expect(await renew(s, held, 'sdk:B', NOW)).toBeNull();
  });
  test('release clears the claim', async () => {
    const { s, t } = await setup();
    const held = (await claim(s, t, 'sdk:A', NOW))!;
    const r = await release(s, held);
    expect(r).toMatchObject({ claimBy: null, claimUntil: null });
  });
});
