import * as fs from "node:fs/promises";
import path from "node:path";
import { Store, sleep } from "../dist/index.js";
import { findPython } from "../dist/sleep/python.js";
import { author, temporary, uuid } from "./helpers.mjs";

let python = null;
try {
  python = findPython();
} catch {}
export const opts = {
  skip: python ? false : "Python 3.10+ not found; sleep tests skipped",
};

export const transcripts = (n = 4) =>
  [
    "Write the release notes",
    "Summarize the deploy log",
    "Draft the changelog entry",
    "Explain the failing test",
  ]
    .slice(0, n)
    .map((q, i) => ({
      sessionId: "s" + i,
      project: "/work/demo",
      startedAt: `2026-11-1${i}T10:00:00Z`,
      userPrompts: [q, q + " again please"],
      assistantFinals: ["ok"],
      feedbackSignals: ["wrong format"],
    }));

/** Answers every pending prompt. `good` attempts say GOOD once the skill
 * tells them to; `flat` never improves; `malformed` breaks the miner JSON. */
export async function respond(view, mode = "good", tasksPerMiner = 3) {
  const { pending } = JSON.parse(
    await fs.readFile(view.pending.pendingPath, "utf8"),
  );
  for (const { prompt, answer_file } of pending) {
    let answer;
    if (prompt.startsWith("You are mining"))
      answer =
        mode === "malformed"
          ? "Sure! Here are the tasks: intent=..."
          : JSON.stringify(
              Array.from({ length: tasksPerMiner }, (_, j) => ({
                intent: `${prompt.length} recurring request #${j}`,
                rubric: "The answer says GOOD",
                satisfied: false,
              })),
            );
    else if (prompt.startsWith("Complete the following task"))
      answer =
        mode === "good" && prompt.includes("Always say GOOD")
          ? "GOOD answer"
          : "plain answer";
    else if (prompt.startsWith("Score how well"))
      answer = JSON.stringify({
        score: prompt.split("# Response")[1]?.includes("GOOD") ? 1 : 0.2,
        reason: "scripted",
      });
    else if (prompt.startsWith("You are SkillOpt's optimizer"))
      answer = JSON.stringify([
        {
          op: "add",
          content: "Always say GOOD in the final answer.",
          rationale: "fix",
        },
      ]);
    else answer = "?";
    await fs.writeFile(answer_file + ".tmp", answer);
    await fs.rename(answer_file + ".tmp", answer_file);
  }
}
export async function night(store, request, mode, tasksPerMiner) {
  let view = await sleep(store, request);
  for (let i = 0; i < 100 && view.status === "pending"; i++) {
    await respond(view, mode, tasksPerMiner);
    view = await sleep(store, {
      schemaVersion: 1,
      action: "resume",
      sleepId: view.sleepId,
    });
  }
  return view;
}
export async function fresh(t) {
  const root = await temporary(t);
  return Store.open({ storePath: path.join(root, "store") });
}
export const run = (extra = {}) => ({
  schemaVersion: 1,
  action: "run",
  operationId: uuid(),
  author,
  transcripts: transcripts(),
  ...extra,
});
