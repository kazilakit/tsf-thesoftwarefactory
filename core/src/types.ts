/** A repo id, unique within its factory (`^[a-z][a-z0-9-]*$`, at most 40 characters). */
export type RepoId = string;
export type FactoryId = string;
export type Status =
  | 'inbox' | 'ready' | 'spec' | 'spec_review' | 'plan' | 'plan_review' | 'build'
  | 'verify' | 'review' | 'pr_open' | 'done' | 'blocked' | 'cancelled';
export type Step = 'spec' | 'plan' | 'build' | 'check' | 'verify' | 'review' | 'ship';
export type AgentStep = 'spec' | 'plan' | 'build' | 'verify' | 'review';
export type Gate = 'spec' | 'plan' | 'pr';
export type DocKind = 'spec' | 'plan' | 'verify' | 'review';
export type Mode = 'sdk' | 'loop' | 'session';

export interface Task {
  taskId: string;
  factoryId: FactoryId;
  title: string;
  description: string;
  repo: RepoId;
  baseBranch: string;
  status: Status;
  stage: Step | null;
  branch: string | null;
  prUrl: string | null;
  attempt: number;
  blockedReason: string | null;
  question: string | null;
  answer: string | null;
  gateOverrides: Partial<Record<Gate, boolean>>;
  /** Ids of the tasks this one waits for. */
  dependsOn: string[];
  claimBy: string | null;
  /** ISO timestamp */
  claimUntil: string | null;
  costUsd: number;
  version: number;
}

export interface Doc {
  taskId: string;
  kind: DocKind;
  version: number;
  body: string;
  author: string;
  status: 'current' | 'superseded';
}

export interface Approval {
  taskId: string;
  gate: Gate;
  docVersion: number;
  decision: 'approve' | 'changes';
  comment: string;
  at: string;
}

export interface Settings {
  gates: Record<Gate, boolean>;
  maxParallel: number;
  maxTurnsPerStage: number;
  maxCostPerTaskUsd: number;
  paused: boolean;
}

export type RepoSettings = Partial<Omit<Settings, 'gates'>> & { gates?: Partial<Record<Gate, boolean>> };

export interface Run {
  runId: string;
  taskId: string;
  step: Step;
  mode: Mode;
  agent: string;
  startedAt: string;
  endedAt: string | null;
  result: string | null;
  turns: number | null;
  costUsd: number | null;
}

export interface FactoryEvent {
  taskId: string;
  /** '' when the event belongs to no factory. */
  factoryId: string;
  actor: string;
  action: 'move' | 'set' | 'create';
  field: string | null;
  from: string | null;
  to: string | null;
  reason: string;
  at: string;
}

export interface AgentResult {
  status: 'done' | 'blocked' | 'failed';
  summary: string;
  question?: string;
  verdict?: 'pass' | 'fail' | 'approve' | 'changes';
  doc?: string;
  turns?: number;
  costUsd?: number;
}
