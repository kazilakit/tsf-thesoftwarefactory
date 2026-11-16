---
name: reply-format
description: The reply format every factory stage agent ends with.
user-invocable: false
---

# Reply format

End your final message with exactly one `<factory-result>` block holding JSON, and, for stages that produce a doc, at most one `<factory-doc>` block holding the doc as markdown.

Spec (plan has the same shape):

```reply-example spec
<factory-result>
{"status": "done", "summary": "Spec written for the task."}
</factory-result>
<factory-doc>
# Spec

## Acceptance criteria
- [ ] Example criterion
</factory-doc>
```

Verify (a `verdict` and a doc):

```reply-example verify
<factory-result>
{"status": "done", "summary": "Checks passed and every criterion is met.", "verdict": "pass"}
</factory-result>
<factory-doc>
# Verification

- [x] Example criterion: met, see `src/widget.ts:12` and test `widget renders`.
</factory-doc>
```

Review (a `verdict` and a doc):

```reply-example review
<factory-result>
{"status": "done", "summary": "One major finding must be fixed before a PR.", "verdict": "changes"}
</factory-result>
<factory-doc>
# Review

## Major
- `src/widget.ts:20`: the empty list is not handled, so the spec's second criterion fails.
</factory-doc>
```

Build (no doc):

```reply-example build
<factory-result>
{"status": "done", "summary": "Added the widget with tests; commits abc1234 and def5678. Checks pass locally."}
</factory-result>
```

## JSON fields

- `status`: `done`, `blocked` or `failed`.
- `summary`: one or two sentences on what you did.
- `question`: required when `status` is `blocked`; one question in the shape below.
- `verdict`: `pass` or `fail` (verify); `approve` or `changes` (review). Required when done, for those two stages only.
- Never put `doc` in the JSON. The `<factory-doc>` body becomes the doc.
- Leave out `turns` and `costUsd`.

## Which stages need what (when `done`)

| Stage | verdict | doc |
|---|---|---|
| spec, plan | no | yes |
| build | no | no |
| verify | pass or fail | yes |
| review | approve or changes | yes |

## Question shape (blocked)

A `blocked` reply still carries one question. Write it like a multiple-choice question:

- One question line, then 2 to 4 lettered options (`A.` to `D.`), one per line, each with a short consequence.
- Exactly one option is recommended. It ends with `(recommended)` and is listed first, as `A.`.
- A last line says the owner can reply with an option letter or in their own words.

Question example, as the `question` text:

```text
Which base branch should the work start from?
A. main: matches the other tasks and needs no rebase (recommended)
B. develop: includes unreleased work, so the diff may grow
C. a branch you name: I will use it as given
Reply with an option letter, or answer in your own words.
```

## Rules

- Exactly one `<factory-result>` block and at most one `<factory-doc>` block. Nothing else may use these tags.
- Never write the literal tag text of the result or doc block inside the doc. If you must mention the format, describe it in words.
- Valid JSON: double quotes, no trailing commas, no comments.
- A `blocked` reply needs no doc.
