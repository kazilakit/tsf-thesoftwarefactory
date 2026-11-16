import type { AgentStep, Settings } from './types.js';

export const DEFAULT_SETTINGS: Settings = {
  gates: { spec: true, plan: false, pr: true },
  maxParallel: 2,
  // Provisional until spec §12.2.
  maxTurnsPerStage: 60,
  maxCostPerTaskUsd: 5,
  paused: false,
};

/** A claim lasts 10 minutes. */
export const CLAIM_MS = 600_000;
/** The third return to build blocks the task. */
export const MAX_RETURNS = 3;

export const AGENT_FOR: Record<AgentStep, string> = {
  spec: 'spec-writer',
  plan: 'planner',
  build: 'implementer',
  verify: 'verifier',
  review: 'reviewer',
};
