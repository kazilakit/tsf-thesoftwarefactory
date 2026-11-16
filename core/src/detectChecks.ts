import type { Check } from './checksSchema.js';

// Pure (no Node API): the wizard and the Board may use it.
const SCRIPTS = ['typecheck', 'lint', 'test', 'build'];

interface Pm { install: string; run: (s: string) => string }
function packageManager(has: (f: string) => boolean): Pm {
  if (has('package-lock.json')) return { install: 'npm ci', run: (s) => `npm run ${s}` };
  if (has('pnpm-lock.yaml')) return { install: 'pnpm i --frozen-lockfile', run: (s) => `pnpm run ${s}` };
  if (has('yarn.lock')) return { install: 'yarn --frozen-lockfile', run: (s) => `yarn ${s}` };
  return { install: 'npm install', run: (s) => `npm run ${s}` };
}

function scriptsOf(text: string | null): string[] {
  try {
    const s = (JSON.parse(text ?? '') as { scripts?: Record<string, unknown> }).scripts;
    return s && typeof s === 'object' ? SCRIPTS.filter((n) => typeof s[n] === 'string') : [];
  } catch {
    return [];
  }
}

type Step = Omit<Check, 'cwd'>;
type Stack = { id: string; steps: Step[] };

/** The stacks found in one folder (`dir` '' is the repo root); `names` are its direct file names. Step names are local (`test`). */
async function folderStacks(dir: string, names: string[], read: (path: string) => Promise<string | null>): Promise<Stack[]> {
  const has = (f: string) => names.includes(f);
  const at = (f: string) => (dir ? `${dir}/${f}` : f);
  const stacks: Stack[] = [];
  const pair = (id: string, build: string, test: string) =>
    stacks.push({ id, steps: [{ name: 'build', run: build }, { name: 'test', run: test, needs: 'build' }] });
  if (has('package.json')) {
    const pm = packageManager(has);
    const scripts = scriptsOf(await read(at('package.json')));
    // An install with nothing to run after it is not a check.
    if (scripts.length) {
      stacks.push({ id: 'npm', steps: [{ name: 'install', run: pm.install }, ...scripts.map((s) => ({ name: s, run: pm.run(s), needs: 'install' }))] });
    }
  }
  if (names.some((n) => /\.(sln|csproj)$/.test(n))) pair('dotnet', 'dotnet build', 'dotnet test');
  if (has('go.mod')) pair('go', 'go build ./...', 'go test ./...');
  if (has('Cargo.toml')) pair('cargo', 'cargo build', 'cargo test');
  for (const f of names.filter((n) => n === 'pyproject.toml' || /^requirements.*\.txt$/.test(n))) {
    if ((await read(at(f)))?.includes('pytest')) { stacks.push({ id: 'pytest', steps: [{ name: 'test', run: 'pytest' }] }); break; }
  }
  if (!stacks.length && has('Makefile') && /^test:/m.test((await read(at('Makefile'))) ?? '')) stacks.push({ id: 'make', steps: [{ name: 'test', run: 'make test' }] });
  return stacks;
}

/** A folder name as a check-name prefix: letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 24 chars; null when nothing is left. */
function prefixOf(dir: string): string | null {
  const p = dir.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 24).replace(/[-.]+$/, '');
  return p || null;
}

/** Valid checks for one folder: names are unique (a folder with several stacks suffixes each step with its stack) and fit the name pattern. */
async function folderChecks(dir: string, names: string[], read: (path: string) => Promise<string | null>, prefix: string | null): Promise<Check[]> {
  const stacks = await folderStacks(dir, names, read);
  const multi = stacks.length > 1;
  const local = (st: Stack, step: string) => (multi ? `${st.id}-${step}` : step);
  const full = (st: Stack, step: string) => (prefix ? `${prefix}.${local(st, step)}` : local(st, step));
  return stacks.flatMap((st) =>
    st.steps.map((x): Check => ({ name: full(st, x.name), cwd: dir || '.', run: x.run, ...(x.needs ? { needs: full(st, x.needs) } : {}) })));
}

/** Checks detected from a repo's file list: the root and first-level folders only, in the order they first appear. */
export async function detectChecks(files: string[], read: (path: string) => Promise<string | null>): Promise<Check[]> {
  const root: string[] = [];
  const folders = new Map<string, string[]>();
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length === 1) root.push(f);
    else if (parts.length === 2) folders.set(parts[0]!, [...(folders.get(parts[0]!) ?? []), parts[1]!]);
  }
  const out = await folderChecks('', root, read, null);
  const used = new Set<string>();
  for (const dir of folders.keys()) {
    const prefix = prefixOf(dir);
    if (!prefix || used.has(prefix)) continue; // a folder that cannot be named uniquely is left out
    used.add(prefix);
    out.push(...(await folderChecks(dir, folders.get(dir)!, read, prefix)));
  }
  return out;
}
