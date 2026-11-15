// Adapted from Microsoft SkillOpt v0.2.0, e4ea6a6771e797ef820cdd8bfea64c57e0481065.
// Copyright (c) 2026 Microsoft Corporation. MIT: ../vendor/skillopt/LICENSE.
// The validation wrapper below is Anagenesis code, not Microsoft behavior.
import { fail } from "./errors.js";
export type GateMetric = "hard" | "soft" | "mixed";
export interface GateResult {
  action: "accept_new_best" | "accept" | "reject";
  current_skill: string;
  current_score: number;
  best_skill: string;
  best_score: number;
  best_step: number;
}
export interface GateInput {
  candidate_skill: string;
  cand_hard: number;
  current_skill: string;
  current_score: number;
  best_skill: string;
  best_score: number;
  best_step: number;
  global_step: number;
  cand_soft?: number;
  metric?: GateMetric;
  mixed_weight?: number;
}
function validateNumbers(...values: number[]) {
  if (values.some((v) => !Number.isFinite(v)))
    fail("INVALID_INPUT", "Gate requires finite numbers");
}
export function selectGateScore(
  hard: number,
  soft: number,
  metric: GateMetric = "hard",
  mixedWeight = 0.5,
): number {
  validateNumbers(hard, soft, mixedWeight);
  if (metric === "hard") return hard;
  if (metric === "soft") return soft;
  if (metric === "mixed") {
    const w = Math.max(0, Math.min(1, mixedWeight));
    return (1 - w) * hard + w * soft;
  }
  return fail("INVALID_INPUT", "Unknown gate metric", { metric });
}
export function evaluateGate(input: GateInput): GateResult {
  const {
    candidate_skill,
    cand_hard,
    current_skill,
    current_score,
    best_skill,
    best_score,
    best_step,
    global_step,
    cand_soft = 0,
    metric = "hard",
    mixed_weight = 0.5,
  } = input;
  validateNumbers(
    cand_hard,
    current_score,
    best_score,
    best_step,
    global_step,
    cand_soft,
    mixed_weight,
  );
  const score = selectGateScore(cand_hard, cand_soft, metric, mixed_weight);
  if (score > current_score) {
    if (score > best_score)
      return {
        action: "accept_new_best",
        current_skill: candidate_skill,
        current_score: score,
        best_skill: candidate_skill,
        best_score: score,
        best_step: global_step,
      };
    return {
      action: "accept",
      current_skill: candidate_skill,
      current_score: score,
      best_skill,
      best_score,
      best_step,
    };
  }
  return {
    action: "reject",
    current_skill,
    current_score,
    best_skill,
    best_score,
    best_step,
  };
}
