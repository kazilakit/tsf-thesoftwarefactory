import type { Status, Step } from './types.js';

export type Mover = 'you' | 'core';

export class IllegalMoveError extends Error {
  constructor(
    public readonly from: Status,
    public readonly to: Status,
    public readonly by: Mover,
  ) {
    super(`Illegal move ${from} -> ${to} by ${by}`);
    this.name = 'IllegalMoveError';
  }
}

export const TERMINAL: ReadonlySet<Status> = new Set<Status>(['done', 'cancelled']);

export const ALL_STATUSES: readonly Status[] = [
  'inbox', 'ready', 'spec', 'spec_review', 'plan', 'plan_review', 'build',
  'verify', 'review', 'pr_open', 'done', 'blocked', 'cancelled',
];
const NON_TERMINAL = ALL_STATUSES.filter((s) => !TERMINAL.has(s));

const CORE_PAIRS: ReadonlyArray<readonly [Status, Status]> = [
  ['ready', 'spec'],
  ['spec', 'spec_review'], ['spec', 'plan'],
  ['spec_review', 'plan'], ['spec_review', 'spec'],
  ['plan', 'plan_review'], ['plan', 'build'],
  ['plan_review', 'build'], ['plan_review', 'plan'],
  ['build', 'verify'],
  ['verify', 'review'], ['verify', 'build'],
  ['review', 'pr_open'], ['review', 'build'], ['review', 'done'],
  ['pr_open', 'done'], ['pr_open', 'build'],
  // blocked can be entered from any non-terminal status ...
  ...NON_TERMINAL.filter((s) => s !== 'blocked').map((s): [Status, Status] => [s, 'blocked']),
  // ... and resumed into any working step.
  ['blocked', 'spec'], ['blocked', 'plan'], ['blocked', 'build'], ['blocked', 'verify'], ['blocked', 'review'],
  // ... or, with no stage to resume at (GitHub-only restart), started again from ready.
  ['blocked', 'ready'],
];

const YOU_PAIRS: ReadonlyArray<readonly [Status, Status]> = [
  ['inbox', 'ready'],
  ...NON_TERMINAL.map((s): [Status, Status] => [s, 'cancelled']),
];

const key = (f: Status, t: Status) => `${f}>${t}`;
const CORE_MOVES = new Set(CORE_PAIRS.map(([f, t]) => key(f, t)));
const YOU_MOVES = new Set(YOU_PAIRS.map(([f, t]) => key(f, t)));

export function canMove(from: Status, to: Status, by: Mover): boolean {
  return (by === 'core' ? CORE_MOVES : YOU_MOVES).has(key(from, to));
}

export function assertMove(from: Status, to: Status, by: Mover): void {
  if (!canMove(from, to, by)) throw new IllegalMoveError(from, to, by);
}

export const STEP_STATUS: Record<Step, Status> = {
  spec: 'spec',
  plan: 'plan',
  build: 'build',
  check: 'verify',
  verify: 'verify',
  review: 'review',
  ship: 'review',
};
