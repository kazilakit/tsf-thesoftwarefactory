import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The clone that holds this plugin: two levels above plugin/hooks.
const PLUGIN_CLONE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function readHookInput() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim() ? JSON.parse(data) : {};
}

/**
 * True when dir holds core/package.json and plugin/.claude-plugin/plugin.json whose JSON name is
 * `factory` (repos/ is not needed). A manifest that cannot be read or parsed means not a root.
 */
export function isFactoryRoot(dir, exists = fs.existsSync, read = (p) => fs.readFileSync(p, 'utf8')) {
  const manifest = path.join(dir, 'plugin', '.claude-plugin', 'plugin.json');
  if (!exists(path.join(dir, 'core', 'package.json')) || !exists(manifest)) return false;
  try {
    return JSON.parse(read(manifest))?.name === 'factory';
  } catch {
    return false;
  }
}

/**
 * The clone a user-scoped install came from: the `the-software-factory` entry of
 * `<config dir>/plugins/known_marketplaces.json` (installLocation, else source.path). Null when the record is
 * missing or garbled; the caller still checks the folder is a factory root.
 */
export function marketplaceClone(env, home, read = (p) => fs.readFileSync(p, 'utf8')) {
  try {
    const cfg = env.CLAUDE_CONFIG_DIR || (home && path.join(home, '.claude'));
    if (!cfg) return null;
    const entry = JSON.parse(read(path.join(cfg, 'plugins', 'known_marketplaces.json')))?.['the-software-factory'];
    const dir = entry?.installLocation ?? entry?.source?.path;
    return typeof dir === 'string' && dir ? path.resolve(dir) : null;
  } catch {
    return null;
  }
}

/**
 * Finds the factory root: FACTORY_ROOT if set (null when it is not a factory root), else
 * CLAUDE_PROJECT_DIR, else the clone that holds the plugin (pluginRoot), else
 * the clone a user-scoped install came from (marketplace record). projectMode is true
 * when the root is the session's project dir, that is, the session started in the factory folder.
 */
export function resolveFactoryRoot(env, home, exists = fs.existsSync, read, pluginRoot = PLUGIN_CLONE) {
  const project = env.CLAUDE_PROJECT_DIR ? path.resolve(env.CLAUDE_PROJECT_DIR) : null;
  const found = (dir) => ({ root: dir, projectMode: dir === project });
  if (env.FACTORY_ROOT) {
    const dir = path.resolve(env.FACTORY_ROOT);
    return isFactoryRoot(dir, exists, read) ? found(dir) : null;
  }
  for (const dir of [project, pluginRoot && path.resolve(pluginRoot), marketplaceClone(env, home)]) {
    if (dir && isFactoryRoot(dir, exists, read)) return found(dir);
  }
  return null;
}

export function sessionFile(root, sessionId) {
  return path.join(root, 'runs', '.sessions', `${sessionId}.json`);
}

// Session file shape: {taskId, step, worktree, mode, session, factory}. Null when missing or unreadable.
export function readSession(root, sessionId) {
  if (!sessionId) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionFile(root, sessionId), 'utf8'));
  } catch {
    return null;
  }
}

export function isFactoryAgent(input) {
  return typeof input?.agent_type === 'string' && input.agent_type.startsWith('factory:');
}

// Same map as core/src/defaults.ts AGENT_FOR (a test keeps them equal).
export const AGENT_FOR = {
  spec: 'spec-writer',
  plan: 'planner',
  build: 'implementer',
  verify: 'verifier',
  review: 'reviewer',
};

export function claimantFor(sessionId, host) {
  return `claude:${host}:${String(sessionId).slice(0, 8)}`;
}

// Where a factory agent's final reply goes; null unless the stop is the session step's own agent.
export function replyTarget(input, ctx) {
  const { root, session } = ctx;
  if (!session?.taskId || !session.step) return null;
  const agent = AGENT_FOR[session.step];
  if (!agent || input?.agent_type !== `factory:${agent}`) return null;
  return path.join(root, 'runs', session.taskId, `${session.step}.reply.md`);
}

export const RENEW_INTERVAL_MS = 60_000;

export function shouldRenew(lastRenewMs, nowMs) {
  return lastRenewMs == null || nowMs - lastRenewMs >= RENEW_INTERVAL_MS;
}

export function renewFile(root, sessionId) {
  return path.join(root, 'runs', '.sessions', `${sessionId}.renew`);
}

const FACTORY_ID = /^[a-z][a-z0-9-]{0,39}$/;

// The store comes from the hook's own environment (the launch shell's FACTORY_STORE, default local, as session-start
// does), never from the session file the model writes. Null unless it is local or file (the only store in this build).
// The step's factory (session.factory, from the ticket) goes along as --factory; a value that is not a factory id is left out.
export function renewCommand({ root, session, sessionId, host, node = process.execPath, env = process.env }) {
  const store = env.FACTORY_STORE || 'local';
  if (!['local', 'file'].includes(store)) return null;
  const factory = typeof session.factory === 'string' && FACTORY_ID.test(session.factory) ? ['--factory', session.factory] : [];
  return {
    file: node,
    args: [path.join(root, 'core', 'dist', 'cli.js'), '--mode', session.mode, '--store', store, 'renew', session.taskId, ...factory],
    env: { ...env, FACTORY_ROOT: root, FACTORY_CLAIMANT: claimantFor(sessionId, host) },
    log: path.join(root, 'runs', session.taskId, 'renew.log'),
  };
}
