// SkillForge mechanisms (Liu et al., arXiv:2604.08618v2, §§2.4, 2.6–2.7,
// App. A, C, E), reimplemented with Anagenesis wording. No SkillForge code or
// text is reused.
import { fail } from "./errors.js";
import type { Snapshot } from "./tree.js";
import { failureDimensions, type Analysis, type Mining } from "./schemas.js";

export type FailureDimension = (typeof failureDimensions)[number];
export interface FailureAnalysis {
  verdict: "failed" | "passed";
  primaryCategory: FailureDimension | null;
}
const rank = { none: 0, low: 1, medium: 2, high: 3 } as const;

/** One high or at least two medium severities fail; the highest severity is
 * primary, ties broken in the order knowledge > toolUsage > clarification > style. */
export function analyzeFailure(analysis: Analysis): FailureAnalysis {
  const levels: number[] = failureDimensions.map((d) => rank[analysis[d]]);
  const failed =
    levels.some((l) => l === 3) || levels.filter((l) => l === 2).length >= 2;
  const top = Math.max(...levels);
  return {
    verdict: failed ? "failed" : "passed",
    primaryCategory: top === 0 ? null : failureDimensions[levels.indexOf(top)]!,
  };
}

/** Category → skill defect the diagnosis should look for (Table 4, our words). */
export const defectMap = {
  knowledge:
    "Missing or wrong domain facts, procedures or reference material in the skill",
  toolUsage:
    "Missing, unclear or wrong guidance on which tools to call, with which arguments and in which order",
  clarification:
    "The skill does not tell the agent when and how to ask for missing information",
  style:
    "Output format, tone or structure rules are missing or contradict the expected result",
} satisfies Record<FailureDimension, string>;

interface AnalyzedFeedback {
  feedbackId: string;
  timestamp: string;
  analysis?: Analysis;
  failure?: FailureAnalysis;
}
const severityOf = (f: AnalyzedFeedback) =>
  f.analysis && f.failure?.primaryCategory
    ? rank[f.analysis[f.failure.primaryCategory]]
    : 0;

/** Groups feedback by primary category and picks up to k representatives,
 * most severe first, then oldest. Feedback without analysis is "unclassified". */
export function groupFeedback(feedback: AnalyzedFeedback[], k = 3) {
  const groups = new Map<string, AnalyzedFeedback[]>();
  for (const f of feedback) {
    const key = f.failure?.primaryCategory ?? "unclassified";
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([category, items]) => ({
      category,
      count: items.length,
      representatives: [...items]
        .sort(
          (a, b) =>
            severityOf(b) - severityOf(a) ||
            a.timestamp.localeCompare(b.timestamp) ||
            a.feedbackId.localeCompare(b.feedbackId),
        )
        .slice(0, k)
        .map((f) => f.feedbackId),
      defect:
        category in defectMap
          ? defectMap[category as FailureDimension]
          : "Classify before diagnosing",
    }));
}

export const creationStages = {
  workflow:
    "Extract the end-to-end task workflow and its decision points from the sources",
  tools:
    "Identify the tools the agent needs, with arguments, order and failure handling",
  knowledge:
    "Collect the domain facts, constraints and references the agent cannot infer",
  synthesis:
    "Merge the stages into SKILL.md; move long detail into references/",
} satisfies Record<keyof Mining, string>;

interface Diagnosis {
  evidenceIds: string[];
  category: string;
  defect?: string;
  files?: string[];
}
const invalid = (message: string, details?: Record<string, unknown>): never =>
  fail("EVIDENCE_INVALID", message, details);

/** Structural SkillForge checks run before a holdout attempt is frozen. */
export function checkSubmission(input: {
  kind: "create" | "improve";
  diagnosis?: Diagnosis[];
  mining?: Mining;
  evidenceIds: Set<string>;
  sourceRefs: Set<string>;
  base: Snapshot | null;
  candidate: Snapshot;
}) {
  const { kind, diagnosis, mining, base, candidate } = input;
  if (kind === "create") {
    if (!mining)
      return invalid(
        "Creation requires mining: the sources used in each of the four stages",
      );
    const unknown = Object.values(mining)
      .flatMap((s) => s.sources)
      .filter((r) => !input.sourceRefs.has(r));
    if (unknown.length)
      invalid("Mining references unknown sources", { sources: unknown });
  }
  if (kind === "improve") {
    if (!diagnosis?.some((d) => d.category === "skill"))
      return invalid("Improvement requires an evidence-linked skill diagnosis");
    if (
      diagnosis.some((d) =>
        d.evidenceIds.some((id) => !input.evidenceIds.has(id)),
      )
    )
      invalid("Diagnosis references unknown evidence");
    const skill = diagnosis.filter((d) => d.category === "skill");
    if (skill.some((d) => !d.defect || !d.files?.length))
      invalid("Skill diagnoses must name a defect and the files they change");
    const before = new Map(base?.entries.map((e) => [e.path, e]) ?? []);
    const after = new Map(candidate.entries.map((e) => [e.path, e]));
    const declared = new Set(diagnosis.flatMap((d) => d.files ?? []));
    const missing = [...declared].filter(
      (p) => !before.has(p) && !after.has(p),
    );
    if (missing.length)
      invalid("Diagnosis names files that do not exist", { files: missing });
    const changed = [
      ...[...after.values()].filter((e) => {
        const old = before.get(e.path);
        return !old || old.digest !== e.digest || old.mode !== e.mode;
      }),
      ...[...before.values()].filter((e) => !after.has(e.path)),
    ]
      .filter((e) => e.type === "file")
      .map((e) => e.path);
    const undeclared = changed.filter((p) => !declared.has(p));
    if (base && undeclared.length)
      invalid("Every changed file must appear in a diagnosis", {
        files: undeclared,
      });
  }
}

export const skillLengthLimit = { lines: 500, characters: 10_000 };
/** SKILL.md length warning (Optimizer, App. A/E): never a rejection. */
export function skillWarnings(tree: Snapshot): string[] {
  const data = tree.entries.find((e) => e.path === "SKILL.md")?.data;
  if (!data) return [];
  const text = data.toString("utf8");
  return text.split("\n").length > skillLengthLimit.lines ||
    [...text].length > skillLengthLimit.characters
    ? ["skill_md_too_long"]
    : [];
}
