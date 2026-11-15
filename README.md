# Anagenesis Skills

TypeScript package and CLI for preparing, verifying and publishing **local skill revisions**. Anagenesis combines three parts:

- **Microsoft SkillOpt Sleep** improves skills from real sessions: it mines recurring tasks, replays them, reflects and gates bounded edits.
- **SkillForge** diagnoses failures and requires every change to be justified.
- **Anagenesis** stores, versions and protects: a dedicated Git store, evidence-gated publication, provenance and crash-safe transactions.

The calling agent writes `SKILL.md` in its own session, with its own model and login, and is also the model that answers Sleep prompts. Anagenesis keeps the evidence and applies deterministic checks; it never calls LLM APIs, never starts agents and never runs the scripts attached to a skill.

It implements the [technical contract](SKILL_PACKAGE_CONTRACT.md). Publishing a revision means activating it in the local store, not publishing a package to npm.

> **Status.** The skill lifecycle, store, `submit` gate, SkillForge mechanisms and the complete Sleep command are implemented and tested. Sleep executes Microsoft’s vendored Python code through a separate Anagenesis shim. See [the implementation plan](docs/plans/skillopt-sleep.md) for the design and owner decisions.

## Quick start

Requirements: **Node.js 22+**, **Git 2.36+**, macOS or Linux, a local filesystem with `flock`, atomic rename and `fsync`. The native `fs-ext` binding may need a C/C++ compiler and Python during `npm install`. NFS, SMB and distributed filesystems are not supported. Python ≥ 3.10 is required only by `sleep`, with no pip packages. Set `ANAGENESIS_PYTHON` to select an interpreter, or use Python on `PATH`. Every other command works without Python; Python-dependent tests skip when it is unavailable.

```sh
npm ci
npm test
npm run build
node dist/cli.js --help
node examples/workflow.mjs
# Requires Python 3.10+: real Sleep with scripted answers
node examples/sleep.mjs
```

The examples use synthetic attestations or scripted answers, create temporary stores outside the repository and print the published revisions. They demonstrate the local workflows, without measuring real model improvement. The printed paths let you inspect the stores; the directories stay until you remove them. Both examples accept an absolute store path as their first argument.

To install the package locally:

```sh
npm pack
npm install -g ./anagenesis-skills-0.1.0.tgz
anagenesis --help
```

The name `anagenesis-skills` is provisional: npm availability and scope are unverified. The package is MIT-licensed and still `private: true` until a public name is chosen. Nothing has been published to npm.

## Agent flow

1. Prepare a `create` request, or an `improve` request with `expectedVersion` and the selected `feedbackIds`. Objective, sources, examples, audience, boundaries, criteria and policy are explicit.
2. Read the returned `briefPath`. Write or edit `workspacePath/SKILL.md`, without extra logins or restarts. Create prepares the directory; it does not invent the skill content. Improve copies the whole tree of the base revision.
3. Have your evaluator score baseline and candidate on the same cases with identical settings. The package does not orchestrate these runs.
4. Compute the tree digest and send `submit` with manifest and evidence. A `published` outcome carries version and commit; `rejected` carries reasons and the index of the next available holdout.
5. Use `resolve` to read the snapshot of the active revision or of a specific version.

Complete requests and manifest construction are in the [runnable example](examples/workflow.mjs); the exported types and the [schemas](src/schemas.ts) describe every field. Objects reject unknown properties: an alternative policy cannot be passed to `submit`.

## TypeScript API

Every operation receives a store explicitly. Pass `{ storePath }` or reuse a `Store` instance to avoid reinitialising between calls.

```ts
import {
  Store,
  create,
  improve,
  submit,
  history,
  restore,
  recordFeedback,
  resolve,
  snapshotTree,
  type CreateRequest,
  type Manifest,
} from "anagenesis-skills";

const store = await Store.open({ storePath: "/absolute/path/skill-store" });
const candidate = await create(store, request satisfies CreateRequest);
// The agent reads candidate.briefPath and writes into candidate.workspacePath.
const { digest } = await snapshotTree(candidate.workspacePath);
const result = await submit(store, {
  schemaVersion: 1,
  operationId: crypto.randomUUID(),
  candidateId: candidate.candidateId,
  expectedDigest: digest,
  evidenceManifest: manifest satisfies Manifest,
});
```

