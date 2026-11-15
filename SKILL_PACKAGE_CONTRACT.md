# Anagenesis Skills — technical contract of the skill management npm package

Status: the skill lifecycle, store, `submit` gate, JSON CLI, SkillForge mechanisms (§2.2) and Sleep path (§2.1, §5.2) are implemented and tested. [docs/plans/skillopt-sleep.md](docs/plans/skillopt-sleep.md) records the design and owner decisions.
The project is called Anagenesis Skills; the `anagenesis` executable is paired with an equivalent TypeScript API.
Repository: `anagenesis-skills`; candidate npm name `@<scope>/anagenesis-skills`, scope and availability not yet verified. License: MIT.
MUST and MUST NOT denote verifiable requirements.

## 1. Responsibilities and boundaries

Anagenesis Skills combines three parts:

- **Microsoft SkillOpt Sleep** decides how a skill improves: it mines recurring tasks from sessions, replays them, reflects, proposes bounded edits and gates them on a held-out split.
- **SkillForge** decides how failures are diagnosed and how every change is justified.
- **Anagenesis** stores, versions and protects: a dedicated Git store, evidence-gated `submit`, the Sleep wrapper, secret redaction, write isolation and publication.

The calling agent CLI reads briefs and prompts and writes or edits `SKILL.md` in its current session, with its own model and login. It is also the model that answers Sleep prompts.
The package MUST NOT call LLM APIs, start agents or ask for model credentials. It MAY start `git` and, for `sleep` only, a Python ≥ 3.10 interpreter running the vendored Microsoft code; every other operation MUST work without Python.
The flow MUST NOT depend on `/skill`, `$skill-creator`, interactive commands or agent restarts in order to write.
Automatic skill discovery by the host is outside this contract: writing and explicitly reading the candidate work immediately.
Publication paths are `submit`, `restore` and `sleep adopt`. Each publishes when its own checks pass; none introduces an additional human approval.
Installing the npm package and publishing skill revisions are distinct operations; here "publication" means local activation in the store.

## 2. Reused work

### 2.1 Microsoft SkillOpt

