// Pure (no Node API, no Octokit).
/** Parses `git@github.com:O/R(.git)` and `https://github.com/O/R(.git)`. */
export function parseRemote(remote: string): { owner: string; repo: string } {
  const m = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(remote) ?? /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(remote);
  if (!m) throw new Error(`unsupported remote: ${remote}`);
  return { owner: m[1]!, repo: m[2]! };
}
