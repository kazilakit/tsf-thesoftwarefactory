import { describe, expect, test } from 'vitest';
import { decide, IllegalInputError, type Decision, type Input } from '../src/machine.js';
import { assertMove } from '../src/status.js';
import type { Approval, AgentStep, Gate, Task } from '../src/types.js';

const G: Record<Gate, boolean> = { spec: true, plan: false, pr: true };
const NOGATES: Record<Gate, boolean> = { spec: false, plan: false, pr: false };

function task(over: Partial<Task> = {}): Task {
  return {
    taskId: 'T-1', factoryId: 'blocks', title: 't', description: 'd', repo: 'os', baseBranch: 'dev',
    status: 'ready', stage: null, branch: null, prUrl: null, attempt: 0,
    blockedReason: null, question: null, answer: null, gateOverrides: {}, dependsOn: [],
    claimBy: null, claimUntil: null, costUsd: 0, version: 1, ...over,
  };
}
const done = (step: AgentStep, verdict?: 'pass' | 'fail' | 'approve' | 'changes', summary = 'sum'): Input =>
  ({ kind: 'agent', step, result: { status: 'done', summary, verdict } });
const approval = (gate: Gate, decision: 'approve' | 'changes', comment = 'c'): Approval =>
  ({ taskId: 'T-1', gate, docVersion: 1, decision, comment, at: '2026-01-01T00:00:00Z' });

