# Evaluation protocol

Anagenesis verifies evidence; it cannot see how the runs were made. These rules make the evidence honest. The author (you) and the examiner must stay separate for the whole job.

## Preparing cases

Give the examiner a fresh context and this brief: objective, boundaries, tools available, and the number of cases. It must:

1. Write the exam cases in a file outside every skill workspace, for example `~/.anagenesis-exams/<skill>/cases.json`: at least two holdout groups (one per attempt; the first is used now, the others are spares for retries) of at least `minimumHoldout` cases each, plus regression cases for behaviour that must not get worse. Each case has an `id`, the exact input text, a checklist and the expected result.
2. Compute each `inputDigest` with `anagenesis digest --file <file with the exact input text>`.
3. Return to you only `[{id, inputDigest, split, group}]`. Never the inputs, checklists or expected results.

Case ids and digests must be unique across all groups, regression and development cases, and must never have been used as holdout for this skill before.

## Isolation

- A runner receives only the case input and, on the candidate side, the path of the skill folder to read. No checklist, no expected result, no other runs, no conversation history.
- Every run starts from the same environment state. Tools with side effects (sending or moving mail, writing files, calling APIs) run against a sandbox account, fixtures reset between runs, or a recording double; describe it in `policy.evaluation.environment`. Never run exam cases against the user's real data without asking.
- Baseline and candidate use exactly `policy.evaluation`: model, model version, configuration, tools, environment, budget, verifier. Same `seed` and `isolated` value per pair.
- Set `isolated: true` only when the points above hold. A case with `requiresIsolation: true` that cannot be isolated stops the evaluation: tell the user.
- Run each case `policy.repetitions` times per side, with `repetition` from 0.

## Evaluating and submitting

The examiner does all of this; the author only waits for the result.

1. Inputs from the author: `workspacePath`, the full `create` or `improve` response, and the author's `mining` file (create) or `diagnosis` file (improve).
2. Pick the attempt `i` (0 first, then the `nextHoldoutIndex` of the last rejection). Use `evaluationPlan.attempts[i].holdout` plus `evaluationPlan.attempts[i].regression`.
3. Compute `expectedDigest` = `anagenesis digest --path <workspacePath>` once, before the first run. If the digest changes before submit, the author edited the skill: start the evaluation again.
4. Baseline side: create has no skill (`baselineKind: "without_skill"`, `baseVersion`/`baseDigest` null). Improve uses the base version: `anagenesis resolve --skill <id> --version <baseVersion>`, check that `digest` equals `baseDigest`, give runners that `path` (`baselineKind: "revision"`).
5. For every case and repetition: one baseline run and one candidate run, then a fresh judge per answer. `soft` is the share of checklist items met; `outcome` is `pass` when the verifier accepts the answer, else `fail`; `hard` is 1 for pass and 0 for fail. Runs that failed for infrastructure reasons are not evidence: repeat them.
6. Store each answer's exact text in `artifacts`, keyed by its SHA-256 (`anagenesis digest --file`); the run's `artifactDigest` is that key.
7. Write `submit.json` outside the workspace (template: submit-create or submit-improve): new `operationId`, `candidateId`, `expectedDigest`, and `evidenceManifest` with `candidateDigest` = `expectedDigest`, `policyDigest` = `evaluationPlan.policyDigest`, `suiteDigest` = `evaluationPlan.attempts[i].suiteDigest`, `holdoutIndex` = `i`, `authorExposed` (true if the author saw any exam material), the result pairs and artifacts. Add the author's `mining` or `diagnosis` unchanged.
8. Run `anagenesis submit --request submit.json` and return to the author the response plus, per case, `{caseId, split, baselineSoft, candidateSoft}`. Nothing else.

## After a rejection

`rejected` carries `reasons` and `nextHoldoutIndex`. That attempt's holdout cases are burnt: they appear as development cases in later briefs and can never measure this skill again.

- `nextHoldoutIndex` is a number: the author may revise the skill using the reasons and per-case scores (not the answers). The examiner then evaluates on `evaluationPlan.attempts[nextHoldoutIndex]`, with new runs, a new `expectedDigest` and a new `operationId`.
- `nextHoldoutIndex` is `null`: the spare groups are used up. Start a new candidate (`create` again or `improve` from the active version) with fresh cases and a comparable baseline. Never lower thresholds to pass.
- An `EVIDENCE_INVALID` error "Use the next unused precommitted holdout" carries the right index in `details.nextHoldoutIndex`.

What consumes a holdout: every submit that reaches the freeze, including one whose files are invalid (too large, symlinks, unsafe paths, invalid UTF-8). Malformed requests and missing `mining`/`diagnosis` are refused before the freeze and consume nothing.
