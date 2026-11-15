// Synthetic offline demonstration. Replace these attestations with your evaluator's real results.
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  create,
  submit,
  resolve,
  snapshotTree,
  sha256,
} from "../dist/index.js";
const storePath =
  process.argv[2] ??
  (await fs.mkdtemp(path.join(os.tmpdir(), "anagenesis-demo-")));
const store = { storePath };
const id = randomUUID();
const descriptor = (suffix) => ({
  id: `${id}-${suffix}`,
  inputDigest: sha256(`${id}-${suffix}`),
  requiresIsolation: false,
});
const evaluation = {
  model: "synthetic-demo",
  modelVersion: "1",
  configuration: {},
  tools: ["example-verifier"],
  environment: "offline-demo",
  budget: 100,
  verifierId: "example-verifier",
  verifierVersion: "1",
};
const policy = {
  metric: "soft",
  mixedWeight: 0.5,
  aggregation: "mean",
  repetitions: 1,
  minimumHoldout: 1,
  thresholds: { hard: 1, soft: 0.7 },
  regressionTolerance: { hard: 0, soft: 0 },
  development: [
    {
      ...descriptor("dev"),
      prompt: "Development prompt",
      expected: "Expected development answer",
    },
  ],
  holdouts: [[descriptor("holdout")]],
  regression: [descriptor("regression")],
  limits: { maxFiles: 20, maxBytes: 100000, maxFileBytes: 50000 },
  evaluation,
};
const request = {
  schemaVersion: 1,
  operationId: randomUUID(),
  skillId: "demo-skill",
  objective: "Demonstrate the local publication workflow",
  boundaries: ["Only synthetic evaluation data"],
  audience: "Package developers",
  sources: [
    {
      uri: "https://example.org/demo",
      revision: "1",
      digest: sha256("synthetic reference"),
    },
  ],
  examples: [{ input: "A demo task", expected: "A demo result" }],
  successCriteria: ["Complete the local publication flow"],
  author: {
    producer: "example-script",
    model: "synthetic-demo",
    modelVersion: "1",
  },
  reason: "Demonstrate the API",
  policy,
};
const candidate = await create(store, request);
// This represents the calling agent writing SKILL.md in its current session.
await fs.writeFile(
  path.join(candidate.workspacePath, "SKILL.md"),
  "---\nname: demo-skill\ndescription: Demonstrate a local skill revision.\n---\n\nFollow the supplied domain examples and verify the result.\n",
);
const { digest } = await snapshotTree(candidate.workspacePath);
const artifacts = {};
function run(spec, split, soft) {
  const bytes = JSON.stringify({ caseId: spec.id, synthetic: true, soft });
  const artifactDigest = sha256(bytes);
  artifacts[artifactDigest] = bytes;
  return {
    ...evaluation,
    runId: randomUUID(),
    caseId: spec.id,
    split,
    repetition: 0,
    inputDigest: spec.inputDigest,
    artifactDigest,
    outcome: "pass",
    hard: 1,
    soft,
    timestamp: new Date().toISOString(),
    producer: "synthetic-example",
    seed: null,
    origin: "machine",
    sessionId: id,
    isolated: false,
  };
}
const results = [
  ...policy.holdouts[0].map((c) => [c, "holdout"]),
  ...policy.regression.map((c) => [c, "regression"]),
].map(([c, split]) => ({
  baseline: run(c, split, split === "holdout" ? 0.4 : 1),
  candidate: run(c, split, split === "holdout" ? 0.9 : 1),
}));
const evidenceManifest = {
  schemaVersion: 1,
  candidateDigest: digest,
  baseVersion: null,
  baseDigest: null,
  baselineKind: "without_skill",
  policyDigest: candidate.evaluationPlan.policyDigest,
  suiteDigest: candidate.evaluationPlan.attempts[0].suiteDigest,
  holdoutIndex: 0,
  authorExposed: false,
  results,
  artifacts,
};
const publication = await submit(store, {
  schemaVersion: 1,
  operationId: randomUUID(),
  candidateId: candidate.candidateId,
  expectedDigest: digest,
  evidenceManifest,
  // SkillForge Creator: sources used in each of the four creation stages.
  mining: Object.fromEntries(
    ["workflow", "tools", "knowledge", "synthesis"].map((stage) => [
      stage,
      {
        sources: [request.sources[0].uri],
        summary: `${stage} from the source`,
      },
    ]),
  ),
});
console.log(
  JSON.stringify(
    {
      storePath,
      publication,
      resolved: await resolve(store, {
        schemaVersion: 1,
        skillId: "demo-skill",
      }),
    },
    null,
    2,
  ),
);
