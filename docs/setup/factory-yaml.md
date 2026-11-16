# factory.yaml reference

One file per factory: `factories/<id>/factory.yaml`. `./factory init` writes it for you and keeps your comments and key order when it changes it later. You can also edit it by hand; run `./factory doctor` afterwards to check it. A typo makes the factory unavailable until fixed (doctor names the file, the field path and the fix). It never falls back to an older copy.

## Fields

| Field | Meaning |
| --- | --- |
| `factory.id` | Lowercase letters, digits and hyphens. Must match the folder name. |
| `factory.name` | Display name. |
| `factory.source` | `local` (this machine's store; the default and the only value this build accepts). |
| `factory.docsPath` | Optional folder the spec writer may read. |
| `factory.git` | Optional commit identity: `{ name, email }`. |
| `factory.active` | `false` pauses the factory out of every run. |
| `factory.agents` | Model per stage (`spec`, `plan`, `build`, `verify`, `review`): `opus`, `sonnet`, `haiku` or `fable`. Left out means the session's model. |
| `accounts.github` | The gh login to use. Logins only, never tokens. |
| `board.source` | `none` or `github`. `trello` and `jira` are not supported yet. |
| `board.project` | `<owner>/<number>` of the GitHub Project (source `github`). |
| `board.label` | The label on issues the factory owns (default `factory`). |
| `board.approvers` | GitHub logins whose `/approve` counts. |
| `board.statusMap` | Optional: status to Project column. Left out means the default 13 columns. |
| `gates` | `spec`, `plan`, `pr`: which steps wait for a human. |
| `repos.host` | Default host for the repos (`github`; other hosts are not supported yet). |
| `repos.protectedBranches` | Default for every repo. `main` is always protected, and is never a base branch. Default `[dev, stg, main]`. |
| `repos.list[]` | `id`, `remote`, optional `host`, `baseBranch`, `protectedBranches`, and `checks`. |

Rules:

- `board.source` is `github` or `none`.
- `factory.source: factory-app`, `board.source: factory-app` and a `board.mirror` other than `none` belong to a hosted factory-app store that is not part of this build: such a file is reported as a config problem (`./factory doctor` names it) and the factory does not load.
- `accounts.<service>` must exist for every service the factory uses: the board's source and every repo host.
- Every repo needs a `baseBranch` that is not `main`.

## Checks

`checks` is an ordered list per repo. Each item is `{ name, cwd, run, needs? }`:

- `name`: unique in the repo; shown in the check report.
- `cwd`: a folder inside the repo (relative, no `..`).
- `run`: a shell command.
- `needs`: optional name of an earlier check; this check is skipped when that one did not pass.
- An empty list means no checks: the check step passes.

The wizard detects checks from the repo's files (`package.json` scripts, `*.sln`, `go.mod`, `pyproject.toml`, `Cargo.toml`, a `Makefile` with `test`) and lets you edit the list.

## Store variables

- `FACTORY_STORE`: `local` (default; `file` is accepted too). `--store` takes the same values. `factory-app` (or `blocks`) names a store that is not part of this build: the command exits 1 with one line saying so.
- `FACTORY_STORE_LOCAL_PATH`: an absolute folder for the store data only (`board.json` and its locks). Empty means `<root>/.factory`. `factories/` stays in the clone.

## Templates

Replace the ids, logins and repos with your own.

### Local + GitHub

Tasks live on a GitHub Project and in the local store; nothing else is needed.

```yaml
factory:
  id: myapp
  name: My App
  source: local
  agents:
    spec: opus
    build: sonnet
accounts:
  github: my-login
board:
  source: github
  project: my-login/7
  label: factory
  approvers: [my-login]
gates: { spec: true, plan: false, pr: true }
repos:
  host: github
  protectedBranches: [dev, stg, main]
  list:
    - id: web
      remote: git@github.com:my-org/web.git
      baseBranch: dev
      checks:
        - { name: install, cwd: ., run: npm ci }
        - { name: test, cwd: ., run: npm test, needs: install }
```

### Local, no board

Tasks live only in the local store; add them with `./factory dev add` (or `/factory:new`) and move them with the `./factory dev` commands.

```yaml
factory:
  id: myapp
  name: My App
  source: local
accounts:
  github: my-login
board:
  source: none
repos:
  host: github
  list:
    - id: web
      remote: git@github.com:my-org/web.git
      baseBranch: dev
      checks:
        - { name: install, cwd: ., run: npm ci }
        - { name: test, cwd: ., run: npm test, needs: install }
```