// Every table row: [name, task, input, gates, expected]
type Row = [string, Task, Input, Record<Gate, boolean>, object];
const rows: Row[] = [
  ['ready claimed', task(), { kind: 'claimed' }, G, { status: 'spec', stage: 'spec' }],
  ['spec done gate on', task({ status: 'spec', stage: 'spec' }), done('spec'), G, { status: 'spec_review', stage: null }],
  ['spec done gate off', task({ status: 'spec', stage: 'spec' }), done('spec'), NOGATES, { status: 'plan', stage: 'plan' }],
  ['spec_review approve', task({ status: 'spec_review' }), { kind: 'approval', approval: approval('spec', 'approve') }, G, { status: 'plan', stage: 'plan' }],
  ['spec_review changes', task({ status: 'spec_review' }), { kind: 'approval', approval: approval('spec', 'changes', 'more') }, G, { status: 'spec', stage: 'spec', patch: { answer: 'more' } }],
  ['plan done gate on', task({ status: 'plan', stage: 'plan' }), done('plan'), { ...G, plan: true }, { status: 'plan_review', stage: null }],
  ['plan done gate off', task({ status: 'plan', stage: 'plan' }), done('plan'), G, { status: 'build', stage: 'build' }],
  ['plan_review approve', task({ status: 'plan_review' }), { kind: 'approval', approval: approval('plan', 'approve') }, G, { status: 'build', stage: 'build' }],
  ['plan_review changes', task({ status: 'plan_review' }), { kind: 'approval', approval: approval('plan', 'changes', 'redo') }, G, { status: 'plan', stage: 'plan', patch: { answer: 'redo' } }],
  ['build done', task({ status: 'build', stage: 'build' }), done('build'), G, { status: 'verify', stage: 'check' }],
  ['checks passed', task({ status: 'verify', stage: 'check' }), { kind: 'checks', passed: true, summary: 'ok' }, G, { status: 'verify', stage: 'verify' }],
  ['checks failed', task({ status: 'verify', stage: 'check' }), { kind: 'checks', passed: false, summary: 'bad' }, G, { status: 'build', stage: 'build', patch: { attempt: 1, answer: 'bad' } }],
  ['verify pass', task({ status: 'verify', stage: 'verify' }), done('verify', 'pass'), G, { status: 'review', stage: 'review' }],
  ['verify fail', task({ status: 'verify', stage: 'verify' }), done('verify', 'fail', 'nope'), G, { status: 'build', stage: 'build', patch: { attempt: 1, answer: 'nope' } }],
  ['review approve', task({ status: 'review', stage: 'review' }), done('review', 'approve'), G, { status: 'review', stage: 'ship' }],
  ['review changes', task({ status: 'review', stage: 'review' }), done('review', 'changes', 'fix x'), G, { status: 'build', stage: 'build', patch: { attempt: 1, answer: 'fix x' } }],
  ['ship merged', task({ status: 'review', stage: 'ship' }), { kind: 'shipped', prUrl: 'u', merged: true }, G, { status: 'done', stage: null, patch: { prUrl: 'u' } }],
  ['ship not merged', task({ status: 'review', stage: 'ship' }), { kind: 'shipped', prUrl: 'u', merged: false }, G, { status: 'pr_open', stage: null, patch: { prUrl: 'u' } }],
  ['pr_open changes', task({ status: 'pr_open' }), { kind: 'approval', approval: approval('pr', 'changes', 'tweak') }, G, { status: 'build', stage: 'build', patch: { attempt: 1, answer: 'tweak' } }],
  ['pr merged', task({ status: 'pr_open' }), { kind: 'pr', state: 'merged' }, G, { status: 'done', stage: null }],
  ['pr closed', task({ status: 'pr_open' }), { kind: 'pr', state: 'closed' }, G, { status: 'blocked', stage: 'build', patch: { blockedReason: 'PR closed without merge' } }],
  ['agent blocked w/ question', task({ status: 'build', stage: 'build' }), { kind: 'agent', step: 'build', result: { status: 'blocked', summary: 's', question: 'which?' } }, G, { status: 'blocked', stage: 'build', patch: { question: 'which?' } }],
  ['agent blocked w/o question', task({ status: 'plan', stage: 'plan' }), { kind: 'agent', step: 'plan', result: { status: 'blocked', summary: 's' } }, G, { status: 'blocked', stage: 'plan', patch: { question: 's' } }],
  ['agent failed verify', task({ status: 'verify', stage: 'verify' }), { kind: 'agent', step: 'verify', result: { status: 'failed', summary: 'crash' } }, G, { status: 'build', stage: 'build', patch: { attempt: 1, answer: 'crash' } }],
  ['agent failed review', task({ status: 'review', stage: 'review' }), { kind: 'agent', step: 'review', result: { status: 'failed', summary: 'crash' } }, G, { status: 'build', stage: 'build', patch: { attempt: 1, answer: 'crash' } }],
  ['agent failed spec', task({ status: 'spec', stage: 'spec' }), { kind: 'agent', step: 'spec', result: { status: 'failed', summary: 'boom' } }, G, { status: 'blocked', stage: 'spec', patch: { blockedReason: 'boom' } }],
  ['agent failed build', task({ status: 'build', stage: 'build' }), { kind: 'agent', step: 'build', result: { status: 'failed', summary: 'boom' } }, G, { status: 'blocked', stage: 'build', patch: { blockedReason: 'boom' } }],
  ['limit', task({ status: 'review', stage: 'ship' }), { kind: 'limit', reason: 'cost cap' }, G, { status: 'blocked', stage: 'ship', patch: { blockedReason: 'cost cap' } }],
  ['limit at pr_open', task({ status: 'pr_open' }), { kind: 'limit', reason: 'r' }, G, { status: 'blocked', stage: null, patch: { blockedReason: 'r' } }],
  ['answered at build keeps answer', task({ status: 'blocked', stage: 'build', attempt: 2, question: 'q', blockedReason: 'r', answer: 'a' }), { kind: 'answered' }, G, { status: 'build', stage: 'build', patch: { attempt: 0, question: null, blockedReason: null, answer: 'a' } }],
  ['answered at spec keeps answer', task({ status: 'blocked', stage: 'spec', answer: 'a' }), { kind: 'answered' }, G, { status: 'spec', stage: 'spec', patch: { answer: 'a' } }],
  ['answered at plan keeps answer', task({ status: 'blocked', stage: 'plan', answer: 'a' }), { kind: 'answered' }, G, { status: 'plan', stage: 'plan', patch: { answer: 'a' } }],
  ['answered at check', task({ status: 'blocked', stage: 'check', answer: 'a' }), { kind: 'answered' }, G, { status: 'verify', stage: 'check', patch: { answer: null } }],
  ['answered at review keeps answer', task({ status: 'blocked', stage: 'review', answer: 'a' }), { kind: 'answered' }, G, { status: 'review', stage: 'review', patch: { answer: 'a' } }],
  ['answered at verify keeps answer', task({ status: 'blocked', stage: 'verify', answer: 'a' }), { kind: 'answered' }, G, { status: 'verify', stage: 'verify', patch: { answer: 'a' } }],
  ['restart', task({ status: 'blocked', stage: null, attempt: 2, question: 'q', blockedReason: 'r', answer: 'a' }), { kind: 'restart' }, G, { status: 'ready', stage: null, reason: 'restarted from ready', patch: { attempt: 0, question: null, blockedReason: null, answer: null } }],
  ['answered at ship', task({ status: 'blocked', stage: 'ship', answer: 'a' }), { kind: 'answered' }, G, { status: 'review', stage: 'ship', patch: { answer: null } }],
];

