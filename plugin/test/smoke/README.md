# Plugin smoke run (file store)

Run on 2026-11-10, Claude Code 2.1.319, from a throwaway factory root `/private/tmp/factory-smoke` (deleted afterwards). Three `claude -p` runs in all.

## Setup

- `cd core && npm run build` (`core/dist` is gitignored).
- `remote.git`: bare repo, branch `dev`, one README commit (`# smoke`).
- `repos/<id>.yaml` for all seven repo ids (the core loader reads them all), each `remote: /private/tmp/factory-smoke/remote.git`, `baseBranch: dev`, `checks: {server: {cwd: ., build: "true", test: "true"}, client: {cwd: ., install: "true", typecheck: "true", lint: "true", test: "true"}, e2e: off}`.
- Symlinks `core` and `plugin` to the real folders.
- `FACTORY_ROOT=/private/tmp/factory-smoke node core/dist/cli.js dev add --repo data --title "Add a line to README"` printed `T-1`; `dev ready T-1` printed `T-1 ready`.

The command was renamed from its original name to `/factory:run` after this smoke run; the commands below use the new name.

## Runs (cwd `/private/tmp/factory-smoke`, `FACTORY_STORE=file`, stdin from `/dev/null`)

Allowed tools for runs 1 and 2: `--allowedTools "Bash(node:*)" "Bash(printenv:*)" "Bash(rm -f:*)" "Bash(git -C:*)" Agent Read Write Grep Glob`.

1. `claude -p --plugin-dir plugin <allowed> -- "/factory:run"`
   - Output ended `T-1 spec_review`.
   - `runs/T-1/spec.reply.md` existed (a `<factory-result>` block and a `<factory-doc>` spec); `node core/dist/cli.js status` showed `spec_review: 1`.
   - The SubagentStop hook wrote the reply (the skill never wrote it itself).
   - The session file `runs/.sessions/<id>.json` was removed. Only the `<id>.renew` marker and `runs/T-1/renew.log` (`T-1 claimed until ...`, written by the PostToolUse renew hook) remained, both under gitignored `runs/`.
2. Same command again, T-1 waiting at the gate: output `factory: nothing to do`.
3. `claude -p --plugin-dir plugin --allowedTools "Bash(git:*)" -- "In the directory .../.clones/worktrees/T-1, run exactly this Bash command: git push origin dev ..."`
   - Observed: `PreToolUse:Bash hook error: factory guard: Bash denied (git push)`. The bare remote still held only `4e8fff5 init`.

## Skills-name answer

`skills: [spec, reply-format]` with bare names works in `plugin/agents/spec-writer.md`. The reply used the exact `<factory-result>` and `<factory-doc>` format, which only the preloaded `reply-format` skill describes (the agent has no Skill tool, and the dispatch prompt does not mention the format). No `factory:` prefix was needed, so the agent files are unchanged.

## Other observations

- The spec-writer's read of the docs folder (outside the factory root) was denied in `-p` mode, so it wrote the spec from the worktree only. The spec step does not depend on it.
- No plugin or core defects were found; nothing was fixed.
