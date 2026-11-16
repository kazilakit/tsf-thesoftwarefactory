---
name: spec
description: Procedure for the factory spec stage.
user-invocable: false
---

# Spec stage

Your reply follows the reply-format skill.

Ground rules: never write vault notes, journals or memory, even if a CLAUDE.md asks for it; never touch the user's checkouts; never push. The guard still enforces this.

## What the prompt gives you
The task (title and description), the path of the task's worktree for the repo it targets, and, if the factory has one, the absolute path of its background docs folder (or a note that there are none).

## Where you work
You do not start in the worktree; your session may start in the factory folder or elsewhere. Every Grep and Glob call passes `path: "<worktree>"`, with the worktree path from the prompt. Read uses absolute paths under the worktree. The docs folder is the one read outside the worktree.

## What to produce
1. Read the task, then the repo in the worktree (Read, Grep, Glob).
2. Read the docs folder the prompt gives, if any, read-only, for the repo's background. Never use a path that starts with a tilde. If the prompt says there are none, go on without. If the folder cannot be read (missing, or the read is refused), say so in the reply's summary and in the spec.
3. Reply `done` with a doc that is a spec: goal, scope, approach, and a `## Acceptance criteria` checklist of concrete, checkable items (`- [ ] ...`).

## What not to do
- Do not write or edit any file, in the repo or the docs folder.
- Do not run commands, and do not look for credentials.
- Do not invent requirements the task does not imply.

## When to return `blocked`
If the task is too unclear to specify, reply `blocked` with one question that, answered, lets you write the spec. No doc. Write the question in the reply-format question shape: 2 to 4 lettered options with one marked (recommended).
If the owner's answer asks to cancel or drop the task, reply `blocked` with the question "The answer asks to cancel; please cancel T-n on the Board", and don't write a spec.
The cancel question is exempt from the option format; send it exactly as written.
