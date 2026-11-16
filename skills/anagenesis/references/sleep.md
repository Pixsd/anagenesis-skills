# Sleep

Sleep runs Microsoft's unchanged SkillOpt Sleep code. It decides the steps; whenever a step needs a model, it writes the question to a file and stops. You answer, then resume. It never calls a model itself.

## Run

1. Read your own session logs for the period and convert each session that used the skill into a transcript: `sessionId`, `project`, and optionally `userPrompts`, `assistantFinals`, `toolsUsed`, `skillsUsed`, `filesTouched`, `feedbackSignals`. Remove secrets.
2. Memory: to let Sleep propose edits to your memory file (for example `AGENTS.md`), pass `memory: {label, text}` with the file's exact current contents and remember which file it was. Otherwise set `config.evolve_memory: false` so the night only touches skills.
3. Send `sleep` with `action: "run"` (template: sleep-run), `skills: [{skillId, expectedVersion}]` with the active version, and the transcripts. `action: "dry-run"` produces only a report.

## Answer pending prompts

While the response has `status: "pending"`:

1. Read `pending.promptsPath` (human-readable) or `pending.pendingPath` (JSON: each item has `prompt` and `answer_file`).
2. For **each** prompt, start a fresh subagent that sees only that prompt. Each prompt ends with its own answer format, for example `Return ONLY a JSON array`, `Return ONLY JSON {"score": …, "reason": …}` or `Return ONLY the final answer text`. Follow it exactly: no comments, no code fences.
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

Sleep versions carry weaker evidence than a submit: the same model mined, ran and judged the tasks.

## Nightly runs

You may offer to run Sleep every night. Ask the user whether, at what time (suggest 03:17 local time) and for which skills, and say that each night costs about ten rounds of subagents. Anagenesis installs nothing: you set the job up with whatever scheduler your environment offers.

- **Will it be there?** If this environment will not exist at that hour (an ephemeral container or sandbox), or you cannot run without a user, say so and install nothing.
- **The job** starts you unattended with an instruction that carries what was agreed: the store, the skills, whether memory is included, and "run one night as `sleep.md` describes". The agent it starts needs this skill installed. Use absolute paths and an explicit `--store`, grant in advance only the permissions a night needs, and append output to a log file. Never put credentials in the command; rely on your own login.
- **Try it first.** Run the exact command once while the user is present, and install it only if it reaches a terminal state without asking for anything. Review or discard that night with the user, or the first scheduled night will wait behind it.
- **Install with consent.** Show the user the exact entry and where it goes; add it only after they agree and leave every other job untouched. Tell them the log path and how to remove the entry. Later, change or remove only that entry, and only when asked. Do not use `action: "schedule"`: it writes cron text inside the store without the user's other jobs, and that text must never be installed as a crontab.
- **Each night**, send `status` first. Resume a `pending` night instead of starting one. If a `staged` night is waiting for the user, start nothing. Otherwise run with the sessions since the last night's `createdAt`, leaving out the nightly sessions themselves. On `STORE_BUSY`, wait and resend the same file; after a few tries, log it and stop.
- **Never adopt at night.** Agreeing to a schedule is not approving a proposal: the night ends `staged`, `rejected` or `idle` and waits. Never apply memory edits unattended.
- **Afterwards**, show each `staged` night to the user (`status` with its `sleepId` returns the result). Approved: Adopt. Declined: discard, so the next night can start.