`request` and `manifest` in the excerpt stand for the caller's inputs; for a standalone program use the complete example. All operations are asynchronous. The API throws `AnagenesisError` with `code`, `message`, `retryable`, `details` and `toJSON()`.

| Operation        | Specific input                                                                              | Result                                           |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `create`         | absent skill, brief and policy                                                              | candidate UUID, paths, null base, plan           |
| `improve`        | existing skill, `expectedVersion`, `feedbackIds`, brief and policy                          | candidate from the pinned base, diagnostic brief |
| `submit`         | `candidateId`, `expectedDigest`, `evidenceManifest`, diagnosis (improve) or mining (create) | `published` or `rejected`                        |
| `history`        | `skillId`, `cursor?`, `limit?` (default 20, maximum 100)                                    | revisions newest first and `nextCursor`          |
| `restore`        | `skillId`, `sourceVersion`, `expectedVersion`, `reason`, `author`                           | new revision with exact historical content       |
| `recordFeedback` | used version/digest, or both `null`, observation and provenance                             | immutable event and `feedbackId`                 |
| `resolve`        | `skillId`, `version?`                                                                       | snapshot path, digest, version and commit        |

Every request has `schemaVersion: 1`; lifecycle mutations and Sleep `run`, `dry-run` and `adopt` require a UUID `operationId`. Sleep continuation and utility actions use the fields described below. Reuse **the same id and the same input** after a lost response. A different input with the same id yields `IDEMPOTENCY_CONFLICT`. Rejections are idempotent too: a correction uses a new id and a new holdout.

## JSON CLI, no prompts

```sh
anagenesis create --store /absolute/path/skill-store --request create.json
anagenesis improve --store /absolute/path/skill-store --request improve.json
anagenesis submit --store /absolute/path/skill-store --request submit.json
anagenesis feedback --store /absolute/path/skill-store --request feedback.json
anagenesis restore --store /absolute/path/skill-store --request restore.json
anagenesis history --store /absolute/path/skill-store --skill demo-skill --limit 10
anagenesis resolve --store /absolute/path/skill-store --skill demo-skill --version 1
cat create.json | anagenesis create --store /absolute/path/skill-store --request -
```

Stdout carries a single JSON document; diagnostics are never mixed with results. There are no interactive prompts on stdin. The CLI JSON limit is 32 MiB.

| Exit code | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| 0         | Success                                                              |
| 2         | `INVALID_INPUT`                                                      |
| 3         | `ALREADY_EXISTS`, `STALE_BASE`, `STORE_BUSY`, `IDEMPOTENCY_CONFLICT` |
| 4         | `EVIDENCE_INVALID`, `VALIDATION_FAILED`, submit `rejected`           |
| 5         | `NOT_FOUND`, I/O, `STORE_CORRUPT`                                    |

Errors look like `{"error":{"code":"…","message":"…","retryable":false,"details":{}}}`. `STORE_BUSY` can be retried with the same request; `STALE_BASE` needs a new candidate and evaluation, or a new restore request with the updated base and a new id.

## Policy and evidence

The policy freezes, before writing:

- development cases with prompt and expected result;
- one or more ordered holdouts, described only by id, input digest and isolation requirement;
- regression suite, repetitions, minimum sample size and `mean` aggregation;
- `hard`, `soft` or `mixed` metric, weight, absolute thresholds and regression tolerances;
- model/version, configuration, tools, environment, budget and verifier/version;
- limits on file count and size.

Input ids and digests are unique across all sets, including the holdouts of future attempts. For create the baseline has no skill; for improve it is the base revision. The manifest contains baseline/candidate pairs for every case and repetition of holdout and regression. Each run includes identifiers, digests, outcome, scores, timestamp, producer, origin, session, nullable seed and declared isolation.

Artifacts are UTF-8 strings in `artifacts`, keyed by their SHA-256: the package verifies the bytes and recomputes the means. `hard` must be 1 for `pass` and 0 for `fail`; `soft` is in [0,1]. Outcomes and judgements of the external verifier remain **attributed attestations**, not independent measurements certified by Anagenesis. An `infrastructure_error` makes the evidence incomplete.

Holdout improvement must be strictly positive, meet the absolute thresholds and respect every per-case/repetition regression constraint. The historical best is compared only under an identical policy and suite fingerprint. A tie does not publish.

