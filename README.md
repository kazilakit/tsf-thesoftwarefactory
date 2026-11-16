# The software factory

A Claude Code plugin and a small Node core that take a task from a board through spec, plan, build, verify and review, then open a pull request. Agents work only in a task worktree; the core pushes and opens the PR.

This repository runs locally: each factory is one file, `factories/<id>/factory.yaml`, and the factory's state lives on your machine.

## What works today

| Part | Supported now | Planned (config names exist, no code yet) |
|------|---------------|-------------------------------------------|
| Board (`board.source`) | `github` (GitHub Projects), `none` | `gitlab`, `jira`, `trello` |
| Repos (`repos.host`) | `github` | `gitlab`, `bitbucket` |
| Agents | Claude Code (models: `opus`, `sonnet`, `haiku`, `fable`) | |
| Store (`FACTORY_STORE`) | `local` (`factories/<id>/factory.yaml` plus `.factory/board.json`) | |

The local store is the only one in this build. Leave `FACTORY_STORE` unset or set it to `local`; any other value (such as `factory-app`) stops the CLI with a one-line error.

## Getting started

You need Node 22 or newer, git, [Claude Code](https://docs.claude.com/claude-code) and the [GitHub CLI](https://cli.github.com).

1. Clone this repository and go into it.
2. Run `./setup.sh` (macOS, Linux) or `setup.cmd` (Windows, in cmd.exe). It checks the tools, installs and builds the core, writes the local `./factory` and `factory.cmd` launchers (git-ignored), and installs the Claude Code plugin at user scope. Run it again any time: every step checks first and skips what is done.
3. Run `./factory init` (Windows: `factory.cmd init`) and answer its questions. It sets up your GitHub login, a Project board, gates, models and repos, and writes `factories/<id>/factory.yaml`. After "Add another factory" the wizard finishes; run `./factory init` again for more changes.
4. To change settings later, run `./factory init` again: it shows a menu (models, gates, approvers, status map, repos, doctor). Your comments in `factory.yaml` are kept. `./factory doctor` checks the setup.
5. Open Claude Code and run `/factory:run` (or `/factory:run <factory-id>` to pick one factory).

Add work by creating issues on the factory's GitHub Project. The plugin and its guard hooks are installed user-scoped by setup, so `/factory:run` works from any folder. See [plugin/README.md](plugin/README.md).

`factories/<id>/factory.yaml` holds your GitHub logins and repo links. Don't commit it into contributions to this repository.

The file format, the checks list, the store variables (`FACTORY_STORE`, `FACTORY_STORE_LOCAL_PATH`) and ready templates are in the [factory.yaml reference](docs/setup/factory-yaml.md).

## Layout

- `core/`: the engine and the `factory` CLI (TypeScript).
- `plugin/`: the Claude Code plugin: the stage agents, skills and guard hooks.
- `setup.sh`, `setup.cmd`: one-time setup.
