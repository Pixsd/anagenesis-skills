import { digestJson, sha256 } from "./io.js";
import { fail } from "./errors.js";
import { evaluateGate, selectGateScore, type GateResult } from "./gate.js";
import type { Manifest, Policy } from "./schemas.js";
export function validatePolicy(policy: Policy) {
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const c of [
    ...policy.development,
    ...policy.holdouts.flat(),
    ...policy.regression,
  ]) {
    if (ids.has(c.id) || digests.has(c.inputDigest))
      fail(
        "INVALID_INPUT",
        "Case IDs and input digests must be unique across all splits and attempts",
      );
    ids.add(c.id);
    digests.add(c.inputDigest);
  }
  if (policy.holdouts.some((h) => h.length < policy.minimumHoldout))
    fail("INVALID_INPUT", "Holdout smaller than minimumHoldout");
  if (policy.limits.maxFileBytes > policy.limits.maxBytes)
    fail("INVALID_INPUT", "maxFileBytes exceeds maxBytes");
}
export function evaluationPlan(policy: Policy) {
  return {
    policyDigest: digestJson(policy),
    baseline:
      "Same cases, tools, configuration, budget and verifier; without skill for create, pinned revision for improve",
    attempts: policy.holdouts.map((holdout, holdoutIndex) => ({
      holdoutIndex,
      suiteDigest: digestJson({ holdout, regression: policy.regression }),
      holdout,
      regression: policy.regression,
    })),
    policy,
  };
}
export interface EvaluationReport {
  fingerprint: string;
  baseline: { hard: number; soft: number };
  candidate: { hard: number; soft: number };
  gate: GateResult;
  reasons: string[];
  attribution: string;
}
export function evaluateEvidence(
  policy: Policy,
  manifest: Manifest,
  context: {
    digest: string;
    baseVersion: number | null;
    baseDigest: string | null;
    candidateId: string;
    step: number;
  },
  historical: { fingerprint: string; gate: GateResult }[] = [],
): EvaluationReport {
  const invalid = (message: string): never => fail("EVIDENCE_INVALID", message);
  const plan = evaluationPlan(policy);
  const suite = plan.attempts[manifest.holdoutIndex];
  if (
    !suite ||
    manifest.policyDigest !== plan.policyDigest ||
    manifest.suiteDigest !== suite.suiteDigest
  )
    invalid("Policy or suite digest mismatch");
  if (
    manifest.candidateDigest !== context.digest ||
    manifest.baseVersion !== context.baseVersion ||
    manifest.baseDigest !== context.baseDigest
  )
    invalid("Evidence does not describe this candidate and baseline");
  if (
    manifest.baselineKind !==
    (context.baseVersion === null ? "without_skill" : "revision")
  )
    invalid("Wrong baseline kind");
  if (manifest.authorExposed)
    invalid("Author has seen the holdout; a fresh holdout is required");
  const expected = new Map<
    string,
    {
      id: string;
      inputDigest: string;
      requiresIsolation: boolean;
      split: string;
    }
  >([
    ...suite!.holdout.map((c) => [c.id, { ...c, split: "holdout" }] as const),
    ...policy.regression.map(
      (c) => [c.id, { ...c, split: "regression" }] as const,
    ),
  ]);
  const seen = new Set<string>();
  const runIds = new Set<string>();
  for (const [key, value] of Object.entries(manifest.artifacts))
    if (sha256(value) !== key)
      invalid("Artifact bytes do not match artifact digest");
  const reasons: string[] = [];
  for (const pair of manifest.results) {
    const b = pair.baseline,
      c = pair.candidate;
    const spec = expected.get(b.caseId);
    const key = `${b.caseId}:${b.repetition}`;
    if (
      !spec ||
      seen.has(key) ||
      b.repetition >= policy.repetitions ||
      c.caseId !== b.caseId ||
      c.repetition !== b.repetition
    )
      invalid("Missing, duplicate or unknown case/repetition");
    seen.add(key);
    for (const r of [b, c]) {
      if (runIds.has(r.runId)) invalid("Duplicate runId");
      runIds.add(r.runId);
      if (r.split !== spec!.split || r.inputDigest !== spec!.inputDigest)
        invalid("Input digest or split mismatch");
      if (r.outcome === "infrastructure_error")
        invalid("Infrastructure errors are incomplete evidence");
      if (!(r.artifactDigest in manifest.artifacts))
        invalid("Missing result artifact");
      if (r.hard !== (r.outcome === "pass" ? 1 : 0))
        invalid("Hard score must match the verifier pass/fail outcome");
      const cfg = policy.evaluation;
      if (
        [
          "model",
          "modelVersion",
          "verifierId",
          "verifierVersion",
          "environment",
          "budget",
        ].some((k) => r[k as keyof typeof r] !== cfg[k as keyof typeof cfg]) ||
        digestJson(r.configuration) !== digestJson(cfg.configuration) ||
        digestJson(r.tools) !== digestJson(cfg.tools)
      )
        invalid("Run configuration differs from frozen policy");
      if (spec!.requiresIsolation && !r.isolated)
        invalid("Case requires isolation");
    }
    if (b.seed !== c.seed || b.isolated !== c.isolated)
      invalid("Baseline and candidate isolation/seed differ");
    if (
      spec!.split === "regression" &&
      (c.hard + policy.regressionTolerance.hard < b.hard ||
        c.soft + policy.regressionTolerance.soft < b.soft)
    )
      reasons.push(`Regression: ${b.caseId}, repetition ${b.repetition}`);
  }
  if (seen.size !== expected.size * policy.repetitions)
    invalid("Incomplete evaluation coverage");
  const holdout = manifest.results.filter(
    (r) => r.baseline.split === "holdout",
  );
  const mean = (side: "baseline" | "candidate", metric: "hard" | "soft") =>
    holdout.reduce((sum, r) => sum + r[side][metric], 0) / holdout.length;
  const baseline = {
      hard: mean("baseline", "hard"),
      soft: mean("baseline", "soft"),
    },
    candidate = {
      hard: mean("candidate", "hard"),
      soft: mean("candidate", "soft"),
    };
  const currentScore = selectGateScore(
    baseline.hard,
    baseline.soft,
    policy.metric,
    policy.mixedWeight,
  );
  const fingerprint = digestJson({
    policyDigest: plan.policyDigest,
    suiteDigest: suite!.suiteDigest,
  });
  const historicalBest = historical
    .filter((r) => r.fingerprint === fingerprint)
    .map((r) => r.gate)
    .sort((a, b) => b.best_score - a.best_score)[0];
  const best =
    historicalBest && historicalBest.best_score >= currentScore
      ? historicalBest
      : undefined;
  const gate = evaluateGate({
    candidate_skill: context.candidateId,
    cand_hard: candidate.hard,
    cand_soft: candidate.soft,
    current_skill: context.baseDigest ?? "without_skill",
    current_score: currentScore,
    best_skill: best?.best_skill ?? context.baseDigest ?? "without_skill",
    best_score: Math.max(best?.best_score ?? currentScore, currentScore),
    best_step:
      best && best.best_score >= currentScore
        ? best.best_step
        : context.step - 1,
    global_step: context.step,
    metric: policy.metric,
    mixed_weight: policy.mixedWeight,
  });
  if (gate.action === "reject")
    reasons.push("Candidate must strictly improve the baseline");
  if (
    candidate.hard < policy.thresholds.hard ||
    candidate.soft < policy.thresholds.soft
  )
    reasons.push("Absolute score thresholds not met");
  return {
    fingerprint,
    baseline,
    candidate,
    gate,
    reasons,
    attribution:
      "Verifier outcomes and soft judgments are caller-attributed attestations; artifact digests and aggregate arithmetic were checked locally.",
  };
}
