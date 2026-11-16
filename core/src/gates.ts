import { isProtected } from './branches.js';
import type { Approval, DocKind, Gate, RepoSettings, Settings } from './types.js';

/** Doc kind whose current version an approval at each gate must match (R1). */
export const GATE_DOC: Readonly<Record<Gate, DocKind>> = { spec: 'spec', plan: 'plan', pr: 'review' };

/** Repo settings override the factory's; gates merge per key. */
export function resolveSettings(factory: Settings, repo?: RepoSettings): Settings {
  if (!repo) return { ...factory, gates: { ...factory.gates } };
  const { gates, ...rest } = repo;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return { ...factory, ...defined, gates: { ...factory.gates, ...definedGates(gates) } };
}

function definedGates(g?: Partial<Record<Gate, boolean>>): Partial<Record<Gate, boolean>> {
  return Object.fromEntries(Object.entries(g ?? {}).filter(([, v]) => v !== undefined));
}

/** Task overrides win over the resolved settings. */
export function resolveGates(s: Settings, overrides: Partial<Record<Gate, boolean>>): Record<Gate, boolean> {
  return { ...s.gates, ...definedGates(overrides) };
}

/** Latest approval for the gate at the current doc version, or undefined. */
export function validApproval(approvals: Approval[], gate: Gate, currentDocVersion: number | undefined): Approval | undefined {
  if (currentDocVersion === undefined) return undefined;
  let best: Approval | undefined;
  for (const a of approvals) {
    if (a.gate !== gate || a.docVersion !== currentDocVersion) continue;
    if (!best || later(a.at, best.at)) best = a;
  }
  return best;
}

/** Merge automatically only when the PR gate is off and the base is not protected (in the factory's list). */
export function shouldMerge(baseBranch: string, prGateOn: boolean, protectedBranches?: readonly string[]): boolean {
  return !prGateOn && !isProtected(baseBranch, protectedBranches);
}

/** Compare ISO timestamps as dates; fall back to string order when unparsable. Ties go to the later entry. */
function later(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a >= b : x >= y;
}
