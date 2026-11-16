// Wizard steps shared by the first run and later runs.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardStore } from '../boardStore.js';
import { isMainRef } from '../branches.js';
import { normaliseChecks, type Check } from '../checksSchema.js';
import { detectChecks } from '../detectChecks.js';
import type { DoctorCheck } from '../doctor.js';
import { ensureMain, ID_MAX, isValidId, RESERVED_ID } from '../factories.js';
import type { RepoEntry } from '../factoryFile.js';
import type { GitHubBoardFor, RepoRef } from '../githubBoard.js';
import type { GitHubSetup, GitHubSetupFor } from '../githubSetup.js';
import { parseRemote } from '../remote.js';
import type { GhCli } from './ghCli.js';
import type { Prompter } from './prompts.js';

export interface InitDeps {
  root: string; prompt: Prompter; gh: GhCli; boardFor: GitHubBoardFor; setupFor: GitHubSetupFor;
  /**
   * A board client made anew on each call (no cached token), for the login's scope checks: after the scope refresh a
   * cached client may still hold the old token. Defaults to `boardFor`.
   */
  freshBoardFor?: GitHubBoardFor;
  /** The local FileStore (localStoreDir). */
  openStore: () => Promise<BoardStore>;
  doctor: (factoryId: string) => Promise<DoctorCheck[]>;
  platform: NodeJS.Platform; now: () => Date;
}

/** The wizard cannot go on; the message says what to run. firstRun prints it and exits 1. */
export class InitStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitStopError';
  }
}

export const factoriesDir = (root: string): string => join(root, 'factories');

/** Factory ids in use: folders under factories/ and the store's definitions. */
export async function takenFactoryIds(d: InitDeps): Promise<string[]> {
  const dir = factoriesDir(d.root);
  const folders = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  const defs = (await (await d.openStore()).listFactoryDefs()).map((x) => x.factoryId);
  return [...new Set([...folders, ...defs])];
}

/** Step 1: the gh login (gh auth login when there is none, a pick when there are several) with the project scope.
 * `preset`, when it is one of the logins, is taken without the question. */
export async function chooseLogin(d: InitDeps, preset?: string): Promise<string> {
  let logins = await d.gh.logins();
  if (logins.length === 0) {
    d.prompt.say('gh has no GitHub login; starting gh auth login.');
    await d.gh.login();
    logins = await d.gh.logins();
    if (logins.length === 0) throw new InitStopError('Still no GitHub login. Run: gh auth login --hostname github.com, then ./factory init');
  }
  const login = preset && logins.includes(preset) ? preset : logins.length === 1
    ? logins[0]!
    : await d.prompt.choose('Which GitHub login should the factory use?', logins.map((l) => ({ value: l, label: l })));
  const hasScope = async () => (await (d.freshBoardFor ?? d.boardFor)(login).tokenScopes())?.includes('project') === true;
  if (!(await hasScope())) {
    d.prompt.say(`${login} needs the project scope; starting gh auth refresh.`);
    await d.gh.refreshProjectScope(login);
    if (!(await hasScope())) {
      throw new InitStopError(`${login} still lacks the project scope. Run: gh auth refresh --hostname github.com -s project (as ${login}), then ./factory init`);
    }
  }
  return login;
}

/** A valid id from a display name, not `global` and not in `taken` (a `-2`, `-3`… suffix when needed). */
export function idFromName(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').slice(0, ID_MAX).replace(/-+$/, '') || 'factory';
  const free = (id: string) => id !== RESERVED_ID && !taken.includes(id);
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, ID_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (free(id)) return id;
  }
}

/** The id question's check: valid, not reserved, not taken. */
export function idProblem(v: string, taken: string[]): string | null {
  if (!isValidId(v)) return `The id must start with a letter and use only a-z, 0-9 and - (at most ${ID_MAX} characters)`;
  if (v === RESERVED_ID) return `"${RESERVED_ID}" is reserved`;
  if (taken.includes(v)) return `A factory with id ${v} already exists`;
  return null;
}

/** `git@…`, `https://github.com/…` or `o/r`; the shorthand becomes `git@github.com:o/r.git`. null when none fits. */
export function remoteFromLine(line: string): { remote: string; ref: RepoRef } | null {
  const short = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(line);
  const remote = short ? `git@github.com:${short[1]}/${short[2]}.git` : line;
  try {
    return { remote, ref: parseRemote(remote) };
  } catch {
    return null;
  }
}