// Forward moves clear the feedback the previous step consumed, so it never reaches the next agent.
const stale = { answer: 'old feedback' };
const forwardRows: [string, Task, Input, Record<Gate, boolean>][] = [
  ['spec done gate on', task({ status: 'spec', stage: 'spec', ...stale }), done('spec'), G],
  ['spec done gate off', task({ status: 'spec', stage: 'spec', ...stale }), done('spec'), NOGATES],
  ['plan done gate on', task({ status: 'plan', stage: 'plan', ...stale }), done('plan'), { ...G, plan: true }],
  ['plan done gate off', task({ status: 'plan', stage: 'plan', ...stale }), done('plan'), G],
  ['build done', task({ status: 'build', stage: 'build', ...stale }), done('build'), G],
  ['verify pass', task({ status: 'verify', stage: 'verify', ...stale }), done('verify', 'pass'), G],
  ['review approve', task({ status: 'review', stage: 'review', ...stale }), done('review', 'approve'), G],
  ['spec approved', task({ status: 'spec_review', ...stale }), { kind: 'approval', approval: approval('spec', 'approve') }, G],
  ['plan approved', task({ status: 'plan_review', ...stale }), { kind: 'approval', approval: approval('plan', 'approve') }, G],
  ['checks passed', task({ status: 'verify', stage: 'check', ...stale }), { kind: 'checks', passed: true, summary: 'ok' }, G],
  ['shipped open', task({ status: 'review', stage: 'ship', ...stale }), { kind: 'shipped', prUrl: 'u', merged: false }, G],
  ['shipped merged', task({ status: 'review', stage: 'ship', ...stale }), { kind: 'shipped', prUrl: 'u', merged: true }, G],
  ['pr merged', task({ status: 'pr_open', ...stale }), { kind: 'pr', state: 'merged' }, G],
];

