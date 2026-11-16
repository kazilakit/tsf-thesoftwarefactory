import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { PullLock, PullRelease } from './githubPuller.js';

const STALE_MS = 120_000;
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** The file lock, plus a probe that tells whether a pull holds it without taking it (the pusher waits for it). */
export type FileLock = PullLock & { held: (factoryId: string) => boolean };

/**
 * One pull per factory at a time: an exclusive lock file `<storeDir>/pull-<factoryId>.lock`, stale after 120 s.
 * The file holds a unique token; release removes it only while it still holds that token. A stale lock is taken over by
 * renaming it away first (only one renamer wins). A held lock gives null; other fs errors throw. The release handle's
 * `touch` refreshes the file's time while it still holds this token, so a long pull is not taken over as stale.
 */
export function fileLock(storeDir: () => string, now: () => number = Date.now): FileLock {
  const pathOf = (factoryId: string): string => join(storeDir(), `pull-${factoryId}.lock`);
  const held = (factoryId: string): boolean => {
    try {
      return now() - statSync(pathOf(factoryId)).mtimeMs <= STALE_MS;
    } catch (e) {
      if (missing(e)) return false;
      throw e;
    }
  };
  const take = async (factoryId: string): Promise<PullRelease | null> => {
    const path = pathOf(factoryId);
    mkdirSync(storeDir(), { recursive: true });
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
    const create = (): boolean => {
      try {
        const fd = openSync(path, 'wx');
        try { writeSync(fd, token); } finally { closeSync(fd); }
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
      }
    };
    const mine = (): boolean => {
      try {
        return readFileSync(path, 'utf8') === token;
      } catch (e) {
        if (missing(e)) return false;
        throw e;
      }
    };
    const release: PullRelease = Object.assign(() => { if (mine()) rmSync(path, { force: true }); }, {
      touch: (): boolean => {
        if (!mine()) return false;
        const t = new Date(now());
        utimesSync(path, t, t);
        return true;
      },
    });
    const age = (file: string): number => now() - statSync(file).mtimeMs;
    if (create()) return release;
    try {
      if (age(path) <= STALE_MS) return null;
    } catch (e) {
      if (missing(e)) return create() ? release : null;
      throw e;
    }
    const aside = `${path}.stale-${token}`;
    try {
      renameSync(path, aside); // only one taker moves the stale file; the others see ENOENT
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
    let fresh = false;
    try {
      fresh = age(aside) <= STALE_MS;
      if (fresh) {
        try { linkSync(aside, path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } // put the replaced lock back if possible
      }
    } finally {
      rmSync(aside, { force: true });
    }
    return fresh ? null : create() ? release : null;
  };
  return Object.assign(take, { held });
}
