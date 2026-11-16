import { z } from 'zod';
import type { AgentResult, AgentStep } from './types.js';

const nonNegative = z.number().nonnegative();

const AgentResultSchema = z.object({
  status: z.enum(['done', 'blocked', 'failed']),
  summary: z.string(),
  question: z.string().optional(),
  verdict: z.enum(['pass', 'fail', 'approve', 'changes']).optional(),
  doc: z.string().optional(),
  turns: nonNegative.optional(),
  costUsd: nonNegative.optional(),
});

const VERDICTS: Partial<Record<AgentStep, readonly string[]>> = {
  verify: ['pass', 'fail'],
  review: ['approve', 'changes'],
};
const DOC_STEPS: readonly AgentStep[] = ['spec', 'plan', 'verify', 'review'];

function invalid(reason: string): AgentResult {
  return { status: 'failed', summary: `invalid agent result: ${reason}` };
}

/** Parses an agent's JSON result file. Never throws; bad input becomes a `failed` result. */
export function parseAgentResult(raw: string | undefined, step: AgentStep): AgentResult {
  if (raw === undefined || raw.trim() === '') return invalid('result file missing or empty');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return invalid('not valid JSON');
  }
  const parsed = AgentResultSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') || 'result';
    return invalid(`${path}: ${issue?.message ?? 'does not match schema'}`);
  }
  const result: AgentResult = parsed.data;
  if (result.status === 'done') {
    if (DOC_STEPS.includes(step) && result.doc === undefined) return invalid(`done ${step} result needs a doc`);
    const allowed = VERDICTS[step];
    if (allowed && (result.verdict === undefined || !allowed.includes(result.verdict))) {
      return invalid(`done ${step} result needs a verdict of ${allowed.join('|')}`);
    }
  }
  return result;
}