Pinned source: [SkillOpt commit 45f65ca04f5f6713bca7b9797b495696ba812751](https://github.com/microsoft/SkillOpt/tree/45f65ca04f5f6713bca7b9797b495696ba812751), MIT.

- **Gate.** `src/gate.ts` is a TypeScript adaptation of the pure `GateResult`, `select_gate_score` and `evaluate_gate` from `skillopt_sleep/gate.py` (byte-identical between the earlier pin `e4ea6a6771e797ef820cdd8bfea64c57e0481065` and `45f65ca`). It keeps hard/soft/mixed metrics, the mixed weight clamped to [0,1], the strictly-greater comparison and the three outcomes accept_new_best/accept/reject. Our wrapper rejects non-finite numbers and unknown metrics; this restriction is not attributed to Microsoft. Parity is proven by fixtures generated from the pinned original, covering ties, regressions, new best, acceptance below best, weight clamping and unknown metrics.
- **Sleep.** The complete `skillopt_sleep` package is vendored unchanged under `vendor/skillopt/` with a per-file SHA-256 manifest and executed with Python using its **handoff** backend: prompts are written to files and answered by the calling agent, so no model is called by the package. Only two upstream parts are replaced, both by Anagenesis code outside the vendor: model backends (replaced by handoff) and per-CLI transcript harvesters (replaced by a generic JSON transcript format supplied by the caller). Experiments and adapters that need real models are vendored for reference only.
- A small Python shim (`python/anagenesis_sleep/`) redirects every upstream write into the store, supplies redacted digests, gives distinct prompt ids per dream rollout and returns crontab content instead of installing it. It never modifies vendored files.

### 2.2 SkillForge

Source: Xingyan Liu et al., [SkillForge, arXiv:2604.08618v2](https://arxiv.org/html/2604.08618v2). No public code exists and the paper text is not redistributable, so its mechanisms are reimplemented in TypeScript with our own wording:

- **Failure Analyzer** (§2.6.1, App. C): feedback MAY carry severities for knowledge, tool usage, clarification and style; the verdict (one high or two medium) and the primary category (highest severity, ties broken knowledge > tool usage > clarification > style) are computed deterministically.
- **Aggregation** (App. C): `improve` groups selected feedback by primary category and selects representative cases.
- **Skill Diagnostician** (§2.6.2, App. E): `submit` MUST carry a diagnosis linking evidence, cause, defect, sections, files, minimal change and expected test. Problems caused by tools, data, environment or execution do not by themselves justify a rewrite.
- **Skill Optimizer** (§2.7): every changed file appears in the diagnosis; a `SKILL.md` above 500 lines or 10,000 characters produces a warning suggesting `references/`, never a rejection.
- **Creator** (§2.4, App. A): the `create` brief follows four stages (workflow, tools, knowledge, synthesis); `submit` of a created skill MUST declare the sources used per stage.

## 3. Non-interactive API and CLI

Every request has `schemaVersion: 1`; complex inputs come from JSON files or stdin and outputs are a single JSON document on stdout.
Logs go to stderr, without credentials; every error carries `code`, `message`, `retryable` and structured details.
Mutations require a UUID `operationId`: same id and same input return the same result; a different input yields `IDEMPOTENCY_CONFLICT`.
The API exposes `create`, `improve`, `submit`, `history`, `restore`, `recordFeedback`, `resolve` and `sleep`; every operation receives the store explicitly.

| CLI                                          | Essential input                                                                               | Result                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `anagenesis create --request request.json`   | skillId, objective, sources, examples, evaluation policy                                      | candidateId, briefPath, workspacePath, evaluationPlan                     |
| `anagenesis improve --request request.json`  | skillId, expectedVersion, feedbackIds, objective                                              | candidate based on the active revision and a diagnostic brief             |
| `anagenesis submit --request request.json`   | candidateId, expectedDigest, evidenceManifest, diagnosis, operationId                         | published with version/commit, or rejected with reasons                   |
| `anagenesis history --skill ID`              | skillId, optional cursor/limit                                                                | revisions of that skill only, provenance and reasons                      |
| `anagenesis restore --request request.json`  | skillId, sourceVersion, expectedVersion, reason, operationId                                  | direct publication of vN+1 with exact historical content and restoredFrom |
| `anagenesis feedback --request request.json` | skillId, version, runId, observation, provenance, optional analysis                           | immutable feedbackId                                                      |
| `anagenesis resolve --skill ID`              | skillId, optional version                                                                     | immutable path, digest, version and commit                                |
| `anagenesis sleep --request request.json`    | action (run, resume, dry-run, harvest, status, adopt, cleanup, schedule, unschedule, evalkit) | night state: pending prompts, idle, staged, rejected, or a publication    |

Errors distinguish INVALID_INPUT, NOT_FOUND, ALREADY_EXISTS, STALE_BASE, EVIDENCE_INVALID, VALIDATION_FAILED, STORE_BUSY, STORE_CORRUPT and IDEMPOTENCY_CONFLICT.
Exit codes: 0 success, 2 input, 3 conflict, 4 failed checks (including a rejected submit or Sleep night), 5 I/O, integrity or missing requirement; no prompts on stdin.
`create` requires an absent skill, `improve` an existing one; both may produce several concurrent candidates without reserving versions.
`expectedVersion` is mandatory for improve/restore; create records a null base and fails if another creation is published first.

## 4. Brief, candidate and content

The brief contains objective, boundaries, audience, sources with URI/revision/digest, domain examples and success criteria.
It includes baseVersion/baseDigest, selected feedback, the frozen policy, development cases, evaluation instructions and the result manifest format.
For create it follows the four SkillForge stages; for improve it includes feedback grouped by primary category, the category → defect map and the diagnosis to complete.
The package may create directories and metadata, but the substantive content of `SKILL.md` is written by the agent.
The candidate workspace contains `skill/SKILL.md`, optional `references/`, `assets/`, `scripts/` and a separate area for brief and evidence.
The publishable skill is the whole `skill/` tree; process metadata and results are never mixed with the instructions.
Text files are UTF-8; the validator checks name/description frontmatter, local references, configured limits and identifier uniqueness.
Absolute paths, traversal, symlinks and special files are rejected; attached scripts are never executed implicitly.
`candidateId` is a UUID, never `vN`; states: draft, rejected, published, stale. A correction after rejection stays unnumbered.
Every submit freezes a snapshot and its digest before verification: later workspace changes cannot alter what gets published.
The SHA-256 tree digest covers a sorted list of paths, types, modes and byte digests; algorithm and normalisation are versioned.

## 5. Evidence and evaluation

### 5.1 `submit`: externally evaluated path

For create the baseline is the same task without the skill; for improve it is the active revision recorded as base. This comparison does not apply to restore.
Baseline and candidate use the same cases, tools, configuration, budget and criteria; model and version are declared by the caller.
The calling agent produces the runs and delivers results; it may use an authorised harness, but the package starts no models or sessions.
A case requiring isolated execution must run in a caller harness; missing isolation must be declared and may invalidate the comparison.
The policy separates development, validation holdout and regression suite; ids and digests of the three sets are frozen before the candidate changes.
Cases used for writing never enter the holdout; holdout prompts, expected answers and detailed results stay with the external evaluator until submit.
If the authoring agent has seen them, the manifest must say so and the gate requires a new holdout; calling a separate file "holdout" is not enough.
The package verifies id/digest separation, coverage and declarations, but cannot by itself certify what the agent's context contained.
Every attempt consumes its holdout: after a rejection the revealed cases become development and a new attempt needs an unexposed set. Checks on the request alone, such as a missing diagnosis or mining declaration, run before the attempt is frozen and consume nothing. Checks on the submitted files (size, symlinks, unsafe paths, invalid UTF-8) run while freezing and do consume the holdout: the evaluator has already run the holdout cases against those files, so the cases are exposed whatever the outcome.
The policy fixes, before the work, minimum sample size, repetitions, hard/soft aggregation, absolute thresholds and regression tolerances.
No threshold can be lowered at submit; a new policy requires a new candidate and a comparable new baseline.
For create/improve the Microsoft gate compares the candidate score with the baseline, both recomputed on the same holdout.
The historical best is comparable only under an identical evaluation fingerprint; otherwise it starts from the baseline.
Improvement must be strictly positive, meet the absolute thresholds and violate no regression-suite constraint.
For create/improve ties or regressions do not publish; restore verifies integrity, format, provenance and expected base, without measured improvement or an evaluation manifest.
Infrastructure errors produce incomplete evidence, never successes or zero scores usable to favour the candidate.
Structural checks and the gate are deterministic and local; deterministic tests are explicit commands allowed by the policy, never shell taken from the skill.

The manifest contains candidateDigest, baseVersion/baseDigest, policyDigest, suiteDigest and, for each case, baseline and candidate runs:
runId, caseId, split, inputDigest, output/artifactDigest, outcome, hard/soft, verifierId/version, timestamp, producer, declared model and configuration.
It also includes tools/environment, seed when available, machine/human/agent origin, a non-sensitive sessionId and isolation/exposure attestations.
Derived scores are recomputed from verifiable results; external judgements remain attributed attestations, never independent measurements invented by the package.
Missing, duplicated, mismatched-digest or stale-base results block publication.

### 5.2 Sleep: self-evaluated path

Sleep follows Microsoft's cycle unchanged: tasks mined from transcripts and feedback, a deterministic train/held-out split, replay, reflection with at most `edit_budget` edits, re-evaluation on the held-out split and Microsoft's gate. Defaults are Microsoft's (gate on, `auto_adopt` off).
Tasks and scores come from the same model that proposes the edits, so this held-out is weaker than §5.1. Sleep revisions are labelled `kind: "sleep"` in history and the rules of §5.1 apply only to `submit`, which is unchanged.
A night needs at least 3 tasks mined by the model; otherwise it is idle. Nothing starts without an explicit `sleep run` and nothing publishes without an explicit `sleep adopt`.
Each night has its own state machine, input digest and pinned bases; terminal resumes never relaunch a round. A staged adoption runs upstream’s adopt command once more, then publishes through the store. The package cannot verify that prompts were answered in clean contexts; this remains an instruction to the caller.

The JSON `sleep` action union also includes `cleanup`. Requests pin zero to 32 distinct skills; an empty list selects `skillopt-sleep-learned`. Multiple pins enable Microsoft's fan-out and per-skill gates, driven by transcript `skillsUsed` hints. Anagenesis materializes all pinned bases at every round, and never adopts an unpinned target. Configuration keys are explicitly allowlisted; backend, paths and upstream `auto_adopt` cannot be set by callers. `slow_update` is accepted only as `false`.

Adopt holds the night and skill locks, checks active bases (`STALE_BASE` on movement), and executes the unchanged upstream adoption with an isolated HOME, TMPDIR, project and shared state directory. An exclusive upstream lock is removed only when its recorded PID is demonstrably dead. An upstream “already adopted” result succeeds only with matching adoption receipts, proposal hashes, live bytes and backups. Publication receipts derived from sleepId + skillId recover interrupted multi-skill publication without creating duplicate revisions. Only `SKILL.md` may change; all other files, modes and directories remain equal to the pinned snapshot.

Sleep metadata records sleepId, upstream pin, configuration, pinned base, gate and scores, edits, report summary, content hashes and feedbackIds. Policy and sources are inherited; the managed skill's initial revision uses a declared default policy and upstream source. A memory-only night publishes no revision. Upstream adopts `CLAUDE.md` in the isolated project, and the response returns `adoption.memory: { label, text, baseSha256 }` for the caller to apply. `baseSha256` hashes the exact memory text supplied to the night, or empty text when omitted. Memory never becomes a skill file.

After adoption, the night is recorded as `adopted` and automatically cleaned to `cleaned`; retries return the same `adoption.publications` and optional memory proposal. Cleanup removes all bulky per-night data and keeps only run.json (with the retry response) and report.json (scores, gate, hashes and publication references). Explicit cleanup also accepts rejected, idle and reported nights. `status` with `prune: true` cleans eligible terminal nights after `retentionDays` (default 30); pending and staged nights remain intact. The shared redacted state.json task archive remains for recall.

Schedule and unschedule execute upstream through the shim, with the crontab redirected to `<store>/sleep/schedule/crontab`. The runner command is provided by the caller; the caller installs the returned `crontab` content. Anagenesis never executes the real crontab binary or installs a scheduler job. Evalkit passes caller-provided manifest and A/B (or A/A) outcome files to upstream’s statistical comparison, returning its JSON report without altering the nightly gate.

## 6. Feedback and provenance

Feedback is append-only and references skillId, the version actually used, artifactDigest, runId, producer, timestamp and source.
It contains observation, expected/actual result, evidenceRefs, category, possible cause and optional SkillForge severities; it separates observed fact from the agent's interpretation.
When the version is unknown it stays an unassigned signal and is never attributed automatically to the active version.
A revision records feedbackIds, sources, declared agent/model author, reason, diff and verification report; no credentials are stored.
Late feedback on v1 stays on v1 even when v2 is active; the agent decides and justifies whether the problem persists.
Corrections add events that semantically supersede the wrong event without erasing its provenance. A correction with `disposition: "not_skill"` marks the problem as not caused by the skill and keeps it out of Sleep.

## 7. Local store, revisions and restore

Explicit configuration: an absolute `storePath` outside the package source repository and candidate workspaces.
The store owns a dedicated local Git repository without remotes; every write verifies this and never pushes, fetches or pulls.
A resolved path that falls inside the source or reuses its `.git` is rejected; the package never touches the caller's index, branches or commits.
Every skill has its own ref `refs/skills/<skillId>`: the publication commit contains the full snapshot, metadata and the submit/restore/sleep receipt of that skill only.
The parent is the previous publication of the same skill; history does not depend on the global log of other skills.
Git objects and revisions are immutable; workspaces, feedback events and Sleep nights live in separate store areas.
`version` is a positive integer shown as v1, v2, v3; `skillId`, `candidateId`, commit and `restoredFrom` are distinct fields.
The first publication is v1; every following publication is exactly lastVersion+1, regardless of the size of the change.
Drafts, failed tests, rejections, Sleep nights and preparatory commits unreachable from the ref consume no public numbers.
A `sleep` revision inherits policy and sources from its base; Microsoft's managed skill starts with a declared default policy and the pinned upstream URI as source.
Restore reads the whole historical skill from the store and publishes directly after verifying integrity, format, provenance and expected base; it keeps sourceVersion/sourceDigest and a mandatory reason.
Example: with v2 active, an accepted restore of v1 → v3, `restoredFrom: 1`, parent v2, separate reason; v1 and v2 remain in history.
Restored content keeps the original digest; the metadata of the new publication live outside the skill tree.
No Git reset, retroactive renaming or change to other skills; restore exposes no editable candidate. Any change to historical content goes through improve.
Sleep night data (digests, prompts, answers, staging, evidence) is deleted after adopt; a report with scores, gate and hashes remains.

## 8. Concurrency, crashes and activation

The store supports a local filesystem with locks and atomic renames; distributed filesystems are unsupported without a verified transactional adapter.
Every submit/restore/adopt takes a per-skill lock and rechecks baseVersion/baseDigest; a contended lock yields STORE_BUSY without consuming versions.
Locks are operating-system locks released when the process dies, never timeout files that could expire during a valid write.
A changed base yields STALE_BASE: submit needs a new candidate and evaluation; restore and Sleep need a new request with the updated base and a new operationId, never a silent merge.
Expensive checks may precede the lock on the immutable snapshot; under the lock digests, base, receipts and policy are rechecked.
Only then is N+1 computed, the commit written with its operationId/inputDigest receipt and the ref updated with compare-and-swap on the expected commit.
The atomic, durable ref update is the only publication point: number, content and metadata become visible together.
Objects and directories are synced to disk before the ref; the Git configuration must provide the required durability on the supported filesystem.
A failed CAS does not publish the prepared commit and reserves no number; the retry rereads state and applies the base check.
Crash before the ref: nothing published; crash after the ref: the revision is published and recoverable through the commit receipt even without a client response.
Retries look up the operationId in the skill chain, even if later revisions exist; they never create duplicates.
Sleep nights use their own lock, a store-wide lock around shared Sleep state and per-night directories; a multi-skill adopt uses one derived operationId per skill so a partial crash resumes the missing skills.
`resolve` reads a single ref and returns an immutable materialised snapshot: readers see either the old or the new revision entirely.
Materialisation uses a temporary directory and rename; an incomplete cache is rebuilt from Git and is never a source of truth.
Garbage collection of orphan objects happens only when no operation is running and never alters published history.

## 9. README attribution text

> This package prepares and verifies skill revisions written by the calling agent CLI, in its session and with its model/login. It never invokes models by itself.
>
> It includes a TypeScript adaptation of the pure `select_gate_score` and `evaluate_gate` functions and the unchanged Microsoft SkillOpt `skillopt_sleep` package, executed with Python through its handoff backend, both from commit `45f65ca04f5f6713bca7b9797b495696ba812751`, with attribution and the MIT license.
>
> It reimplements the SkillForge mechanisms (Liu et al., arXiv:2604.08618v2) for failure analysis, diagnosis, scoped optimisation and staged creation; no SkillForge code or text is reused.
>
> Input validation, regressions, provenance, versioning and transactions are this project's responsibility. Runs and result attestations come from the caller; the package does not certify judgements or isolation on its own. It is not a Microsoft product and implies no endorsement by the cited authors.

## 10. Acceptance criteria

- An agent completes create → file writing → submit in the same session, without extra logins, special commands, restarts or package LLM calls.
- The gate port passes parity fixtures on the pinned SHA; attribution, the vendored Microsoft code and its license ship in the npm tarball, without `__pycache__`.
- Create beats the skill-less baseline; improve beats the active one; ties, regressions or incomplete evidence never publish on these paths.
- Contaminated holdout, non-finite metrics, changed digest, incompatible baseline, altered policy and missing diagnosis produce verifiable errors; a missing diagnosis consumes no holdout.
- Feedback and history keep version and provenance; history/restore of one skill never change the others.
- Two concurrent publications on the same base produce one new version; the other gets STALE_BASE, possibly after STORE_BUSY and a retry. Different skills publish independently.
- Fault injection before/after every commit, ref and materialisation phase shows no gaps, collisions, double publications or partial snapshots.
- A retry after a lost response finds the receipt; restore from v2 to v1 publishes v3 with exact content, reason and restoredFrom, even if the suite prefers v2.
- A Sleep night driven by the real vendored Python and scripted answers reaches staged; concurrent nights, a killed Python child and malformed answers converge; no file is written outside the store; adopt publishes a `sleep` revision that does not affect other skills' receipts.
- Every operation except `sleep` works without Python; no operation mutates the source repository, configures remotes or pushes.
