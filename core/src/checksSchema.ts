import { z } from 'zod';
import type { Validated } from './validated.js';

// Pure (no Node API): validates repo check definitions.
const cmd = z.string().min(1, 'must not be empty');
/** A folder inside the worktree: relative, with no `..` segment (the core joins it to the worktree). */
const cwd = z
  .string()
  .min(1)
  .refine((v) => !/^([\\/]|[A-Za-z]:)/.test(v) && !v.split(/[\\/]/).includes('..'), { message: 'must be a folder inside the repo (relative, no ..)' });

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export interface Check {
  name: string;
  cwd: string;
  run: string;
  /** The name of an earlier check; this one is skipped when that did not pass. */
  needs?: string;
}
export type Checks = Check[];

const checkSchema = z.object({
  name: z.string().regex(NAME_PATTERN, { message: `must match ${NAME_PATTERN.source}` }),
  cwd: cwd.default('.'),
  run: cmd,
  needs: z.string().min(1).optional(),
});

/** The shape before the list: kept so old files and Board rows still load. */
const oldSchema = z.object({
  server: z.object({ cwd, build: cmd, test: cmd }),
  client: z.object({ cwd, install: cmd, typecheck: cmd, lint: cmd, test: cmd }),
  e2e: z.literal('off'),
});

/** `server.build`, then `server.test`, `client.install`, then the three client checks, each needing what it needs today. */
function toList(o: z.infer<typeof oldSchema>): Check[] {
  const { server, client } = o;
  return [
    { name: 'server.build', cwd: server.cwd, run: server.build },
    { name: 'server.test', cwd: server.cwd, run: server.test, needs: 'server.build' },
    { name: 'client.install', cwd: client.cwd, run: client.install },
    { name: 'client.typecheck', cwd: client.cwd, run: client.typecheck, needs: 'client.install' },
    { name: 'client.lint', cwd: client.cwd, run: client.lint, needs: 'client.install' },
    { name: 'client.test', cwd: client.cwd, run: client.test, needs: 'client.install' },
  ];
}

/** Names are unique and `needs` points at an earlier check. */
function refineList(list: Check[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  list.forEach((c, i) => {
    if (seen.has(c.name)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `duplicate check name ${c.name}` });
    if (c.needs !== undefined && !seen.has(c.needs)) ctx.addIssue({ code: 'custom', path: [i, 'needs'], message: `${c.needs} is not an earlier check` });
    seen.add(c.name);
  });
}

const listSchema = z.array(checkSchema).superRefine(refineList);
const oldList = oldSchema.transform(toList).superRefine(refineList);
/** Input is the list or the old `{ server, client, e2e }` shape; output is always the list. A failure carries normaliseChecks's message. */
export const ChecksSchema = z.unknown().transform((raw, ctx): Check[] => {
  const r = normaliseChecks(raw);
  if (r.ok) return r.value;
  ctx.addIssue({ code: 'custom', message: r.error });
  return z.NEVER;
});

/** The same rules as plain errors: `checks.1.needs: build is not an earlier check`. */
export function normaliseChecks(raw: unknown): Validated<Check[]> {
  if (raw === undefined || raw === null) return { ok: false, error: 'checks is required' };
  const schema = Array.isArray(raw) ? listSchema : typeof raw === 'object' ? oldList : null;
  if (!schema) return { ok: false, error: 'checks must be a list' };
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0]!;
  const path = ['checks', ...issue.path].join('.');
  return { ok: false, error: `${path}${issue.code === 'invalid_type' && issue.input === undefined ? ' is required' : `: ${issue.message}`}` };
}