interface FoundRepo { line: string; remote: string; ref: RepoRef; defaultBranch: string }

/** Reads the repo list until every line is a reachable GitHub repo. */
async function readRepoLines(d: InitDeps, setup: GitHubSetup, login: string): Promise<FoundRepo[]> {
  for (;;) {
    const lines = await d.prompt.lines('Repo links, one per line (git@github.com:owner/repo.git, https://github.com/owner/repo or owner/repo); an empty line ends the list:');
    if (lines.length === 0) {
      d.prompt.say('Enter at least one repo.');
      continue;
    }
    const bad: string[] = [];
    const found: FoundRepo[] = [];
    for (const line of lines) {
      const r = remoteFromLine(line);
      if (!r) { bad.push(`${line}: not a GitHub repo link`); continue; }
      const key = `${r.ref.owner}/${r.ref.repo}`.toLowerCase();
      if (found.some((f) => `${f.ref.owner}/${f.ref.repo}`.toLowerCase() === key)) { bad.push(`${line}: listed twice`); continue; }
      const info = await setup.repo(r.ref);
      if (!info) { bad.push(`${line}: not found or not visible to ${login}`); continue; }
      found.push({ line, ...r, defaultBranch: info.defaultBranch });
    }
    if (bad.length === 0) return found;
    d.prompt.say('Fix these lines and enter the list again:');
    for (const b of bad) d.prompt.say(`  ${b}`);
  }
}

/** Asks a base branch until it is not main and exists on GitHub. */
export async function askBase(d: InitDeps, setup: GitHubSetup, ref: RepoRef, question: string, def?: string): Promise<string> {
  for (;;) {
    const b = await d.prompt.ask(question, {
      ...(def ? { default: def } : {}),
      validate: (v) => (v === '' ? 'Enter a branch name' : isMainRef(v) ? 'main is never a base branch' : null),
    });
    if (await setup.branchExists(ref, b)) return b;
    d.prompt.say(`${ref.owner}/${ref.repo} has no branch ${b}`);
  }
}

/** The default-path base: the default branch, or dev when that is main; null when main and there is no dev. */
async function suggestedBase(setup: GitHubSetup, r: FoundRepo): Promise<string | null> {
  if (!isMainRef(r.defaultBranch)) return r.defaultBranch;
  return (await setup.branchExists(r.ref, 'dev')) ? 'dev' : null;
}

