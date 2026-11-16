import { MAX_RETURNS } from './defaults.js';
import { STEP_STATUS, TERMINAL } from './status.js';
import type { AgentResult, AgentStep, Approval, Gate, Status, Step, Task } from './types.js';

export type Input =
  | { kind: 'claimed' }
  | { kind: 'agent'; step: AgentStep; result: AgentResult }
  | { kind: 'checks'; passed: boolean; summary: string }
  | { kind: 'approval'; approval: Approval }
  | { kind: 'shipped'; prUrl: string; merged: boolean }
  | { kind: 'pr'; state: 'merged' | 'closed' }
  | { kind: 'answered' }
  | { kind: 'restart' }
  | { kind: 'limit'; reason: string };

export interface Decision {
  status: Status;
  stage: Step | null;
  /** Fields that change besides status and stage. */
  patch: Partial<Task>;
  reason: string;
}

export class IllegalInputError extends Error {
  constructor(task: Pick<Task, 'status' | 'stage'>, detail: string) {
    super(`Illegal input for ${task.status}/${task.stage ?? '-'}: ${detail}`);
    this.name = 'IllegalInputError';
  }
}

/** Agent steps: the answer is fed back to the agent, so it survives an `answered` resume. */
const KEEPS_ANSWER: ReadonlySet<Step> = new Set<Step>(['spec', 'plan', 'build', 'verify', 'review']);

const go = (status: Status, stage: Step | null, reason: string, patch: Partial<Task> = {}): Decision =>
  ({ status, stage, patch, reason });

/** A forward move: the feedback the finished step consumed must not reach the next one. */
const forward = (status: Status, stage: Step | null, reason: string, patch: Partial<Task> = {}): Decision =>
  go(status, stage, reason, { ...patch, answer: null });

function returnToBuild(task: Task, feedback: string): Decision {
  const attempt = task.attempt + 1;
  if (attempt >= MAX_RETURNS) {
    return go('blocked', 'build', `returned to build ${attempt} times`, {
      attempt, blockedReason: `returned to build ${MAX_RETURNS} times`, question: feedback,
    });
  }
  return go('build', 'build', 'returned to build', { attempt, answer: feedback });
}

function gateApproval(task: Task, gate: Gate, a: Approval): Approval['decision'] {
  if (a.gate !== gate) throw new IllegalInputError(task, `approval for gate ${a.gate}, waiting on ${gate}`);
  return a.decision;
}

function agentDone(task: Task, step: AgentStep, r: AgentResult, gates: Record<Gate, boolean>): Decision {
  if (task.stage !== step || STEP_STATUS[step] !== task.status) {
    throw new IllegalInputError(task, `agent step ${step} does not match`);
  }
  switch (step) {
    case 'spec':
      return gates.spec ? forward('spec_review', null, 'spec written, awaiting review') : forward('plan', 'plan', 'spec written');
    case 'plan':
      return gates.plan ? forward('plan_review', null, 'plan written, awaiting review') : forward('build', 'build', 'plan written');
    case 'build':
      return forward('verify', 'check', 'build done');
    case 'verify':
      if (r.verdict === 'pass') return forward('review', 'review', 'verify passed');
      if (r.verdict === 'fail') return returnToBuild(task, r.summary);
      throw new IllegalInputError(task, 'verify result needs a pass or fail verdict');
    case 'review':
      if (r.verdict === 'approve') return forward('review', 'ship', 'review approved');
      if (r.verdict === 'changes') return returnToBuild(task, r.summary);
      throw new IllegalInputError(task, 'review result needs an approve or changes verdict');
  }
}

function agentInput(task: Task, step: AgentStep, r: AgentResult, gates: Record<Gate, boolean>): Decision {
  if (TERMINAL.has(task.status) || task.status === 'blocked') {
    throw new IllegalInputError(task, `agent ${r.status} on a ${task.status} task`);
  }
  if (r.status === 'blocked') {
    return go('blocked', task.stage, 'agent blocked', { question: r.question ?? r.summary });
  }
  if (r.status === 'failed') {
    if (task.stage !== step || STEP_STATUS[step] !== task.status) {
      throw new IllegalInputError(task, `agent step ${step} does not match`);
    }
    if (step === 'verify' || step === 'review') return returnToBuild(task, r.summary);
    return go('blocked', task.stage, 'agent failed', { blockedReason: r.summary });
  }
  return agentDone(task, step, r, gates);
}

export function decide(task: Task, input: Input, gates: Record<Gate, boolean>): Decision {
  switch (input.kind) {
    case 'claimed':
      if (task.status !== 'ready') throw new IllegalInputError(task, 'claimed');
      return go('spec', 'spec', 'claimed');

    case 'agent':
      return agentInput(task, input.step, input.result, gates);

    case 'checks':
      if (task.status !== 'verify' || task.stage !== 'check') throw new IllegalInputError(task, 'checks');
      return input.passed ? forward('verify', 'verify', 'checks passed') : returnToBuild(task, input.summary);

    case 'approval': {
      const a = input.approval;
      switch (task.status) {
        case 'spec_review':
          return gateApproval(task, 'spec', a) === 'approve'
            ? forward('plan', 'plan', 'spec approved')
            : go('spec', 'spec', 'spec changes requested', { answer: a.comment });
        case 'plan_review':
          return gateApproval(task, 'plan', a) === 'approve'
            ? forward('build', 'build', 'plan approved')
            : go('plan', 'plan', 'plan changes requested', { answer: a.comment });
        case 'pr_open':
          if (gateApproval(task, 'pr', a) === 'changes') return returnToBuild(task, a.comment);
          throw new IllegalInputError(task, 'approve at pr_open (waiting for the PR to merge)');
        default:
          throw new IllegalInputError(task, 'approval');
      }
    }

    case 'shipped':
      if (task.status !== 'review' || task.stage !== 'ship') throw new IllegalInputError(task, 'shipped');
      return input.merged
        ? forward('done', null, 'PR merged', { prUrl: input.prUrl })
        : forward('pr_open', null, 'PR opened', { prUrl: input.prUrl });

    case 'pr':
      if (task.status !== 'pr_open') throw new IllegalInputError(task, 'pr');
      return input.state === 'merged'
        ? forward('done', null, 'PR merged')
        : go('blocked', 'build', 'PR closed without merge', { blockedReason: 'PR closed without merge' });

    case 'limit':
      if (TERMINAL.has(task.status) || task.status === 'blocked') {
        throw new IllegalInputError(task, `limit on a ${task.status} task`);
      }
      return go('blocked', task.stage, 'limit reached', { blockedReason: input.reason });

    case 'restart':
      if (task.status !== 'blocked' || task.stage !== null) throw new IllegalInputError(task, 'restart');
      return go('ready', null, 'restarted from ready', { attempt: 0, question: null, blockedReason: null, answer: null });

    case 'answered': {
      if (task.status !== 'blocked' || task.stage === null) throw new IllegalInputError(task, 'answered');
      const stage = task.stage;
      return go(STEP_STATUS[stage], stage, 'question answered', {
        attempt: 0,
        question: null,
        blockedReason: null,
        answer: KEEPS_ANSWER.has(stage) ? task.answer : null,
      });
    }
  }
}
