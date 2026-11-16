// Pure (no Node API): shared by factories.ts and githubConfig.ts.
export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** A GitHub login: letters, digits and single inner hyphens, at most 39 characters. */
export const GH_USER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * The gh login a factory holds when its definition leaves `ghUser` empty: "no GitHub login set". It is not a valid
 * login (gh never accepts it), so it is never written to files and the init wizard asks for a real one.
 */
export const DEFAULT_GH_USER = '(not set)';
export const NO_GH_LOGIN_HINT = 'no GitHub login is set for this factory (run: ./factory init)';

/** This build has the local (file) store only; the hosted factory-app store and its connected GitHub mode are not included. */
export const NO_FACTORY_APP = 'the factory-app store is not part of this build';
