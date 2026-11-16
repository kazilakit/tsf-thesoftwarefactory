---
name: plan
description: Procedure for the factory plan stage.
user-invocable: false
---

# Plan stage

Your reply follows the reply-format skill.

Ground rules: never write vault notes, journals or memory, even if a CLAUDE.md asks for it; never touch the user's checkouts; never push. The guard still enforces this.

## What the prompt gives you
The approved spec, the repo it targets, and the path of the task's worktree.

## Where you work
You do not start in the worktree; your session may start in the factory folder or elsewhere. Every Grep and Glob call passes `path: "<worktree>"`, with the worktree path from the prompt. Read uses absolute paths under the worktree.

## What to produce
1. Read the spec, then the repo in the worktree (Read, Grep, Glob) to find the real files, patterns and test setup.
2. Reply `done` with a doc that is a TDD implementation plan, in the style of `superpowers:writing-plans`, shortened: small ordered steps, each naming exact file paths, the failing test to write first (file and test name), the minimal change, and the check command to run. Cover every acceptance criterion.

## What not to do
- Do not write or edit any file, and do not run commands.
- Do not widen the spec's scope or change its acceptance criteria.
- No placeholders such as "add tests" or "handle errors"; name them.

## When to return `blocked`
If the spec is contradictory or leaves out something the plan cannot proceed without, reply `blocked` with one question. No doc. Write the question in the reply-format question shape: 2 to 4 lettered options with one marked (recommended).
