import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  Store,
  create,
  submit,
  snapshotTree,
  sha256,
  evaluationPlan,
} from "../dist/index.js";
export { randomUUID as uuid };
export const author = {
  producer: "test-agent",
  model: "declared-model",
  modelVersion: "1",
};
export async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anagenesis-test-"));
  t.after(async () => {
    async function writable(p) {
      const st = await fs.lstat(p);
      if (st.isDirectory()) {
        await fs.chmod(p, 0o755);
        for (const e of await fs.readdir(p)) await writable(path.join(p, e));
      }
    }
    await writable(root);
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
export function policy(prefix = randomUUID()) {
  const c = (id) => ({
    id: prefix + id,
    inputDigest: sha256(prefix + id),
    requiresIsolation: true,
  });
  return {
    metric: "soft",
    mixedWeight: 0.5,
    aggregation: "mean",
    repetitions: 1,
    minimumHoldout: 1,
    thresholds: { hard: 1, soft: 0.5 },
    regressionTolerance: { hard: 0, soft: 0 },
    development: [
      { ...c("dev"), prompt: "Development input", expected: "Expected result" },
    ],
    holdouts: [[c("h1")], [c("h2")]],
    regression: [c("reg")],
    limits: { maxFiles: 100, maxBytes: 100000, maxFileBytes: 50000 },
    evaluation: {
      model: "declared-model",
      modelVersion: "1",
      configuration: { temperature: 0 },
      tools: ["test-verifier"],
      environment: "test",
      budget: 1000,
      verifierId: "test-verifier",
      verifierVersion: "1",
    },
  };
}
export function createRequest(skillId = "test-skill", p = policy()) {
  return {
    schemaVersion: 1,
    operationId: randomUUID(),
    skillId,
    objective: "Help with a test task",
    boundaries: ["Do not call models"],
    audience: "Test agent",
    sources: [
      {
        uri: "https://example.org/source",
        revision: "1",
        digest: sha256("source"),
      },
    ],
    examples: [{ input: "Input", expected: "Output" }],
    successCriteria: ["Correct result"],
    author,
    reason: "Create a useful skill",
    policy: p,
  };
}
export async function writeSkill(
  candidate,
  skillId = "test-skill",
  body = "Follow the documented steps.",
) {
  await fs.writeFile(
    path.join(candidate.workspacePath, "SKILL.md"),
    `---\nname: ${skillId}\ndescription: Useful test skill\n---\n\n${body}\n`,
  );
}
export function mining(request) {
  const uri = request.sources[0].uri;
  const stage = (summary) => ({ sources: [uri], summary });
  return {
    workflow: stage("Task workflow from the source"),
    tools: stage("Tools named by the source"),
    knowledge: stage("Domain facts from the source"),
    synthesis: stage("Merged into SKILL.md"),
  };
}
export async function submission(candidate, request, options = {}) {
  const { index = 0, baseline = 0.5, score = 0.8, regression = 1 } = options;
  const tree = await snapshotTree(candidate.workspacePath);
  const p = request.policy;
  const plan = evaluationPlan(p);
  const artifacts = {};
  const run = (spec, split, soft, repetition) => {
    const artifact = JSON.stringify({ caseId: spec.id, soft, repetition });
    const artifactDigest = sha256(artifact);
    artifacts[artifactDigest] = artifact;
    return {
      runId: randomUUID(),
      caseId: spec.id,
      split,
      repetition,
      inputDigest: spec.inputDigest,
      artifactDigest,
      outcome: "pass",
      hard: 1,
      soft,
      ...p.evaluation,
      timestamp: new Date().toISOString(),
      producer: "test-evaluator",
      seed: 42,
      origin: "machine",
      sessionId: "non-sensitive-test-session",
      isolated: true,
    };
  };
  const results = [
    ...p.holdouts[index].map((c) => [c, "holdout"]),
    ...p.regression.map((c) => [c, "regression"]),
  ].flatMap(([c, split]) =>
    Array.from({ length: p.repetitions }, (_, repetition) => ({
      baseline: run(c, split, split === "holdout" ? baseline : 1, repetition),
      candidate: run(
        c,
        split,
        split === "holdout" ? score : regression,
        repetition,
      ),
    })),
  );
  return {
    schemaVersion: 1,
    operationId: randomUUID(),
    candidateId: candidate.candidateId,
    expectedDigest: tree.digest,
    evidenceManifest: {
      schemaVersion: 1,
      candidateDigest: tree.digest,
      baseVersion: candidate.baseVersion,
      baseDigest: candidate.baseDigest,
      policyDigest: plan.policyDigest,
      suiteDigest: plan.attempts[index].suiteDigest,
      holdoutIndex: index,
      authorExposed: false,
      baselineKind: candidate.baseVersion ? "revision" : "without_skill",
      results,
      artifacts,
    },
    ...(candidate.baseVersion
      ? {
          diagnosis: [
            {
              evidenceIds: [p.development[0].id],
              category: "skill",
              defect: "knowledge",
              files: tree.entries
                .filter((e) => e.type === "file")
                .map((e) => e.path),
              cause: "Instructions lack a required step",
              sections: ["Procedure"],
              minimalChange: "Add the missing step",
              expectedTest: "Correct handling of the development example",
            },
          ],
        }
      : { mining: mining(request) }),
  };
}
export async function fixture(t, skillId = "test-skill") {
  const root = await temporary(t);
  const store = await Store.open({ storePath: path.join(root, "store") });
  const request = createRequest(skillId);
  const candidate = await create(store, request);
  await writeSkill(candidate, skillId);
  return { root, store, request, candidate };
}
export async function published(t, skillId = "test-skill") {
  const f = await fixture(t, skillId);
  const req = await submission(f.candidate, f.request);
  const publication = await submit(f.store, req);
  return { ...f, submitRequest: req, publication };
}
