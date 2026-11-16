// Node-only: which store a command uses, and where the local store keeps its files.
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { NO_FACTORY_APP } from './validated.js';

/** The one store inside the core: `local` (alias `file`), the YAML factories plus `board.json`. */
export type StoreKind = 'file';

/** `local`/`file` is the file store; `factory-app`/`blocks` named a store this build does not have, and is refused by name. */
export function parseStoreKind(value: string): StoreKind {
  if (value === 'local' || value === 'file') return 'file';
  if (value === 'factory-app' || value === 'blocks') throw new Error(`--store ${value}: ${NO_FACTORY_APP}; use local`);
  throw new Error('--store must be local (or file)');
}

/** The folder of board.json and the lock files: `FACTORY_STORE_LOCAL_PATH` (absolute), else `<root>/.factory`. Not created. */
export function storeDirPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.FACTORY_STORE_LOCAL_PATH;
  if (custom && !isAbsolute(custom)) throw new Error('FACTORY_STORE_LOCAL_PATH must be an absolute path');
  return custom ? resolve(custom) : join(root, '.factory');
}

/** `storeDirPath`, created when missing. */
export function localStoreDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = storeDirPath(root, env);
  mkdirSync(dir, { recursive: true });
  return dir;
}
