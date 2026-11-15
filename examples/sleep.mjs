// Offline Sleep demonstration using the real vendored Python and scripted
// answers. Replace the responder with the calling agent in clean contexts.
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { sleep, resolve } from "../dist/index.js";

const storePath =
  process.argv[2] ??
  (await fs.mkdtemp(path.join(os.tmpdir(), "anagenesis-sleep-demo-")));
const store = { storePath };
const author = {
  producer: "example-script",
  model: "scripted-demo",
  modelVersion: "1",
};
let view = await sleep(store, {
  schemaVersion: 1,
  action: "run",
  operationId: randomUUID(),
  author,
  skills: [], // Microsoft creates skillopt-sleep-learned when no target exists.
  transcripts: [
    "Release notes",
    "Deploy summary",
    "Changelog",
    "Test explanation",
  ].map((topic, i) => ({
    sessionId: "demo-" + i,
    project: "/demo/project",
    userPrompts: [topic, topic + " again please"],
    assistantFinals: ["plain answer"],
    feedbackSignals: ["The answer needs a consistent format"],
  })),
});
for (let round = 0; view.status === "pending" && round < 100; round++) {
  const { pending } = JSON.parse(
    await fs.readFile(view.pending.pendingPath, "utf8"),
  );
  for (const { prompt, answer_file } of pending) {
    let answer;
    if (prompt.startsWith("You are mining"))
      answer = JSON.stringify(
        Array.from({ length: 3 }, (_, i) => ({
          intent: `${prompt.length} recurring request ${i}`,
          rubric: "The response says GOOD",
          satisfied: false,
        })),
      );
    else if (prompt.startsWith("Complete the following task"))
      answer = prompt.includes("Always say GOOD")
        ? "GOOD answer"
        : "plain answer";
    else if (prompt.startsWith("Score how well"))
      answer = JSON.stringify({
        score: prompt.split("# Response")[1]?.includes("GOOD") ? 1 : 0.2,
        reason: "scripted demonstration",
      });
    else if (prompt.startsWith("You are SkillOpt's optimizer"))
      answer = JSON.stringify([
        {
          op: "add",
          content: "Always say GOOD in the final answer.",
          rationale: "Use the demonstrated format",
        },
      ]);
    else
      throw new Error("Unexpected prompt; inspect " + view.pending.promptsPath);
    // Upstream must see complete answers, including during a concurrent read.
    await fs.writeFile(answer_file + ".tmp", answer);
    await fs.rename(answer_file + ".tmp", answer_file);
  }
  view = await sleep(store, {
    schemaVersion: 1,
    action: "resume",
    sleepId: view.sleepId,
  });
}
if (view.status !== "staged")
  throw new Error("Night did not stage: " + JSON.stringify(view));
const adopted = await sleep(store, {
  schemaVersion: 1,
  action: "adopt",
  operationId: randomUUID(),
  sleepId: view.sleepId,
  author,
});
console.log(
  JSON.stringify(
    {
      storePath,
      adopted,
      resolved: await resolve(store, {
        schemaVersion: 1,
        skillId: view.skillId,
      }),
    },
    null,
    2,
  ),
);