The external evaluator keeps holdout prompts, expected answers and detailed results until submit. `authorExposed: true` blocks publication; the package verifies declarations and separation but cannot certify what the agent saw. Every attempt that freezes a snapshot consumes its holdout even when it fails. The next attempt uses the next frozen index, without lowering thresholds; when the sets run out, a new candidate and a comparable new baseline are needed. Consumed cases never become holdout again for the same skill and are listed as development in later briefs.

Improve requires a diagnosis linked to feedback, development cases or source URIs: `evidenceIds`, `cause`, `category`, `sections`, `minimalChange`, `expectedTest`. At least one cause must be attributed to the skill. Tool, data, environment or execution errors alone do not justify a rewrite.

## SkillForge

SkillForge has no public code, so its mechanisms are reimplemented in [src/forge.ts](src/forge.ts):

- feedback can carry severities for knowledge, tool usage, clarification and style; the failure verdict and primary category are computed deterministically;
- `improve` groups feedback by primary category in the brief;
- `submit` always requires a diagnosis that names the defect and every changed file, and `create` submissions declare the sources used in each of the four creation stages;
- a `SKILL.md` above 500 lines or 10,000 characters returns a warning suggesting `references/`, never a rejection;
- feedback corrected with `disposition: "not_skill"` (allowed only with `supersedes`) is excluded from Sleep.

A missing or incomplete diagnosis or mining declaration is refused with `EVIDENCE_INVALID` before the holdout attempt is frozen, so it consumes no holdout.

## Sleep

`anagenesis sleep --store /absolute/store --request request.json|-` runs the unchanged Microsoft `skillopt_sleep` package with Python and its handoff backend. All actions use this one JSON entry point; `sleep resume` and `sleep adopt` below refer to the request's `action` field. The package never calls a model.

Start a night with a UUID and generic transcripts:

```json
{
  "schemaVersion": 1,
  "action": "run",
  "operationId": "b229cc5d-a818-4d13-9c8b-07c71f5343ee",
  "author": {
    "producer": "my-agent",
    "model": "my-model",
    "modelVersion": "1"
  },
  "skills": [{ "skillId": "release-notes", "expectedVersion": 2 }],
  "transcripts": [
    {
      "sessionId": "release-session",
      "project": "/work/project",
      "userPrompts": ["Write release notes"],
      "assistantFinals": ["An incomplete draft"],
      "feedbackSignals": ["Missing the summary"]
    }
  ],
  "memory": { "label": "project-memory", "text": "Current CLAUDE.md contents" },
  "config": { "edit_budget": 4, "dream_rollouts": 1, "recall_k": 0 }
}
```

`skills: []` selects Microsoft's managed skill, `skillopt-sleep-learned`, and can create its first revision. Requests may pin up to 32 distinct skills; multiple targets enable upstream's independent per-skill gates using transcript `skillsUsed` hints. The first skill is also the primary target of the ordinary cycle. Every base is materialized from Git at each round. Configuration is a strict allowlist of upstream keys; paths, backend and `auto_adopt` cannot be overridden. `slow_update` accepts only `false`.

| Action           | Request fields beyond `schemaVersion` and `action`                                                                 | Result                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `run`, `dry-run` | `operationId`, `author`, `transcripts`, optional `skills`, `memory`, `config`                                      | `pending`, `staged`, `rejected`, `idle`, or `reported` for dry-run                         |
| `resume`         | `sleepId`                                                                                                          | Next handoff round or the saved terminal result                                            |
| `status`         | Optional `sleepId`, `prune`, `retentionDays` (default 30)                                                          | One night or a list; prune cleans eligible terminal nights older than the retention period |
| `harvest`        | `transcripts`, optional `skills`, `config`                                                                         | Eligible feedback merged into the supplied transcripts, without running a night            |
| `adopt`          | `operationId`, `sleepId`, `author`                                                                                 | `cleaned`, with `adoption.publications` and optional `adoption.memory`                     |
| `cleanup`        | `sleepId`                                                                                                          | Idempotently delete bulky data from adopted, rejected, idle or reported nights             |
| `schedule`       | Absolute `project`, caller's `runner` command, optional `hour` (3), `minute` (17)                                  | Store-only `crontabPath` and `crontab` content                                             |
| `unschedule`     | Absolute `project`, optional `all: true`                                                                           | Updated store-only crontab                                                                 |
| `evalkit`        | Absolute file paths `manifest`, `a`, and either `b` or `aa: true`; optional `alpha`, `boot`, `seed`, `allowGraded` | Upstream paired comparison in `result`                                                     |

