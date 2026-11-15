import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  analyzeFailure,
  improve,
  recordFeedback,
  submit,
} from "../dist/index.js";
import {
  createRequest,
  fixture,
  published,
  submission,
  uuid,
  writeSkill,
} from "./helpers.mjs";

const none = {
  knowledge: "none",
  toolUsage: "none",
  clarification: "none",
  style: "none",
};

test("Failure Analyzer verdict and primary category follow SkillForge rules", () => {
  assert.deepEqual(analyzeFailure(none), {
    verdict: "passed",
    primaryCategory: null,
  });
  assert.deepEqual(analyzeFailure({ ...none, style: "high" }), {
    verdict: "failed",
    primaryCategory: "style",
  });
  assert.deepEqual(
    analyzeFailure({ ...none, style: "medium", toolUsage: "medium" }),
    { verdict: "failed", primaryCategory: "toolUsage" },
  );
  assert.deepEqual(analyzeFailure({ ...none, clarification: "medium" }), {
    verdict: "passed",
    primaryCategory: "clarification",
  });
  // Highest severity wins before the tie-break order.
  assert.equal(
    analyzeFailure({ ...none, knowledge: "low", style: "medium" })
      .primaryCategory,
    "style",
  );
});

test("Creation without mining is refused before a holdout is consumed", async (t) => {
  const f = await fixture(t);
  const req = await submission(f.candidate, f.request);
  const { mining, ...withoutMining } = req;
  await assert.rejects(submit(f.store, withoutMining), {
    code: "EVIDENCE_INVALID",
  });
  await assert.rejects(
    submit(f.store, {
      ...req,
      operationId: uuid(),
      mining: {
        ...mining,
        tools: { sources: ["https://unknown.example"], summary: "x" },
      },
    }),
    { code: "EVIDENCE_INVALID" },
  );
  // Holdout 0 is still available.
  const ok = await submit(f.store, { ...req, operationId: uuid() });
  assert.equal(ok.version, 1);
  assert.equal(ok.warnings, undefined);
});

async function improvement(t) {
  const f = await published(t);
  const request = { ...createRequest(), expectedVersion: 1, feedbackIds: [] };
  const candidate = await improve(f.store, request);
  await writeSkill(candidate, "test-skill", "Follow the improved steps.");
  return { ...f, request, candidate };
}

test("Improvement diagnosis must name a defect and cover every changed file", async (t) => {
  const f = await improvement(t);
  const req = await submission(f.candidate, f.request);
  const [entry] = req.diagnosis;
  const { defect, ...withoutDefect } = entry;
  await assert.rejects(
    submit(f.store, { ...req, diagnosis: [withoutDefect] }),
    { code: "EVIDENCE_INVALID" },
  );
  await fs.mkdir(path.join(f.candidate.workspacePath, "references"));
  await fs.writeFile(
    path.join(f.candidate.workspacePath, "references", "guide.md"),
    "Guide\n",
  );
  const changed = await submission(f.candidate, f.request);
  await assert.rejects(
    submit(f.store, {
      ...changed,
      diagnosis: [{ ...changed.diagnosis[0], files: ["SKILL.md"] }],
    }),
    (e) =>
      e.code === "EVIDENCE_INVALID" &&
      e.details.files.includes("references/guide.md"),
  );
  await assert.rejects(
    submit(f.store, {
      ...changed,
      operationId: uuid(),
      diagnosis: [
        { ...changed.diagnosis[0], files: ["SKILL.md", "missing.md"] },
      ],
    }),
    { code: "EVIDENCE_INVALID" },
  );
  const ok = await submit(f.store, { ...changed, operationId: uuid() });
  assert.equal(ok.version, 2);
});

test("A long SKILL.md publishes with a warning, also on replay", async (t) => {
  const f = await fixture(t);
  await writeSkill(
    f.candidate,
    "test-skill",
    Array.from({ length: 600 }, (_, i) => `Step ${i}.`).join("\n"),
  );
  const req = await submission(f.candidate, f.request);
  const result = await submit(f.store, req);
  assert.equal(result.status, "published");
  assert.deepEqual(result.warnings, ["skill_md_too_long"]);
  assert.deepEqual(await submit(f.store, req), result);
});

test("Feedback analysis, triage disposition and grouped improve brief", async (t) => {
  const f = await published(t);
  const base = {
    schemaVersion: 1,
    skillId: "test-skill",
    version: 1,
    artifactDigest: f.publication.digest,
    runId: "run-1",
    producer: "test",
    timestamp: new Date().toISOString(),
    source: f.request.sources[0],
    observation: "Wrong tool order",
    expected: "Search then fetch",
    actual: "Fetch first",
    evidenceRefs: ["run:1"],
    category: "skill",
    possibleCause: null,
  };
  const first = await recordFeedback(f.store, {
    ...base,
    operationId: uuid(),
    analysis: { ...none, toolUsage: "high" },
  });
  assert.deepEqual(first.failure, {
    verdict: "failed",
    primaryCategory: "toolUsage",
  });
  await assert.rejects(
    recordFeedback(f.store, {
      ...base,
      operationId: uuid(),
      disposition: "not_skill",
    }),
    { code: "INVALID_INPUT" },
  );
  const triaged = await recordFeedback(f.store, {
    ...base,
    operationId: uuid(),
    supersedes: first.feedbackId,
    disposition: "not_skill",
    observation: "The tool was down",
  });
  assert.equal(triaged.disposition, "not_skill");
  const c = await improve(f.store, {
    ...createRequest(),
    expectedVersion: 1,
    feedbackIds: [first.feedbackId, triaged.feedbackId],
  });
  const brief = JSON.parse(await fs.readFile(c.briefPath, "utf8"));
  assert.deepEqual(
    brief.failureGroups.map((g) => [g.category, g.count]),
    [
      ["toolUsage", 1],
      ["unclassified", 1],
    ],
  );
  assert.ok(brief.defectMap.toolUsage);
  assert.ok(brief.diagnosis.fields.includes("files"));
});
