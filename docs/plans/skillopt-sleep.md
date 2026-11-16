# Plan: Anagenesis Skills = SkillForge + Microsoft `skillopt_sleep` run in Python

Status: approved direction, not yet implemented. Sources read and exercised on 15 November 2026.
**[V]** = verified against the source or by running it; **[I]** = inference or a choice made by this plan.
Revision 3: incorporates the adversarial review (Opus, 15 November 2026) and the owner's decisions.

## 0. Owner decisions (binding)

- The project is **SkillForge + the complete Microsoft `skillopt_sleep`**. The current contract, README and notices understate this and are rewritten (step 1).
- Microsoft's code is **executed unchanged from `vendor/`**, never translated. Anagenesis (TypeScript) is the wrapper, store and versioning layer. It stays an **npm package**.
- The model is the calling agent CLI's own AI: Sleep runs with the **handoff** backend. Anagenesis never calls an LLM.
- Transcripts arrive in a **generic JSON format** converted by the caller; no per-CLI harvesters.
- Sleep follows Microsoft: explicit `run`, explicit `adopt`, `auto_adopt` off, Microsoft's self-generated held-out and gate. `submit` remains the separate, externally evaluated path.
- At least **3 mined tasks** before proposing edits; otherwise `idle`.
- **Feedback triage**: feedback marked `not_skill` never re-enters Sleep.
- `slow_update`: exposed, off by default. Experiments and `adapters/superpowers.py`: vendored as reference only.
- `dream_rollouts > 1`: our documented deviation, distinct prompt ids per rollout (shim).
- Night data is deleted after `adopt`; `report.json` with scores, gate and hashes remains.
- SkillForge diagnosis is **always required** on `submit`; the 500-line / 10,000-character `SKILL.md` limit is **a warning, never a rejection**.
- **All documentation in English. License: MIT.**

## 1. Facts

### 1.1 SkillForge

