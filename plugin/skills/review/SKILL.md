---
name: review
description: Procedure for the factory review stage.
user-invocable: false
---

# Review stage

Your reply follows the reply-format skill.

Ground rules: never write vault notes, journals or memory, even if a CLAUDE.md asks for it; never touch the user's checkouts; never push. The guard still enforces this.

## What the prompt gives you
Only the spec, the diff (`git diff origin/<base branch>...HEAD`, run in the worktree), and the worktree path as a read-only root for understanding the code the diff touches. You have a fresh context: judge only the spec and the diff.

## Where you work
You do not start in the worktree; your session may start in the factory folder or elsewhere. Every Grep and Glob call passes `path: "<worktree>"`, with the worktree path from the prompt. Read uses absolute paths under the worktree.

## What to produce
1. Read the spec and the diff. Read files under the worktree only to understand code the diff touches.
2. Reply `done` with a doc listing findings by severity (blocker, major, minor, nit), each with `file:line` and why it matters. Cover correctness, spec fit, tests, and scope creep.
3. Verdict `changes` if any finding must be fixed before a PR; else `approve`.

## What not to do
- Do not edit files or run commands.
- Do not rely on the implementer's reasoning or any history; you were not given it.
- Do not request changes outside the spec's scope, and do not block on style nits.

## When to return `blocked`
If the spec or diff is missing or truncated so you cannot judge, reply `blocked` with one question. No doc. Write the question in the reply-format question shape: 2 to 4 lettered options with one marked (recommended).
