import { expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { GATE_DOC, resolveGates, resolveSettings, shouldMerge, validApproval } from '../src/gates.js';
import { isProtected } from '../src/branchGuard.js';

test('most specific gate wins', () => {
  const s = resolveSettings(DEFAULT_SETTINGS, { gates: { spec: false } });
  expect(resolveGates(s, {})).toEqual({ spec: false, plan: false, pr: true });
  expect(resolveGates(s, { spec: true, plan: true })).toEqual({ spec: true, plan: true, pr: true });
  expect(resolveSettings(DEFAULT_SETTINGS, { maxParallel: 1 }).maxParallel).toBe(1);
});

test('approval for an older doc version does not count', () => {
  const a = (v: number, d: 'approve' | 'changes', at: string) => ({ taskId: 'T-1', gate: 'spec' as const, docVersion: v, decision: d, comment: '', at });
  expect(validApproval([a(1, 'approve', '2026-11-09T10:00Z')], 'spec', 2)).toBeUndefined();
  expect(validApproval([a(2, 'changes', '2026-11-09T10:00Z'), a(2, 'approve', '2026-11-09T11:00Z')], 'spec', 2)?.decision).toBe('approve');
  expect(validApproval([a(1, 'approve', 'x')], 'plan', 1)).toBeUndefined();
  expect(validApproval([], 'spec', undefined)).toBeUndefined();
});

test('PR gate off never merges into a protected branch', () => {
  expect(shouldMerge('dev', false)).toBe(false);
  expect(shouldMerge('stg', false)).toBe(false);
  expect(shouldMerge('main', false)).toBe(false);
  expect(shouldMerge('feature/x', false)).toBe(true);
  expect(shouldMerge('feature/x', true)).toBe(false);
  expect(shouldMerge('dev', false, ['rel', 'main'])).toBe(true);
  expect(shouldMerge('rel', false, ['rel', 'main'])).toBe(false);
  expect(shouldMerge('main', false, [])).toBe(false);
});

test('isProtected strips refs/heads/ and origin/', () => {
  expect(isProtected('refs/heads/main')).toBe(true);
  expect(isProtected('origin/dev')).toBe(true);
  expect(isProtected('stg')).toBe(true);
  expect(isProtected('main2')).toBe(false);
  expect(isProtected('feature/main')).toBe(false);
});

test('GATE_DOC: the doc kind each gate approves (R1)', () => {
  expect(GATE_DOC).toEqual({ spec: 'spec', plan: 'plan', pr: 'review' });
});
