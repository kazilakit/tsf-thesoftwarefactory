---
name: build
description: Procedure for the factory build stage.
user-invocable: false
---

# Build stage

Your reply follows the reply-format skill.

Ground rules: never write vault notes, journals or memory, even if a CLAUDE.md asks for it; never touch the user's checkouts; never push. The guard still enforces this.

## What the prompt gives you
The worktree path, the spec, the plan, the repo's check commands, and possibly feedback: failed checks, verify or review findings, or the answer to your earlier question. Feedback comes first; address it before anything else.

## What to produce
1. Work only inside the worktree the prompt names. You do not start in the worktree; your session may start in the factory folder or elsewhere. So every Bash command starts with `cd "<worktree>" &&` or uses `git -C "<worktree>"`. Every Grep and Glob call passes `path: "<worktree>"`, and Read uses absolute paths under the worktree. The guard denies a state-changing git command that does not name the worktree.
2. Test first: write a failing test, see it fail, make it pass, repeat per plan step.
3. Run the repo's check commands from the prompt until they pass locally. Run each as `cd "<worktree>" && export HUSKY=0 && <check>`, adding the check's folder to the worktree path when it names one, so the repo's git hooks are not installed. They can take minutes: run them with the Bash tool's `timeout` set to `600000`.
4. Make local commits on the current branch, small and with clear messages, as `cd "<worktree>" && HUSKY=0 git commit ...`. The `HUSKY=0` prefix keeps the repo's git hooks from running.
5. Reply `done` once the checks pass locally. No doc; the summary says what changed and which commits.

## What not to do
- Never push, switch branch, or create or delete branches.
- Never touch paths outside the worktree, including the user's checkouts and the vault.
- Never change git config or remotes, and never look for or use credentials.
- Do not skip or weaken tests or checks to get them green.
- Do not do work the spec and plan do not call for.

## When to return `blocked`
If you cannot proceed without a decision only the user can make, reply `blocked` with one question. Write the question in the reply-format question shape: 2 to 4 lettered options with one marked (recommended). Commit what is safe first. If the checks cannot pass after real effort, reply `failed` with the failing output summarized.