describe('decide', () => {
  test.each(rows)('row: %s', (_n, t, input, gates, expected) => {
    expect(decide(t, input, gates)).toMatchObject(expected);
  });

  test('every row result is a legal core move when status changes', () => {
    for (const [, t, input, gates] of rows) {
      const d: Decision = decide(t, input, gates);
      if (d.status !== t.status) expect(() => assertMove(t.status, d.status, 'core')).not.toThrow();
    }
  });

  test.each(forwardRows)('forward move clears the answer: %s', (_n, t, input, gates) => {
    expect(decide(t, input, gates).patch).toHaveProperty('answer', null);
  });

  test('every decision carries a reason', () => {
    for (const [, t, input, gates] of rows) expect(decide(t, input, gates).reason).not.toBe('');
  });

  test('spec done goes to review only when the spec gate is on', () => {
    const t = task({ status: 'spec', stage: 'spec' });
    expect(decide(t, done('spec'), { spec: true, plan: false, pr: true })).toMatchObject({ status: 'spec_review', stage: null });
    expect(decide(t, done('spec'), { spec: false, plan: false, pr: true })).toMatchObject({ status: 'plan', stage: 'plan' });
  });

  test('third return to build blocks', () => {
    const t = task({ status: 'verify', stage: 'check', attempt: 2 });
    expect(decide(t, { kind: 'checks', passed: false, summary: 'dotnet test: 2 failed' }, G))
      .toMatchObject({ status: 'blocked', stage: 'build', patch: { attempt: 3, blockedReason: 'returned to build 3 times', question: 'dotnet test: 2 failed' } });
    expect(decide(task({ status: 'verify', stage: 'check', attempt: 1 }), { kind: 'checks', passed: false, summary: 's' }, G))
      .toMatchObject({ status: 'build', stage: 'build', patch: { attempt: 2, answer: 's' } });
  });

  test('blocked by third return resumes at build with attempt reset', () => {
    const t = task({ status: 'verify', stage: 'check', attempt: 2 });
    const b = decide(t, { kind: 'checks', passed: false, summary: 'x' }, G);
    const blocked = task({ status: 'blocked', stage: b.stage, ...b.patch });
    expect(decide(blocked, { kind: 'answered' }, G)).toMatchObject({ status: 'build', stage: 'build', patch: { attempt: 0 } });
  });

  test('answered blocked task resumes where it stopped with attempt reset, keeping the answer as feedback', () => {
    const t = task({ status: 'blocked', stage: 'verify', attempt: 3, question: 'q', blockedReason: 'r', answer: 'use the v2 API' });
    expect(decide(t, { kind: 'answered' }, G)).toMatchObject({ status: 'verify', stage: 'verify', patch: { attempt: 0, question: null, blockedReason: null, answer: 'use the v2 API' } });
  });

  test('restart moves a stage-less blocked task to ready and clears the block', () => {
    const t = task({ status: 'blocked', stage: null, attempt: 3, question: 'q', blockedReason: 'r', answer: 'unblocked by x' });
    const d = decide(t, { kind: 'restart' }, G);
    expect(d).toEqual({ status: 'ready', stage: null, reason: 'restarted from ready', patch: { attempt: 0, question: null, blockedReason: null, answer: null } });
  });

  test('restart with a stage is illegal', () => {
    expect(() => decide(task({ status: 'blocked', stage: 'build' }), { kind: 'restart' }, G)).toThrow(IllegalInputError);
    expect(() => decide(task({ status: 'build', stage: null }), { kind: 'restart' }, G)).toThrow(IllegalInputError);
  });

  test('agent failure at spec blocks, at review returns to build', () => {
    const f = (step: AgentStep): Input => ({ kind: 'agent', step, result: { status: 'failed', summary: 'x' } });
    expect(decide(task({ status: 'spec', stage: 'spec' }), f('spec'), G)).toMatchObject({ status: 'blocked' });
    expect(decide(task({ status: 'review', stage: 'review' }), f('review'), G)).toMatchObject({ status: 'build' });
  });

  test('input that does not fit the status throws', () => {
    expect(() => decide(task({ status: 'spec', stage: 'spec' }), { kind: 'checks', passed: true, summary: '' }, G)).toThrow(IllegalInputError);
  });

  test.each<[string, Task, Input]>([
    ['claimed on spec', task({ status: 'spec', stage: 'spec' }), { kind: 'claimed' }],
    ['answered when not blocked', task({ status: 'build', stage: 'build' }), { kind: 'answered' }],
    ['agent step mismatching stage', task({ status: 'build', stage: 'build' }), done('spec')],
    ['verify done without verdict', task({ status: 'verify', stage: 'verify' }), done('verify')],
    ['review done with pass verdict', task({ status: 'review', stage: 'review' }), done('review', 'pass')],
    ['approval for wrong gate', task({ status: 'spec_review' }), { kind: 'approval', approval: approval('plan', 'approve') }],
    ['approve at pr_open', task({ status: 'pr_open' }), { kind: 'approval', approval: approval('pr', 'approve') }],
    ['limit on done', task({ status: 'done' }), { kind: 'limit', reason: 'r' }],
    ['limit on cancelled', task({ status: 'cancelled' }), { kind: 'limit', reason: 'r' }],
    ['agent blocked on done', task({ status: 'done' }), { kind: 'agent', step: 'build', result: { status: 'blocked', summary: 's' } }],
    ['shipped before ship stage', task({ status: 'review', stage: 'review' }), { kind: 'shipped', prUrl: 'u', merged: true }],
    ['pr on non pr_open', task({ status: 'build', stage: 'build' }), { kind: 'pr', state: 'merged' }],
    ['checks at verify stage', task({ status: 'verify', stage: 'verify' }), { kind: 'checks', passed: true, summary: '' }],
  ])('illegal: %s', (_n, t, input) => {
    expect(() => decide(t, input, G)).toThrow(IllegalInputError);
  });
});
