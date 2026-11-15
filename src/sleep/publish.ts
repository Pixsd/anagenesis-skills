// Publication of Sleep proposals as `kind: "sleep"` revisions.
import { createHash } from "node:crypto";
import {
  diffTrees,
  type Publication,
  type Revision,
  type Store,
} from "../store.js";
import { validateTree, type Snapshot } from "../tree.js";
import { fail } from "../errors.js";
import { sha256 } from "../io.js";
import { skillWarnings } from "../forge.js";
import type { Policy } from "../schemas.js";

export const SKILLOPT_PIN = "45f65ca04f5f6713bca7b9797b495696ba812751";
/** Upstream `managed_skill_name`: the skill Sleep creates when no target exists. */
export const MANAGED_SKILL = "skillopt-sleep-learned";
export const upstreamSource = {
  uri: `https://github.com/microsoft/SkillOpt/tree/${SKILLOPT_PIN}`,
  revision: SKILLOPT_PIN,
  digest: sha256(`microsoft/SkillOpt@${SKILLOPT_PIN}`),
};

/** RFC 4122 UUID v5 of `name` in the namespace `namespace` (a UUID). */
export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) fail("INVALID_INPUT", "Namespace must be a UUID");
  const h = createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(name, "utf8")]))
    .digest()
    .subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
/** One publication per skill of a night, so a partial crash resumes the rest. */
export const sleepOperationId = (sleepId: string, skillId: string) =>
  uuidV5(sleepId, skillId);

const synthetic = (id: string) => ({
  id: `skillopt-sleep:${id}`,
  inputDigest: sha256(`skillopt-sleep:${id}`),
  requiresIsolation: false,
});
/** Declared policy of the managed skill's first revision. Sleep evaluates with
 * its own self-generated split; this policy only records limits and provenance. */
export function managedPolicy(): Policy {
  return {
    metric: "mixed",
    mixedWeight: 0.5,
    aggregation: "mean",
    repetitions: 1,
    minimumHoldout: 1,
    thresholds: { hard: 0, soft: 0 },
    regressionTolerance: { hard: 0, soft: 0 },
    development: [
      {
        ...synthetic("development"),
        prompt: "Tasks mined by SkillOpt Sleep from session transcripts",
        expected: "Held-out improvement under the Microsoft gate",
      },
    ],
    holdouts: [[synthetic("held-out")]],
    regression: [synthetic("regression")],
    limits: { maxFiles: 1000, maxBytes: 10_000_000, maxFileBytes: 1_000_000 },
    evaluation: {
      model: "calling-agent",
      modelVersion: "declared-by-caller",
      configuration: { backend: "handoff" },
      tools: ["skillopt_sleep"],
      environment: "anagenesis-sleep",
      budget: 400_000,
      verifierId: "skillopt-sleep-gate",
      verifierVersion: SKILLOPT_PIN,
    },
  };
}

export interface SleepPublication {
  sleepId: string;
  skillId: string;
  /** Active version the night was pinned to; null only for the managed skill. */
  expectedVersion: number | null;
  tree: Snapshot;
  author: { producer: string; model: string; modelVersion: string };
  reason: string;
  feedbackIds: string[];
  /** Night provenance: configuration, gate, scores, edits, prompt hashes. */
  sleep: Record<string, unknown>;
}

/** Adoption already holds the skill lock across upstream application and snapshotting. */
export function publishSleep(
  s: Store,
  input: SleepPublication,
  skillLockHeld = false,
): Promise<Publication> {
  const { tree, ...rest } = input;
  const request = {
    ...rest,
    operationId: sleepOperationId(input.sleepId, input.skillId),
    digest: tree.digest,
  };
  return s.operation("sleep-adopt", request, (receipt) => {
    const publish = async () => {
      const current = s.chain(input.skillId)[0] ?? null;
      if ((current?.metadata.version ?? null) !== input.expectedVersion)
        fail("STALE_BASE", "The skill changed since the night was pinned");
      if (!current && input.skillId !== MANAGED_SKILL)
        fail("NOT_FOUND", "Sleep can only create the managed skill");
      const policy = current?.metadata.policy ?? managedPolicy();
      validateTree(tree, input.skillId, policy.limits);
      const warnings = skillWarnings(tree);
      const metadata: Revision = {
        schemaVersion: 1,
        skillId: input.skillId,
        version: (current?.metadata.version ?? 0) + 1,
        digest: tree.digest,
        algorithm: tree.algorithm,
        parent: current?.commit ?? null,
        timestamp: new Date().toISOString(),
        receipt,
        kind: "sleep",
        author: input.author,
        reason: input.reason,
        sources: current?.metadata.sources ?? [upstreamSource],
        feedbackIds: input.feedbackIds,
        policy,
        report: null,
        diff: diffTrees(current ? s.loadTree(current) : null, tree),
        entries: tree.entries.map(({ data: _, ...e }) => e),
        sleep: { sleepId: input.sleepId, pin: SKILLOPT_PIN, ...input.sleep },
        ...(warnings.length ? { warnings } : {}),
      };
      return s.publish(tree, metadata);
    };
    return skillLockHeld
      ? publish()
      : s.lock("skill:" + input.skillId, publish);
  });
}
