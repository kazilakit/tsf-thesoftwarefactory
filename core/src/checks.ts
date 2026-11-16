import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Checks } from './checksSchema.js';

export type Exec = (cmd: string, cwd: string) => Promise<{ code: number; output: string }>;

export interface CheckStep {
  name: string;
  command: string;
  exitCode: number | null;
  output: string;
}

export interface CheckReport {
  passed: boolean;
  steps: CheckStep[];
}

const OUTPUT_LIMIT = 4000;

// Commands come from the repo's definition in the owner's factory.yaml, which only the owner writes, so a
// shell is intended. Each step's cwd is validated to stay inside the worktree (ChecksSchema).
export const shellExec: Exec = (cmd, cwd) =>
  new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(cmd, { cwd, shell: true });
    } catch (e) {
      resolve({ code: 127, output: e instanceof Error ? e.message : String(e) });
      return;
    }
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', (err) => resolve({ code: 127, output: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });

export async function runChecks(cfg: { checks: Checks }, worktree: string, exec: Exec = shellExec): Promise<CheckReport> {
  const steps: CheckStep[] = [];
  const passed = new Set<string>();
  for (const c of cfg.checks) {
    if (c.needs !== undefined && !passed.has(c.needs)) {
      steps.push({ name: c.name, command: c.run, exitCode: null, output: '' });
      continue;
    }
    const r = await exec(c.run, join(worktree, c.cwd));
    steps.push({ name: c.name, command: c.run, exitCode: r.code, output: r.output.slice(-OUTPUT_LIMIT) });
    if (r.code === 0) passed.add(c.name);
  }
  return { passed: steps.every((s) => s.exitCode === 0), steps };
}

export function formatReport(r: CheckReport): string {
  const lines = r.steps.map((s) =>
    s.exitCode === null ? `- ⏭ ${s.name} (skipped)` : s.exitCode === 0 ? `- ✅ ${s.name}` : `- ❌ ${s.name} (exit ${s.exitCode})`,
  );
  return [`## Checks: ${r.passed ? 'passed' : 'failed'}`, '', ...lines].join('\n');
}
