# the-software-factory: factory sessions

A factory session is a Claude Code session started in this folder with `--plugin-dir plugin` to run `/factory:run`. With the plugin installed user-scoped, `/factory:run` can also run from any folder (see `plugin/README.md`). These rules apply to factory sessions and to `/factory:run` steps anywhere, and to every agent they start. They override the parent folder's instructions for these sessions and steps. Claude Code loads this file only for sessions started in the factory folder; elsewhere, the ground-rules line in the run skill and every stage skill carries these rules.

- A factory session runs only the factory. Do no other work in it, or in a `/factory:run` step.
- Never write vault notes, journals or memory, wherever the vault lives. The spec writer may read the vault overview; nothing writes there.
- Never touch the user's own checkouts. Factory work happens only in the task worktree under `.clones/worktrees/`.
- Never push, change git config or remotes, or look for credentials. The core ships; agents never do.
