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

Send `adopt` (template: sleep-adopt) only after the user explicitly approves. The response ends `cleaned` with `adoption.publications` (the new version per skill, marked `kind: "sleep"`).

If `adoption.memory` is present: compute `anagenesis digest --file <your memory file>`. Apply `adoption.memory.text` only if the digest equals `adoption.memory.baseSha256`; otherwise the file changed since the night started, so show the proposal to the user instead.

Sleep versions carry weaker evidence than a submit: the same model mined, ran and judged the tasks.
