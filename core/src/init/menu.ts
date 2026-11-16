// `factory init` on later runs (design section 7.4): pick a factory, then one menu item at a time. Each item shows the
// current value, asks only about that item, saves through one path, and re-runs doctor.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VersionConflictError } from '../boardStore.js';
import { DEFAULT_SETTINGS } from '../defaults.js';
import { DEFAULT_GH_USER, ensureMain, type AgentModels } from '../factories.js';
import { yamlVersion } from '../factoriesFs.js';
import {
  applyChange, fileFromDefinition, loadFactoryFile, openTasksForRepo, saveFactoryFile, type ConfigChange, type FactoryFile,
} from '../factoryFile.js';
import { DEFAULT_STATUS_MAP } from '../githubConfig.js';
import { cancelTask } from '../owner.js';
import { parseRemote } from '../remote.js';
import { ALL_STATUSES } from '../status.js';
import type { Gate } from '../types.js';
import { GH_USER_PATTERN } from '../validated.js';
import { approversProblem, askGates, askModels, askStatusMap, firstRun } from './firstRun.js';
import { PromptClosedError } from './prompts.js';
import {
  askBase, askRepos, checkLine, checkUntilClean, chooseLogin, editChecks, factoriesDir, InitStopError, type InitDeps,
} from './shared.js';

export const CONFLICT = 'factory.yaml changed while you were answering; nothing was saved. Run the item again.';
export const OLD_FORMAT = 'This file is in the old format. Convert it (and move repos/*.yaml into it)?';
const QUIT = '\u0000quit';

type Entry = { id: string; boardOnly: boolean };
/** What a factory's menu ends with: an exit code, or back to the factory choice. */
type Outcome = number | 'back';
type Handler = (d: InitDeps, file: FactoryFile) => Promise<ConfigChange[] | null>;

/** Every `factories/<id>` folder with a factory.yaml, then every store definition without one (board.json only). */
async function listFactories(d: InitDeps): Promise<Entry[]> {
  const dir = factoriesDir(d.root);
  const folders = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'factory.yaml'))).map((e) => e.name).sort()
    : [];
  const defs = (await (await d.openStore()).listFactoryDefs()).map((x) => x.factoryId).filter((id) => !folders.includes(id)).sort();
  return [...folders.map((id) => ({ id, boardOnly: false })), ...defs.map((id) => ({ id, boardOnly: true }))];
}

