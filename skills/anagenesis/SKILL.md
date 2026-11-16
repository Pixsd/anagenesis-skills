---
name: anagenesis
description: Create, fix, evaluate, version, restore and use agent skills through the anagenesis CLI, and run SkillOpt Sleep nights that learn from past sessions. Use whenever the user asks to make a new skill, correct a skill after a mistake, improve a skill from recent sessions, roll a skill back, or use a skill kept in an Anagenesis store.
---

# Anagenesis

Anagenesis is a local archive of skill versions with a strict notary. It never writes skills, never runs tests and never calls a model. **You** do the thinking work and orchestrate subagents; Anagenesis checks the evidence and records versions in Git.

Every command prints exactly one JSON document on stdout, also for errors. Read it before the next step: each response carries the ids and paths the next request needs.

## Before you start

1. Run `anagenesis --help`. If the command is missing, stop and tell the user to install the package (README, "Quick start").
2. Store: commands use `--store <absolute path>`, else `ANAGENESIS_STORE`, else the store saved by `anagenesis install-skill --store`. If a command answers that no store is set, ask the user for an absolute path outside any Git checkout and pass it with `--store`.
3. `sleep` also needs Python 3.10+ (`ANAGENESIS_PYTHON` selects one). Every other command works without Python.
4. Requests: `anagenesis <command> --request <file.json>` (or `--request -` for stdin). Keep request files outside skill workspaces. Templates for every request are in [references/requests.md](references/requests.md); objects reject unknown fields.
5. Every mutation needs a fresh UUID v4 `operationId`. To retry a lost response, resend the same file unchanged: same id and body return the same result.

Two kinds of digests:

- **Hashes you compute**: `anagenesis digest --path <dir>` for a skill tree (`expectedDigest`, `candidateDigest`); `anagenesis digest --file <file>` for exact bytes (`inputDigest` of a case text, artifact keys, memory hashes).
- **Digests you copy from responses**: `policyDigest` = `evaluationPlan.policyDigest` and `suiteDigest` = `evaluationPlan.attempts[i].suiteDigest` from the `create`/`improve` response; `baseVersion`/`baseDigest` from the `improve` response.

## Roles

| Role     | Who                            | Sees                                    | Never sees                     |
| -------- | ------------------------------ | --------------------------------------- | ------------------------------ |
| Author   | You                            | Brief, visible examples, the skill      | Exam cases, answers, manifest  |
| Examiner | One subagent, kept for the job | Exam cases, checklists, answers, scores | Your conversation              |
| Runner   | Fresh subagent per run         | One task input (+ the skill folder)     | Checklist, other runs          |
| Judge    | Fresh subagent per answer      | Checklist and one answer                | Which side produced the answer |

The examiner builds the evidence and submits it; you only receive the submit response and per-case scores. If you ever read exam cases or answers, tell the user: the attempt must declare `authorExposed: true` (publication is then blocked) and needs new cases. Full protocol, isolation rules and retries: [references/evaluation.md](references/evaluation.md).

## Create a skill

1. Agree with the user on objective, boundaries, audience, sources and success criteria. Write 2–4 visible examples with expected results.
2. Ask the examiner to write exam cases (`evaluation.md`, "Preparing cases") and return only `[{id, inputDigest, split}]`.
3. Write `create.json` (template: create): exam ids and digests in `policy.holdouts` (one group per attempt, spare groups for retries) and `policy.regression`, your examples in `policy.development`, and the frozen run settings in `policy.evaluation`. Run `anagenesis create`.
4. Keep `candidateId`, `workspacePath`, `briefPath` and `evaluationPlan`. Read the brief.
5. Write the skill in `workspacePath` (frontmatter `name` = skill id, non-empty `description`). Follow the brief's four creation stages and write `mining` (template: mining) with the sources each stage used, in a file outside the workspace.
6. Stop editing. Hand the examiner `workspacePath`, the create response and your mining file, and ask it to evaluate and submit (`evaluation.md`, "Evaluating and submitting").
7. `published`: tell the user the version. `rejected`: follow "After a rejection" in `evaluation.md`.

## Use a skill

`anagenesis resolve --skill <id>` returns `path` (read-only), `version` and `digest`. Read `SKILL.md` from `path` and remember `version` and `digest` for feedback.

## Record a mistake

When a resolved skill misbehaves or the user corrects you, send `feedback` (template: feedback) with that `version` and `digest`, expected and actual behaviour and your severity per dimension. Keep `feedbackId`. If it was not the skill's fault, send a new feedback with `supersedes` and `disposition: "not_skill"`.

## Fix a skill

1. Have the examiner prepare new exam cases.
2. Send `improve` (template: improve) with the create fields, `expectedVersion` = the active version and the `feedbackIds` to address.
3. The workspace already holds the base version. Read the brief, write the diagnosis (template: diagnosis) in a file outside the workspace, then change only what it covers.
4. Ask the examiner to evaluate and submit. The baseline is the base version: `anagenesis resolve --skill <id> --version <baseVersion>` must return `digest` equal to `baseDigest`.
5. `STALE_BASE`: someone published meanwhile; start again from the new version.

## Learn from past sessions (Sleep)

Follow [references/sleep.md](references/sleep.md): run, answer every pending prompt with a fresh subagent, resume until a terminal state, show the result to the user, and adopt only after explicit approval.

## Roll back

Run `anagenesis history --skill <id>` (follow `nextCursor` with `--cursor` for older pages), pick the version with the user, then send `restore` (template: restore) with `sourceVersion` and `expectedVersion` = the active version. It publishes a new version with the old files; nothing is deleted.

## Errors

Exit codes: 2 malformed request (the error lists each bad field: fix and resend with a new `operationId`), 3 conflict (`STALE_BASE`: rebase; `STORE_BUSY`: wait and resend the same file), 4 evidence invalid or rejected, 5 missing data or store problem. Report anything you cannot fix to the user with the error JSON.
