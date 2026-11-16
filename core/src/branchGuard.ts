import { fileURLToPath } from 'node:url';

export * from './branches.js';

/** Absolute path of the pre-push hook (src/ and dist/ both sit one level under core/). */
export const HOOK_PATH = fileURLToPath(new URL('../hooks/pre-push', import.meta.url));