/** Detected checks from the default branch's tree; a listing error is said and gives none. */
async function detected(d: InitDeps, setup: GitHubSetup, r: FoundRepo, id: string): Promise<Check[]> {
  let checks: Check[] = [];
  try {
    const files = await setup.listFiles(r.ref, r.defaultBranch);
    checks = await detectChecks(files, (p) => setup.readFile(r.ref, r.defaultBranch, p));
  } catch (e) {
    d.prompt.say(`Could not read the files of ${r.ref.owner}/${r.ref.repo}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (checks.length === 0) d.prompt.say(`no checks found for ${id}`);
  else {
    d.prompt.say(`Detected checks for ${id} (they may be incomplete; edit them in factory.yaml or with ./factory init):`);
    showChecks(d, checks);
  }
  return checks;
}

export const checkLine = (c: Check): string => `${c.name}: ${c.run}${c.cwd !== '.' ? ` (in ${c.cwd})` : ''}${c.needs ? ` [needs ${c.needs}]` : ''}`;
function showChecks(d: InitDeps, checks: Check[]): void {
  checks.forEach((c, i) => d.prompt.say(`  ${i + 1}. ${checkLine(c)}`));
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** Asks one check's fields; `from` gives the defaults (an edit). `-` clears needs. */
async function askCheck(d: InitDeps, others: Check[], from?: Check): Promise<Check> {
  const name = await d.prompt.ask('Check name', {
    ...(from ? { default: from.name } : {}),
    validate: (v) => (!NAME.test(v) ? `A check name must match ${NAME.source}` : others.some((c) => c.name === v) ? `There is already a check named ${v}` : null),
  });
  const cwd = await d.prompt.ask('Folder to run it in', { default: from?.cwd ?? '.' });
  const run = await d.prompt.ask('Command', { ...(from ? { default: from.run } : {}), validate: (v) => (v ? null : 'Enter a command') });
  const needs = await d.prompt.ask(from?.needs ? 'Runs only after check (- for none)' : 'Runs only after check (empty for none)', { default: from?.needs ?? '' });
  return { name, cwd, run, ...(needs && needs !== '-' ? { needs } : {}) };
}

/** The custom checks menu: keep, add, edit or remove, starting from the detected list; keep validates the list. */
export async function editChecks(d: InitDeps, id: string, start: Check[]): Promise<Check[]> {
  let checks = [...start];
  for (;;) {
    d.prompt.say(checks.length ? `Checks for ${id}:` : `Checks for ${id}: none`);
    showChecks(d, checks);
    const action = await d.prompt.choose(`What next for the checks of ${id}?`, [
      { value: 'keep', label: 'Keep these checks' }, { value: 'add', label: 'Add a check' },
      { value: 'edit', label: 'Edit a check' }, { value: 'remove', label: 'Remove a check' },
    ]);
    const pick = async (verb: string) => Number(await d.prompt.choose(`Which check to ${verb}?`, checks.map((c, i) => ({ value: String(i), label: checkLine(c) }))));
    if (action === 'keep') {
      const valid = normaliseChecks(checks);
      if (valid.ok) return valid.value;
      d.prompt.say(`The checks are not valid: ${valid.error}`);
    } else if (action === 'add') {
      checks.push(await askCheck(d, checks));
    } else if (checks.length === 0) {
      d.prompt.say('There are no checks yet.');
    } else if (action === 'edit') {
      const i = await pick('edit');
      checks[i] = await askCheck(d, checks.filter((_, j) => j !== i), checks[i]);
    } else {
      const i = await pick('remove');
      checks = checks.filter((_, j) => j !== i);
    }
  }
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Step 8: repo links (re-asked whole while any line is bad), then default or custom setup. Default: base from GitHub
 * (never main), the factory's protected branches, detected checks. Custom: each of those asked per repo.
 */
export async function askRepos(d: InitDeps, login: string, factoryDefaults: string[], existingIds: string[]): Promise<RepoEntry[]> {
  const setup = d.setupFor(login);
  const found = await readRepoLines(d, setup, login);
  const mode = await d.prompt.choose('Repo setup', [
    { value: 'default', label: 'Default setup (base branch from GitHub, the factory protected branches, detected checks)' },
    { value: 'custom', label: 'Custom setup (choose the base branch, protected branches and checks per repo)' },
  ]);
  const taken = [...existingIds];
  const out: RepoEntry[] = [];
  for (const r of found) {
    const id = idFromName(r.ref.repo, taken);
    taken.push(id);
    const suggestion = await suggestedBase(setup, r);
    const mainNote = `Base branch for ${id} (its default branch is main, which is never a base)`;
    if (mode === 'default') {
      const baseBranch = suggestion ?? await askBase(d, setup, r.ref, mainNote);
      out.push({ id, remote: r.remote, baseBranch, checks: await detected(d, setup, r, id) });
      continue;
    }
    d.prompt.say(`Repo ${id} (${r.ref.owner}/${r.ref.repo}):`);
    const baseBranch = await askBase(d, setup, r.ref, suggestion ? `Base branch for ${id}` : mainNote, suggestion ?? undefined);
    const defaults = ensureMain(factoryDefaults);
    const answer = await d.prompt.ask(`Protected branches for ${id} (comma-separated; main is always protected)`, { default: defaults.join(', ') });
    const branches = ensureMain(answer.split(','));
    const checks = await editChecks(d, id, await detected(d, setup, r, id));
    out.push({ id, remote: r.remote, baseBranch, ...(sameList(branches, defaults) ? {} : { protectedBranches: branches }), checks });
  }
  return out;
}

/** Step 11: doctor until no check fails or the user stops retrying (false). */
export async function checkUntilClean(d: InitDeps, factoryId: string): Promise<boolean> {
  for (;;) {
    const failures = (await d.doctor(factoryId)).filter((c) => !c.ok);
    if (failures.length === 0) return true;
    for (const f of failures) d.prompt.say(`FAIL ${f.check}: ${f.detail}`);
    if (!(await d.prompt.confirm('Retry the checks?', true))) return false;
  }
}