For each `pending` response, read `pending.pendingPath` / `promptsPath` and answer every prompt in a clean context. Write each indicated `answer_file` atomically (temporary file plus rename), then request `resume` with the same `sleepId`; do not resend transcripts. JSON answers are validated before Python runs. Defaults follow Microsoft: gate on, explicit adoption, at least 3 model-mined tasks. Fewer tasks produce `idle`. A terminal resume returns its saved result.

For `staged`, review the report and proposal files under `result.staging_dir`, then request `adopt`. Upstream applies the pinned proposal under the skill locks; Anagenesis snapshots and validates the resulting skill tree. Only `SKILL.md` may change. Existing skills publish v N+1 with inherited policy and sources; the managed skill can start at v1 with a declared policy. Provenance includes the upstream pin, configuration, gate, scores, edits, report, hashes and feedback ids. A moved base returns `STALE_BASE`. Adoption is idempotent per night, including recovery after upstream adoption or a partial multi-skill publication.

A memory proposal is applied by upstream in the isolated project and returned as `adoption.memory: { label, text, baseSha256 }`. The hash identifies the exact memory text supplied to the night (empty text when omitted). The caller checks its own file against that hash and applies the proposal; memory is never added to the skill snapshot. Memory-only adoption publishes no revision.

Adoption automatically moves through `adopted` to `cleaned`. Cleanup leaves `run.json` (including the adoption response for retries) and `report.json` with scores and hashes. It deletes home, temporary files, projects, staging, handoffs and answers. The shared redacted task archive under `sleep/state/.skillopt-sleep/state.json` remains for recall. `status` with `prune: true` also cleans rejected, idle and reported nights after the retention period; pending and staged proposals are retained.

Scheduling calls upstream through the shim, writes only `<store>/sleep/schedule/crontab`, and never invokes the real `crontab` binary. The caller supplies a cron-compatible runner command and installs the returned content itself. No job is installed or executed by Anagenesis.

Evalkit consumes upstream JSON formats: a manifest such as `["task-1", "task-2"]` and outcome maps such as `{"task-1": 0, "task-2": 1}`. For example, use `{"schemaVersion":1,"action":"evalkit","manifest":"/tmp/tasks.json","a":"/tmp/a.json","b":"/tmp/b.json","boot":10000}`. It returns Microsoft's McNemar and bootstrap comparison without changing the nightly gate.

Run `npm run build && node examples/sleep.mjs` for an offline demonstration with real Python and a scripted responder.

Revisions published by Sleep rely on a held-out split generated by the same model that proposes the edits, so they carry weaker guarantees than `submit` and are labelled in history.

## Skills, digests and feedback

The publishable snapshot is the whole `skill/` tree, including references, assets, scripts and empty directories. Brief, manifest and metadata live outside the tree. `SKILL.md` requires YAML frontmatter with `name` equal to the `skillId`, a non-empty `description` and a non-empty body. Skill ids use lowercase ASCII letters, digits and hyphens, at most 64 characters.

The validator checks UTF-8 for recognised text formats, inline and reference-style local Markdown links, sizes, and duplicate or case-colliding names. It rejects absolute paths, traversal, `.git`, special files and **all symlinks**, internal ones included. Scripts are kept as files and never executed.

Algorithm `anagenesis-tree-v1`: POSIX NFC paths sorted by UTF-8 bytes; canonical JSON with sorted keys, `algorithm` and `entries`. Each entry holds path, type, normalised mode (`100644`, `100755`, `040000`) and the SHA-256 of the bytes; for directories the digest is that of the empty string. The final digest is the SHA-256 of that JSON. Timestamps, owner and write permissions are excluded; file bytes are not normalised.

Feedback is append-only. Late feedback on v1 stays on v1 even when v2 is active. An unknown version uses `version: null`, `artifactDigest: null` and stays `unassigned`. `supersedes` adds a correction without deleting the original event. Observation, expected/actual and possible cause stay separate. Never put credentials in briefs, configurations or evidence.

## Store, concurrency and restore