- **[V]** [arXiv:2604.08618v2](https://arxiv.org/html/2604.08618v2) links no code, artifact or dataset; no author repository exists. [SlanchaAI/ingot](https://github.com/SlanchaAI/ingot) is an unofficial third-party reimplementation, not examined.
- **[V]** The paper is under the arXiv perpetual non-exclusive license: the judge prompt (App. D) cannot be copied.
- **[V]** Failure verdict: one high or two medium severities. Primary category = highest severity; the order knowledge > tool > clarification > style breaks ties only (App. C). Creator has four stages (§2.4, App. A). Category → defect map in Table 4.
- **[V]** The 500 lines / 10,000 characters threshold is where detail "is moved to reference files" (App. A, E), not a rejection rule.

### 1.2 Microsoft `skillopt_sleep` at pin `45f65ca`

Pin [`45f65ca04f5f6713bca7b9797b495696ba812751`](https://github.com/microsoft/SkillOpt/tree/45f65ca04f5f6713bca7b9797b495696ba812751) (current upstream HEAD), MIT, `requires-python >= 3.10`. `gate.py` is byte-identical to the current pin `e4ea6a6`. **[V]**

- **Standard library only** with the handoff backend: all 45 modules import under `python3.10 -S`; a full handoff night reaches `staged`; the mock experiment exits 0. **[V]**
- **Commands**: `run`, `dry-run`, `status`, `adopt`, `harvest`, `schedule`, `unschedule`, `evalkit` (not `eval`; needs `--manifest` and `--a/--b` or `--aa`). **[V]**
- **Handoff**: `pending.json` (`skillopt_sleep.handoff.v1`), `PROMPTS.md`, `answers/<id>.md`; exit 3 while prompts remain. Prompt ids are stable across runs, Python versions and `PYTHONHASHSEED`. If `handoff/digests.json` exists, harvest is skipped. At the end of a night the directory is renamed `handoff.nightN.done`. **[V]**
- **Exit 0 with empty stdout** when zero tasks are mined. Relaunching after a finished night starts a new empty night and advances the harvest cursor. **[V]**
- **Redirectable writes**: `SKILLOPT_SLEEP_HANDOFF_DIR`, `SKILLOPT_SLEEP_PROMPTS_PATH`, `HOME` + `--claude-home` (state and config), `--project` (staging, evidence, `CLAUDE.md`), `--target-skill-path`. **Not redirectable without the shim**: `crontab` (also `_have_crontab`), `__pycache__` inside the vendor, adopt locks in `tempfile.gettempdir()`. **[V]**
- **Shared state is unlocked**: `SleepState.save` uses a fixed `state.json.tmp` (state.py:149-154); each round re-reads the live skill and memory (cycle.py:813-826) and recomputes split protection from state. **[V]**
- **Adopt locks** are O_EXCL files (staging.py:1768-1800) left behind by a kill; a second adopt of the same night exits 2 "already adopted". **[V]**
- `HandoffBackend.attempt` is inherited from `CliBackend.attempt`; `attempt_with_tools` gets no `sample_id`. Rollouts collapse with `dream_rollouts > 1`. **[V]**
- On the handoff path only `holdout_fraction` (0.34) is used: `val_fraction` and `test_fraction` have no effect. `slow_update` is not wired into the cycle (only `experiments/run_gbrain.py`). **[V]**
- Rubric tasks need an attempt and then a judge, so one round answers about one attempt: 6 tasks took 18 rounds, each leaving an orphan staging directory. **[V]**
- A non-JSON miner answer silently falls back to heuristic tasks (`reference_kind: "none"`); a non-JSON judge answer scores 0. **[V]**

## 2. Architecture

| Part                                                              | Where                                                                                                    | Language   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------- |
| Microsoft Sleep, unchanged                                        | `vendor/skillopt/skillopt_sleep/`, `LICENSE`, `MANIFEST.json` (SHA-256 per file, `__pycache__` excluded) | Python     |
| Our shim, outside the vendor                                      | `python/anagenesis_sleep/`                                                                               | Python     |
| Wrapper: schemas, night state machine, child process, publication | `src/sleep/*.ts`, `src/api.ts`, `src/store.ts`, `src/schemas.ts`                                         | TypeScript |
| SkillForge and triage                                             | `src/forge.ts`                                                                                           | TypeScript |
| `submit` gate                                                     | `src/gate.ts`, kept; only the reference pin changes                                                      | TypeScript |

Python ≥ 3.10 is required **only** by `sleep`: no pip packages, no venv. Every other command works without Python, and Python-dependent tests are skipped (not failed) when no interpreter is found.

## 3. Design

### 3.1 One command: `anagenesis sleep --store … --request r.json|-`

Strict schema, union on `action`: `run`, `resume`, `dry-run`, `harvest`, `status`, `adopt`, `cleanup`, `discard`, `schedule`, `unschedule`, `evalkit`.

```ts
{ schemaVersion: 1, action: "run", operationId /* = sleepId */, author,
  skills: [{ skillId, expectedVersion }] /* empty: Microsoft's managed skill */,
  transcripts: Transcript[], memory?: { label, text }, tasksFile?, config?: SleepConfig }
{ schemaVersion: 1, action: "resume", sleepId }   // transcripts are sent once, never again
{ schemaVersion: 1, action: "adopt", operationId, sleepId, author }
```

- `config` uses Microsoft's names and defaults through an **explicit allowlist** (gate, budgets, fractions, dream, recall, evidence, redaction, `slow_update`). Path keys (`target_skill_path`, `skill_roots`, `projects`, `state_dir`) and `auto_adopt` inside `config.json` are rejected; `auto_adopt` is a wrapper flag that publishes after an accepted night.
- Responses: `pending` (`pendingPath`, `promptsPath`, `answersDir`, `count`), `idle` (`insufficient_tasks` or `no_tasks`), `staged`, `rejected` (exit 4). No new error codes. Python missing or < 3.10 → `NOT_FOUND` with `details.requirement` (exit 5), **never persisted**.

### 3.2 Night state machine (outside `Store.operation`)

`Store.operation` replays the first stored result and persists errors, so it cannot drive a multi-round night. Sleep keeps its own state in `sleep/nights/<id>/run.json`:

`created → pending ⇄ pending → (staged | rejected | idle) → adopted → cleaned`

- First `run`: stores the input digest (a different input with the same id → `IDEMPOTENCY_CONFLICT`), pins every skill's base (version, digest, commit), writes redacted digests, launches Python.
- `resume`: validates new answers, relaunches Python, maps the exit code. **Terminal states never relaunch Python.**
- If Python finished but the wrapper died, the result is rebuilt from `handoff.nightN.done` and the staging `report.json`. Exit 0 without a report → `idle` (`no_tasks`).
- Fewer than 3 tasks tagged `mined:llm` after mining → `idle` (`insufficient_tasks`): heuristic fallbacks do not count.
- Answers are validated by prompt kind before each relaunch (JSON where upstream expects JSON); the caller writes answers atomically (temp file + rename), as `pending.json` instructs.
- Orphan staging directories from earlier rounds are removed after each round.

### 3.3 Store layout, locks and child process

```
sleep/state/.skillopt-sleep/   state.json            (shared: common --claude-home)
sleep/nights/<id>/home/        .skillopt-sleep/config.json (per-night HOME)
sleep/nights/<id>/project/     skills/<id>/SKILL.md, CLAUDE.md, .skillopt-sleep/staging/
sleep/nights/<id>/             run.json, handoff/, tmp/, report.json
sleep/schedule/crontab
```

- Per-night `HOME` and project: concurrent nights never share config, copies or staging. The base is **rematerialized from Git at every round**, so the gate always evaluates the pinned base.
- A store-wide `sleep-state` lock wraps every Python process that may save `state.json`; the night lock `sleep:<id>` wraps each round; skill locks wrap `adopt`.
- Child process: interpreter from `ANAGENESIS_PYTHON`, then `python3` on `PATH`; on macOS `/usr/bin/python3` is used only if `xcode-select -p` succeeds (the stub opens an install dialog). Flags `-B`; cwd = night directory (a stray `json.py` in the caller's cwd would shadow the stdlib); environment built from scratch (`HOME`, `TMPDIR` = night `tmp/`, `PYTHONPATH` = vendor + shim, `PYTHONDONTWRITEBYTECODE=1`, `SKILLOPT_SLEEP_*`), no inherited `PYTHON*` or `SKILLOPT_SLEEP_WORKERS`; own process group, killed with the wrapper.

### 3.4 Input

- `Transcript` mirrors `SessionDigest` (`sessionId`, `project`, `startedAt`, `endedAt`, `userPrompts`, `assistantFinals`, `toolsUsed`, `skillsUsed`, `filesTouched`, `feedbackSignals`, counts).
- **Feedback** [I]: an event that is not superseded, not consumed and not `not_skill` enriches the session with the same `runId`, otherwise becomes its own digest. Its SkillForge primary category is added to `feedbackSignals`.
- **Redaction**: the shim writes `digests.json` with Microsoft's `redact_secrets`. `run.json` stores only the input digest, never raw transcripts.
- **Triage**: `feedback` accepts `disposition: "not_skill"` only together with `supersedes`.

### 3.5 Shim (`python/anagenesis_sleep/`)

Imports the vendor without modifying it; `__main__` installs the overrides, **asserts they are active**, then calls upstream `main()`.

- `ingest`: validates transcripts, builds and redacts `SessionDigest`; overrides `skillopt_sleep.__main__.harvest_for_config` so `harvest` reads them.
- Rollouts: `HandoffBackend` subclass that appends a rollout-index line when `sample_id > 0` (ids identical to upstream for 0). Tool-using attempts and `evidence.jsonl` keep upstream behaviour; documented.
- Scheduler: overrides `_have_crontab`, `_read_crontab`, `_write_crontab`, `_runner_cmd`, plus a fake `crontab` first on `PATH` as a safety net. The result goes to `sleep/schedule/crontab` and to JSON stdout. It never contains the host's other entries, so the caller merges it into its own schedule instead of installing it whole.
- `slow_update`: **not implemented now** (needs replay pairs upstream does not keep and would bypass the gate); the key is accepted only as `false`.

### 3.6 Adopt and provenance

Under the skill locks: base still active (`STALE_BASE`); run upstream `adopt --staging …` with `TMPDIR` in the night; an adopt lock is removed only if its recorded pid is dead; "already adopted" with a matching `adopted_legacy.json` and SHA is idempotent success; then `validateTree` and `Store.publish`.

- Revision `kind: "sleep"`: `policy` and `sources` inherited from the base; Microsoft's managed skill v1 gets a declared default policy and the pin URI as source. `Store.revision()` and the `Revision` type accept `sleep`.
- One publication per skill with an `operationId` derived from `sleepId` + `skillId` (UUID v5); all bases are pinned in `run.json`, so a partial crash resumes the missing skills.
- Memory: returned as `{ label, text, baseSha256 }`; the caller writes its own file. A night accepted only on memory publishes no revision.
- Cleanup is idempotent and also runs on the "receipt already found" path. Rejected, idle and abandoned nights are cleaned by `sleep status --prune` after a retention period. The `state.json` task archive (≤ 300 redacted tasks, needed by `recall_k`) stays.

### 3.7 SkillForge (TypeScript)

- **Failure Analyzer**: `feedback.analysis` with severities for knowledge, tool usage, clarification, style; deterministic verdict and primary category as in §1.1.
- **Aggregation**: `improve` groups selected feedback by primary category and picks k = 3 representatives [I].
- **Diagnostician** (always required): the existing inline `submit.diagnosis` stays and gains `defect` (`knowledge | tool_usage | clarification | style`, required when `category` is `skill`) and `files`. `category` keeps its meaning (skill vs tool/data/environment/execution); the SkillForge value is named `tool_usage` to avoid the collision. Every changed file must appear in a diagnosis entry; missing diagnosis → `EVIDENCE_INVALID` (existing code), checked **before** the holdout attempt is frozen.
- **Creator** (always required): the `create` brief follows the four stages; `submit` of a created candidate requires inline `mining` (sources per stage).
- **Optimizer**: `SKILL.md` over 500 lines or 10,000 characters adds `warnings: ["skill_md_too_long"]` to the result of `submit`, `restore` and `sleep adopt`; never rejects.
- **Judge**: our own criteria, no copied text.

## 4. Steps

Each step is one commit with `npm run check` green. Final history is reorganised into semantic commits (§6).

1. **Docs and license.** Rewrite in English: `SKILL_PACKAGE_CONTRACT.md` (scope, Python only for `sleep`, publication paths `submit`/`restore`/`sleep adopt`, Sleep and SkillForge sections), `README.md`, `THIRD_PARTY_NOTICES.md`. Add `LICENSE` (MIT), `"license": "MIT"`. Exclude `__pycache__` from the tarball (today `vendor/skillopt/__pycache__/gate.cpython-315.pyc` ships). Describe Sleep as planned until step 7.
2. **SkillForge and triage.** `src/schemas.ts`, `src/forge.ts`, `src/api.ts`; update `tests/helpers.mjs`, improve tests and `examples/workflow.mjs` to send diagnosis and mining. Tests `tests/forge.test.mjs`: verdict and tie-break; missing diagnosis rejected without consuming a holdout; undeclared file rejected; length warning; `not_skill` only with `supersedes`.
3. **Sleep revisions in the store.** `Revision` kind `sleep`, inherited policy, managed-skill default policy, derived operation ids. Test: a sleep revision does not break receipts, `restore` or `materialize` of other skills.
4. **Vendor and interpreter.** `vendor/skillopt/skillopt_sleep/` + `MANIFEST.json` (move `gate.py`, update `tests/gate.test.mjs`, fixtures script), `package.json` `files` (+ `python`), `src/sleep/python.ts`, CI `actions/setup-python` 3.10 and latest. Tests: manifest hashes, `-S` import, clean error without Python, no stub execution.
5. **Shim.** `python/anagenesis_sleep/`. Tests `tests/sleep-shim.test.mjs`: redacted digests; distinct ids for `sample_id > 0`, upstream ids for 0; crontab only in the store; overrides asserted.
6. **Night state machine.** `run`, `resume`, `dry-run`, `harvest`, `status`. Integration test with real Python and a scripted responder: rounds to `staged`; `rejected`; `idle` (`no_tasks`, `insufficient_tasks`); `IDEMPOTENCY_CONFLICT`; terminal states do not relaunch; two concurrent nights; kill of the Python child; empty fake `HOME`/`TMPDIR` show no writes outside the store; malformed answers rejected.
7. **Adopt, cleanup, schedule, evalkit, CLI.** Tests: v N+1 with only `SKILL.md` changed; managed-skill v1; memory with `baseSha256`; `STALE_BASE`; partial multi-skill crash resumes; stale adopt lock; idempotent cleanup; `tests/cli.test.mjs`; `examples/sleep.mjs`; README Sleep section finalised.

## 5. Risks

- **Weaker held-out on the Sleep path**: tasks and scores come from the same model that proposes the edits, and subagent isolation cannot be verified. Sleep revisions are labelled in `history`.
- **Shim depends on upstream internals** (`harvest_for_config`, `_have_crontab`, `_read_crontab`, `_write_crontab`, `_runner_cmd`, backend `_call`); the manifest blocks vendor drift and every pin change reruns the integration tests.
- **Round count**: about one attempt per round on rubric tasks (≈120 rounds for 40 tasks); `resume` keeps each round small. Effect of `SKILLOPT_SLEEP_WORKERS > 1` not measured.
- **Linux not exercised yet** (for example `sqlite3` on minimal distributions, imported at module level by `harvest_opencode`); covered by CI.

## 6. Git workflow

- `main` was reset to the initial commit `0d1e49d` and force-pushed; the old `main` is kept in the local tag `backup/main-before-reset`.
- Work happens on `feat/skillforge-skillopt-sleep`, branched from `codex/implement-skill-contract`.
- When done, the whole branch (existing commits included) is reorganised into semantic commits and a new PR is opened against `main`.
