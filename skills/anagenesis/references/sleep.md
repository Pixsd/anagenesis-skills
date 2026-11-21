# Sleep

Sleep runs Microsoft's unchanged SkillOpt Sleep code. It decides the steps; whenever a step needs a model, it writes the question to a file and stops. You answer, then resume. It never calls a model itself.

## Run

1. Read your own session logs for the period and convert each session that used the skill into a transcript: `sessionId`, `project`, and optionally `userPrompts`, `assistantFinals`, `toolsUsed`, `skillsUsed`, `filesTouched`, `feedbackSignals`. Remove secrets.
2. Memory: to let Sleep propose edits to your memory file (for example `AGENTS.md`), pass `memory: {label, text}` with the file's exact current contents and remember which file it was. Otherwise set `config.evolve_memory: false` so the night only touches skills.
3. Choose the models first (see "Models"). Send `sleep` with `action: "run"` (template: sleep-run), `skills: [{skillId, expectedVersion}]` with the active version, `models` and the transcripts. `action: "dry-run"` produces only a report.

## Models

A night is about ten rounds of subagents, so the model they run on decides its cost. Anagenesis never calls a model and does not know your host: it labels each pending prompt with a `kind`, and you, the calling agent, decide the model for each kind from whatever your own host offers (Claude, Codex, Antigravity or any other). Nothing is configured by the user.

Pick the cheapest model that is reliable for the job, never your own by default:

- `attempt`: the skill running on a mined task. Use the model that will really use the skill, or a cheaper one if you accept that a pass then holds only for it.
- `judge`, `miner`, `reflect`: scoring, mining recurring tasks, proposing edits. A mid-tier model is enough; the top tier is never needed.
- `other`: not recognised. Dispatch nothing and tell the user.

Rules:

- **Never inherit.** Start every subagent with an explicit model for its kind. If your host cannot set a subagent's model, say so in one line and continue; do not install a nightly job.
- **Same models all night.** One `attempt` and one `judge` model for baseline, candidate and every resumed round, or scores stop being comparable. Pass the names you chose as `models` in the first `run`; Anagenesis returns them in `pending.models` on every round, so a `resume`, even by a fresh agent, routes the same way. Kinds you left out of `models` are not pinned: choose for them by the same rules, and pin them by sending all four if you want a fresh agent to reproduce them.
- **The driver is cheap too.** You only copy prompts to subagents and answers to files. When you start a night, or write the command of a nightly job, run that session on a mid-tier model, set where the session starts: reading this file is too late to change it.

## Answer pending prompts

While the response has `status: "pending"`:

1. Read `pending.promptsPath` (human-readable) or `pending.pendingPath` (JSON: each item has `prompt` and `answer_file`). `pending.items` lists each prompt's `id` and `kind`; the answer file is `pending.answersDir/<id>.md`.
2. For **each** prompt, start a fresh subagent on the model for its `kind` that sees only that prompt. Each prompt ends with its own answer format, for example `Return ONLY a JSON array`, `Return ONLY JSON {"score": …, "reason": …}` or `Return ONLY the final answer text`. Follow it exactly: no comments, no code fences.
3. Write the raw answer to that prompt's `answer_file`: write a temporary file next to it, then rename it.
4. Send `resume` (template: sleep-resume) with the same `sleepId`. Do not resend transcripts. Malformed JSON answers are refused with `VALIDATION_FAILED` and the list of prompt ids to fix.

Expect around ten rounds. If you are interrupted, `resume` with the same `sleepId` continues from the saved state; `{"schemaVersion": 1, "action": "status"}` lists nights.

## Terminal states

| Status     | Meaning                                                    | What you do                                                                              |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `staged`   | A proposal passed Microsoft's gate                         | Show the user `result.baseline`, `result.candidate` and `result.edits`; ask for approval |
| `rejected` | The gate saw no improvement                                | Report it; nothing changes                                                               |
| `idle`     | Nothing to learn (`reason`, e.g. fewer than 3 mined tasks) | Report it                                                                                |
| `reported` | Dry run finished                                           | Show the report                                                                          |

## Adopt

Send `adopt` (template: sleep-adopt) only after the user explicitly approves. If the user declines, send `discard` (template: sleep-discard): nothing is published and the night ends `cleaned`. The response ends `cleaned` with `adoption.publications` (the new version per skill, marked `kind: "sleep"`).

If `adoption.memory` is present: compute `anagenesis digest --file <your memory file>`. Apply `adoption.memory.text` only if the digest equals `adoption.memory.baseSha256`; otherwise the file changed since the night started, so show the proposal to the user instead.

Sleep versions carry weaker evidence than a submit: the calling agent mined, ran and judged the tasks, and Anagenesis cannot verify that those models were independent of the one that proposed the edits.

## Nightly runs

You may offer to run Sleep every night. Ask the user whether, at what time (suggest 03:17 local time) and for which skills, and say that each night costs about ten rounds of subagents on the models you chose. Anagenesis installs nothing: you set the job up with whatever scheduler your environment offers.

- **Will it be there?** If this environment will not exist at that hour (an ephemeral container or sandbox), or you cannot run without a user, say so and install nothing.
- **The job** starts you unattended with an instruction that carries what was agreed: the store, the skills, whether memory is included, the `models` per kind, and "run one night as `sleep.md` describes". The agent it starts needs this skill installed. Pin the orchestrator's model in the command itself (see "Models"). Use absolute paths and an explicit `--store`, grant in advance only the permissions a night needs, and append output to a log file. Never put credentials in the command; rely on your own login.
- **Try it first.** Run the exact command once while the user is present, and install it only if it reaches a terminal state without asking for anything. Review or discard that night with the user, or the first scheduled night will wait behind it.
- **Install with consent.** Show the user the exact entry and where it goes; add it only after they agree and leave every other job untouched. Tell them the log path and how to remove the entry. Later, change or remove only that entry, and only when asked. Do not use `action: "schedule"`: it writes cron text inside the store without the user's other jobs, and that text must never be installed as a crontab.
- **Each night**, send `status` first. Resume a `pending` night instead of starting one. If a `staged` night is waiting for the user, start nothing. Otherwise run with the sessions since the last night's `createdAt`, leaving out the nightly sessions themselves. On `STORE_BUSY`, wait and resend the same file; after a few tries, log it and stop.
- **Never adopt at night.** Agreeing to a schedule is not approving a proposal: the night ends `staged`, `rejected` or `idle` and waits. Never apply memory edits unattended.
- **Afterwards**, show each `staged` night to the user (`status` with its `sleepId` returns the result). Approved: Adopt. Declined: discard, so the next night can start.
