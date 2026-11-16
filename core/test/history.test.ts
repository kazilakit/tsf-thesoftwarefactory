import { expect, test } from 'vitest';
import { diffEvents } from '../src/history.js';
import { MemoryStore } from '../src/store.js';

const base = async () => new MemoryStore().createTask({ factoryId: 'blocks', title: 'a', description: '', repo: 'data' });

test('status move and stage set give two events', async () => {
  const before = { ...(await base()), status: 'build' as const, stage: 'build' as const };
  const after = { ...before, status: 'verify' as const, stage: 'check' as const, version: 2 };
  const ev = diffEvents(before, after, 'me', 'why', 'T0');
  expect(ev).toHaveLength(2);
  expect(ev).toContainEqual({ taskId: 'T-1', factoryId: 'blocks', actor: 'me', action: 'move', field: 'status', from: 'build', to: 'verify', reason: 'why', at: 'T0' });
  expect(ev).toContainEqual(expect.objectContaining({ action: 'set', field: 'stage', from: 'build', to: 'check' }));
});

test('version and claimUntil changes give no events', async () => {
  const before = await base();
  expect(diffEvents(before, { ...before, version: 5, claimUntil: 'x' }, 'me', '', 'T0')).toEqual([]);
});