/** The login a converted or exported file gets when its source has none: gh's login, confirmed, or one typed. */
async function askLogin(d: InitDeps): Promise<string> {
  const login = await chooseLogin(d);
  if (await d.prompt.confirm(`Use ${login} as this factory's GitHub login (accounts.github)?`, true)) return login;
  return d.prompt.ask('GitHub login', { validate: (v) => (GH_USER_PATTERN.test(v) ? null : `${v} is not a GitHub login`) });
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The single save path: applies the changes in order and saves. null (said why) when nothing was saved. */
function save(d: InitDeps, file: FactoryFile, changes: ConfigChange[]): FactoryFile | null {
  let next = file;
  for (const c of changes) {
    const r = applyChange(next, c);
    if (!r.ok) {
      d.prompt.say(r.error);
      return null;
    }
    next = r.value;
  }
  return saveNew(d, next);
}

/** Saves a file as it is; a version conflict or another failure is said and gives null. */
function saveNew(d: InitDeps, file: FactoryFile): FactoryFile | null {
  try {
    const saved = saveFactoryFile(file);
    d.prompt.say(`Saved ${saved.path}.`);
    return saved;
  } catch (e) {
    d.prompt.say(e instanceof VersionConflictError ? CONFLICT : `Nothing was saved: ${errorText(e)}`);
    return null;
  }
}

/** A handler that is about to act outside the file (cancel tasks) first checks the file is still the one it read. */
function assertUnchanged(file: FactoryFile): void {
  const now = existsSync(file.path) ? yamlVersion(readFileSync(file.path, 'utf8')) : 0;
  if (now !== file.version) throw new VersionConflictError(file.path, file.version, now);
}

/** GitHub follow-ups of a saved change: the label in an added repo, the columns of a new status map. */
async function afterSave(d: InitDeps, file: FactoryFile, changes: ConfigChange[]): Promise<void> {
  const { board, accounts } = file.config;
  const login = accounts.github;
  if (board.source !== 'github' || !login || !board.project) return;
  for (const c of changes) {
    try {
      if (c.kind === 'addRepo') {
        const ref = parseRemote(c.repo.remote);
        const gh = d.boardFor(login);
        if (!(await gh.labelExists(ref, board.label))) await gh.createLabel(ref, board.label);
      } else if (c.kind === 'setStatusMap') {
        const added = await d.setupFor(login).ensureStatusOptions(board.project, [...new Set(Object.values(c.statusMap ?? DEFAULT_STATUS_MAP))]);
        if (added.length) d.prompt.say(`Added Project columns: ${added.join(', ')}.`);
      }
    } catch (e) {
      d.prompt.say(`Could not update GitHub: ${errorText(e)}`);
    }
  }
}

// --- Items ---

const models: Handler = async (d, file) => {
  const current: AgentModels = file.config.def.agentModels ?? {};
  const list = Object.entries(current).map(([step, m]) => `${step} ${m}`);
  d.prompt.say(`Models now: ${list.length ? `${list.join(', ')}; session model for the rest` : 'session model for every stage'}`);
  return [{ kind: 'setModels', models: await askModels(d, current) }];
};

const gates: Handler = async (d, file) => {
  const id = file.config.def.factoryId;
  const current: Record<Gate, boolean> = (await (await d.openStore()).getSettings()).factories[id]?.factory.gates ?? { ...DEFAULT_SETTINGS.gates };
  const word = (g: Gate) => `${g} ${current[g] ? 'waits' : 'does not wait'}`;
  d.prompt.say(`Gates now: ${word('spec')}, ${word('plan')}, ${word('pr')}`);
  return [{ kind: 'setGates', gates: await askGates(d, current) }];
};

/** The board items need a GitHub board; null (said why) without one. */
function githubBoard(d: InitDeps, file: FactoryFile): { login: string; project: NonNullable<FactoryFile['config']['board']['project']> } | null {
  const { board, accounts } = file.config;
  if (board.source !== 'github' || !board.project || !accounts.github) {
    d.prompt.say('This factory has no GitHub board; set board in factory.yaml first.');
    return null;
  }
  return { login: accounts.github, project: board.project };
}

const approvers: Handler = async (d, file) => {
  if (!githubBoard(d, file)) return null;
  const current = file.config.board.approvers.join(', ');
  d.prompt.say(`Approvers now: ${current}`);
  const answer = await d.prompt.ask('Approvers (comma-separated GitHub logins)', { default: current, validate: approversProblem });
  return [{ kind: 'setApprovers', approvers: answer.split(',').map((x) => x.trim()).filter(Boolean) }];
};

const statusMap: Handler = async (d, file) => {
  const gh = githubBoard(d, file);
  if (!gh) return null;
  d.prompt.say('Status map now:');
  for (const s of ALL_STATUSES) d.prompt.say(`  ${s}: ${file.config.board.statusMap[s]}`);
  return [{ kind: 'setStatusMap', statusMap: await askStatusMap(d, gh.login, { kind: 'existing', ref: gh.project }) }];
};

const sayRepos = (d: InitDeps, file: FactoryFile): void =>
  d.prompt.say(`Repos now: ${file.config.repos.map((r) => r.repoId).join(', ') || 'none'}`);

const addRepo: Handler = async (d, file) => {
  sayRepos(d, file);
  const pre: ConfigChange[] = [];
  let login = file.config.accounts.github;
  if (!login) {
    login = await askLogin(d);
    pre.push({ kind: 'setAccounts', accounts: { ...file.config.accounts, github: login } });
  }
  const repos = await askRepos(d, login, file.config.def.protectedBranches, file.config.repos.map((r) => r.repoId));
  return [...pre, ...repos.map((repo): ConfigChange => ({ kind: 'addRepo', repo }))];
};

/** Picks one of the factory's repos; null (said why) when it has none. */
async function pickRepo(d: InitDeps, file: FactoryFile) {
  const repos = file.config.repos;
  if (repos.length === 0) {
    d.prompt.say('This factory has no repos.');
    return null;
  }
  const id = await d.prompt.choose('Which repo?', repos.map((r) => ({ value: r.repoId, label: `${r.repoId} (${r.remote})` })));
  return repos.find((r) => r.repoId === id)!;
}

const changeRepo: Handler = async (d, file) => {
  sayRepos(d, file);
  const repo = await pickRepo(d, file);
  if (!repo) return null;
  const factoryBranches = ensureMain(file.config.def.protectedBranches);
  const branches = repo.protectedBranches ?? factoryBranches;
  d.prompt.say(`${repo.repoId} now:`);
  d.prompt.say(`  base branch: ${repo.baseBranch}`);
  d.prompt.say(`  protected branches: ${branches.join(', ')}${repo.protectedBranches ? '' : ' (the factory default)'}`);
  d.prompt.say(repo.checks.length ? '  checks:' : '  checks: none');
  for (const c of repo.checks) d.prompt.say(`    ${checkLine(c)}`);
  const what = await d.prompt.choose(`What to change in ${repo.repoId}?`, [
    { value: 'base', label: 'Base branch' }, { value: 'protected', label: 'Protected branches' }, { value: 'checks', label: 'Checks' },
  ]);
  const update = (patch: Extract<ConfigChange, { kind: 'updateRepo' }>['patch']): ConfigChange[] => [{ kind: 'updateRepo', repoId: repo.repoId, patch }];
  if (what === 'checks') return update({ checks: await editChecks(d, repo.repoId, repo.checks) });
  if (what === 'protected') {
    const answer = await d.prompt.ask(`Protected branches for ${repo.repoId} (comma-separated; main is always protected)`, { default: branches.join(', ') });
    const list = ensureMain(answer.split(','));
    const same = list.length === factoryBranches.length && list.every((b, i) => b === factoryBranches[i]);
    return update({ protectedBranches: same ? null : list });
  }
  const login = file.config.accounts.github ?? await askLogin(d);
  const baseBranch = await askBase(d, d.setupFor(login), parseRemote(repo.remote), `Base branch for ${repo.repoId}`, repo.baseBranch);
  return update({ baseBranch });
};

const removeRepo: Handler = async (d, file) => {
  sayRepos(d, file);
  const repo = await pickRepo(d, file);
  if (!repo) return null;
  const store = await d.openStore();
  const open = await openTasksForRepo(store, file.config.def.factoryId, repo.repoId);
  if (open.length === 0) {
    return (await d.prompt.confirm(`Remove ${repo.repoId} from the factory?`, false)) ? [{ kind: 'removeRepo', repoId: repo.repoId }] : null;
  }
  d.prompt.say(`${repo.repoId} has open tasks:`);
  for (const t of open) d.prompt.say(`  ${t.taskId} ${t.status} ${t.title}`);
  const choice = await d.prompt.choose('What now?', [
    { value: 'cancel', label: 'Cancel these tasks, then remove the repo' }, { value: 'keep', label: 'Keep the repo' },
  ]);
  if (choice === 'keep') return null;
  assertUnchanged(file);
  const cancelled: string[] = [];
  for (const t of open) {
    try {
      await cancelTask(store, d.now, t.taskId);
    } catch (e) {
      if (!(e instanceof VersionConflictError)) throw e;
      // The task moved on (a run or the Board): say which one, and what is already cancelled; the repo stays.
      d.prompt.say(`${t.taskId} changed while it was being cancelled; ${repo.repoId} was not removed. Already cancelled: ${cancelled.join(', ') || 'none'}. Run the item again.`);
      return null;
    }
    cancelled.push(t.taskId);
  }
  d.prompt.say(`Cancelled ${cancelled.join(', ')}.`);
  return [{ kind: 'removeRepo', repoId: repo.repoId }];
};

const ITEMS: { value: string; label: string; run?: Handler }[] = [
  { value: 'models', label: 'Change models', run: models },
  { value: 'gates', label: 'Change gates', run: gates },
  { value: 'approvers', label: 'Change approvers', run: approvers },
  { value: 'statusMap', label: 'Change status map', run: statusMap },
  { value: 'addRepo', label: 'Add a repo', run: addRepo },
  { value: 'changeRepo', label: 'Change a repo', run: changeRepo },
  { value: 'removeRepo', label: 'Remove a repo', run: removeRepo },
  { value: 'addFactory', label: 'Add another factory' },
  { value: 'recheck', label: 'Re-check' },
  { value: QUIT, label: 'Quit' },
];

/** The login every loadable factory.yaml uses, when there is exactly one. */
async function sharedLogin(d: InitDeps): Promise<string | undefined> {
  const logins = new Set<string>();
  for (const e of await listFactories(d)) {
    if (e.boardOnly) continue;
    const f = loadFactoryFile(join(factoriesDir(d.root), e.id));
    const login = f.ok ? f.value.config.accounts.github : undefined;
    if (login) logins.add(login);
  }
  return logins.size === 1 ? [...logins][0] : undefined;
}

/** A factory with a factory.yaml: convert an old file first, then the menu until Quit. */
async function factoryMenu(d: InitDeps, id: string): Promise<Outcome> {
  const dir = join(factoriesDir(d.root), id);
  for (;;) {
    const loaded = loadFactoryFile(dir);
    if (!loaded.ok) {
      d.prompt.say(loaded.error);
      d.prompt.say('Fix factory.yaml, then run ./factory init again.');
      return 1;
    }
    const file = loaded.value;
    if (file.shape === 'legacy') {
      if (!(await d.prompt.confirm(OLD_FORMAT, true))) return 'back';
      const raw = file.doc.get('ghUser');
      const own = typeof raw === 'string' && raw.trim() !== '';
      const change: ConfigChange = own ? { kind: 'convert' } : { kind: 'convert', githubLogin: await askLogin(d) };
      if (!save(d, file, [change])) return 'back';
      await checkUntilClean(d, id);
      continue;
    }
    const item = await d.prompt.choose(`What would you like to change in ${id}?`, ITEMS.map(({ value, label }) => ({ value, label })));
    if (item === QUIT) return 0;
    if (item === 'recheck') {
      await checkUntilClean(d, id);
      continue;
    }
    if (item === 'addFactory') {
      const login = await sharedLogin(d);
      return firstRun(d, login ? { login } : {});
    }
    try {
      const changes = await ITEMS.find((x) => x.value === item)!.run!(d, file);
      if (!changes || changes.length === 0) continue;
      const saved = save(d, file, changes);
      if (!saved) continue;
      await afterSave(d, saved, changes);
    } catch (e) {
      if (!(e instanceof VersionConflictError)) throw e;
      d.prompt.say(CONFLICT);
      continue;
    }
    await checkUntilClean(d, id);
  }
}

/** A definition only in board.json: export it to factory.yaml (then the full menu), re-check, or quit. */
async function boardMenu(d: InitDeps, id: string): Promise<Outcome> {
  d.prompt.say(`${id} is kept only in board.json. Export it to factories/${id}/factory.yaml to change it here.`);
  for (;;) {
    const item = await d.prompt.choose(`What would you like to do with ${id}?`, [
      { value: 'export', label: 'Export to YAML' }, { value: 'recheck', label: 'Re-check' }, { value: QUIT, label: 'Quit' },
    ]);
    if (item === QUIT) return 0;
    if (item === 'recheck') {
      await checkUntilClean(d, id);
      continue;
    }
    const store = await d.openStore();
    const def = (await store.listFactoryDefs()).find((x) => x.factoryId === id);
    if (!def) {
      d.prompt.say(`${id} is no longer in board.json.`);
      return 'back';
    }
    const repos = await store.listFactoryRepos(id);
    const stored = (await store.getSettings()).factories[id]?.factory.gates ?? null;
    // A definition without a login of its own holds the fallback login: ask for the real one instead.
    const login = def.ghUser === DEFAULT_GH_USER ? await askLogin(d) : undefined;
    const file = fileFromDefinition(join(factoriesDir(d.root), id), def, repos, stored, login);
    if (!file.ok) {
      d.prompt.say(file.error);
      continue;
    }
    if (!saveNew(d, file.value)) continue;
    await checkUntilClean(d, id);
    return factoryMenu(d, id);
  }
}

/** `factory init`: the first run when there is no factory, else the menu. 0 done, 1 stopped, 130 cancelled. */
export async function runInit(d: InitDeps): Promise<number> {
  try {
    for (;;) {
      const entries = await listFactories(d);
      if (entries.length === 0) return await firstRun(d);
      let entry = entries[0]!;
      if (entries.length > 1) {
        const picked = await d.prompt.choose('Which factory?', [
          ...entries.map((e) => ({ value: e.id, label: e.boardOnly ? `${e.id} (board.json)` : e.id })), { value: QUIT, label: 'Quit' },
        ]);
        if (picked === QUIT) return 0;
        entry = entries.find((e) => e.id === picked)!;
      }
      const outcome = entry.boardOnly ? await boardMenu(d, entry.id) : await factoryMenu(d, entry.id);
      if (outcome !== 'back') return outcome;
      if (entries.length === 1) return 0;
    }
  } catch (e) {
    if (e instanceof PromptClosedError) {
      d.prompt.say('init cancelled; what was saved before stays saved');
      return 130;
    }
    if (e instanceof InitStopError) {
      d.prompt.say(e.message);
      return 1;
    }
    throw e;
  }
}