`storePath` must be absolute and outside the package repository, any other Git checkout and candidate stores/workspaces. Paths are resolved through symlinks too. The store holds a **dedicated bare repository without remotes** and never uses the caller's index or branches. Inherited Git variables are excluded; there are no push, pull or fetch commands.

```text
store/
  anagenesis-store.json
  repo.git/           # single source of truth for publications
  operations/         # receipts and idempotent intents
  candidates/         # metadata kept apart from the agent's files
  workspaces/<uuid>/  # brief.json and skill/
  attempts/           # frozen snapshots and consumed holdouts
  feedback/           # append-only events
  locks/              # persistent files; actual locks live in the kernel
  cache/<commit>/     # read-only, rebuildable materialisations
```

Each skill uses `refs/skills/<skillId>`. The commit contains the whole tree, provenance, diff, report and receipt; the parent is the previous publication of the same skill. There is no separate counter: v1, v2, v3 are assigned only by the atomic compare-and-swap update of the ref. Git uses `core.fsync=all` and `core.fsyncMethod=fsync`.

`flock` locks are non-blocking, separate per operation and skill, and released by the kernel when the process dies. For simplicity submit checks stay under the skill lock: different skills progress independently, while a second mutation of the same skill gets `STORE_BUSY`. A CAS/base conflict reserves no version.

Crash before the ref: nothing is published. Crash after the ref: the commit receipt recovers the result, even after later publications. Attempt snapshots and preparations are reconciled on retry. `resolve` pins a ref and materialises from Git through a temporary directory and rename; an incomplete or corrupted cache is rebuilt. Returned paths are read-only; do not modify them. This protection does not stop the filesystem owner from tampering with the store.

Restore creates no editable candidate and needs no evaluation manifest: it verifies content, format, provenance and expected base. With v2 active, restoring v1 publishes **v3**, with parent v2, `restoredFrom: 1`, `sourceDigest` and reason. The skill digest exactly matches v1, even when the evaluation preferred v2. To change historical content use improve.

This version offers no export to host directories and no automatic garbage collection: quarantined caches, snapshots and orphan objects can take space. Crash tests simulate process death, not physical disk failure; durability depends on the guarantees of the supported filesystem and hardware.

## Tests, maintenance and size

```sh
npm run check          # formatting, strict compilation, Node tests
npm run test:coverage  # native Node coverage
npm run fixtures       # development only: regenerate fixtures with Python 3
npm pack --dry-run     # check the distributed files
```

Tests use `node:test`, temporary stores and real processes. They cover Microsoft parity, create/improve/restore, feedback, rejections, tampered inputs and evidence, digests, assets and executable modes, isolation from the source store, cross-process concurrency, lock release after `SIGKILL`, and recovery of receipts and materialisations. CI runs Node 22/24 on Linux and macOS. No models, credentials or external services are needed.

Three runtime dependencies: `fs-ext` for system locks, `yaml` for frontmatter and `zod` for schemas. No CLI framework, database or server. TypeScript, types and Prettier are development dependencies only.

## Attributions

The TypeScript port of the pure `select_gate_score` and `evaluate_gate` functions derives from **Microsoft SkillOpt** `skillopt_sleep/gate.py`, commit [`e4ea6a6771e797ef820cdd8bfea64c57e0481065`](https://github.com/microsoft/SkillOpt/tree/e4ea6a6771e797ef820cdd8bfea64c57e0481065) (identical at the Sleep pin `45f65ca`). Status: **port implemented; 108 parity fixtures generated from the original and verified on every field**, including ties, regressions, new best, acceptance below best and weight clamping. The original, the SHA in the fixtures and the Microsoft MIT license ship in the tarball. The complete `skillopt_sleep` package is vendored unchanged and executed for the `sleep` command.

The SkillForge mechanisms come from [Liu et al., arXiv:2604.08618v2](https://arxiv.org/html/2604.08618v2), §§2.4, 2.6–2.7 and appendices A, C and E; they are reimplemented without reusing code or text.

Validation, regressions, provenance, versioning and transactions are this project's responsibility. Runs and attestations come from the caller; the package does not certify judgements or isolation on its own. This is not a Microsoft product and implies no endorsement by the cited authors. Details in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE). Vendored Microsoft code keeps its own MIT license in [vendor/skillopt/LICENSE](vendor/skillopt/LICENSE).
