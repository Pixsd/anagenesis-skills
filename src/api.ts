import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  Store,
  diffTrees,
  type StoreOptions,
  type Revision,
  type StoredRevision,
  type Publication,
  type Receipt,
} from "./store.js";
import { canonical, digestJson, exists, readJson, writeJson } from "./io.js";
import { fail, AnagenesisError, normalizeError } from "./errors.js";
import {
  snapshotTree,
  validateTree,
  materializeTree,
  fromEntries,
  type Snapshot,
  type TreeEntry,
} from "./tree.js";
import {
  evaluateEvidence,
  evaluationPlan,
  validatePolicy,
} from "./evaluation.js";
import {
  analyzeFailure,
  checkSubmission,
  creationStages,
  defectMap,
  groupFeedback,
  skillLengthLimit,
  skillWarnings,
} from "./forge.js";
import {
  parse,
  createSchema,
  improveSchema,
  submitSchema,
  restoreSchema,
  feedbackSchema,
  historySchema,
  resolveSchema,
  type CreateRequest,
  type ImproveRequest,
  type SubmitRequest,
  type RestoreRequest,
  type FeedbackRequest,
  type HistoryRequest,
  type ResolveRequest,
  type SleepRequest,
} from "./schemas.js";
import { sleepNight } from "./sleep/night.js";
export type StoreInput = Store | StoreOptions;
interface Candidate {
  schemaVersion: 1;
  candidateId: string;
  skillId: string;
  baseVersion: number | null;
  baseDigest: string | null;
  baseCommit: string | null;
  kind: "create" | "improve";
  request: CreateRequest | ImproveRequest;
  receipt: Receipt;
  state: "draft" | "rejected" | "published" | "stale";
}
export interface CandidateResult {
  candidateId: string;
  briefPath: string;
  workspacePath: string;
  baseVersion: number | null;
  baseDigest: string | null;
  evaluationPlan: ReturnType<typeof evaluationPlan>;
}
export interface Rejected {
  status: "rejected";
  candidateId: string;
  reasons: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }[];
  nextHoldoutIndex: number | null;
}
const candidatePath = (s: Store, id: string) =>
  path.join(s.root, "candidates", id + ".json");
async function execute<T>(
  input: StoreInput,
  work: (s: Store) => Promise<T>,
): Promise<T> {
  try {
    return await work(input instanceof Store ? input : await Store.open(input));
  } catch (e) {
    throw normalizeError(e);
  }
}
async function candidate(s: Store, id: string): Promise<Candidate> {
  const p = candidatePath(s, id);
  if (!(await exists(p))) fail("NOT_FOUND", "Candidate not found");
  const c = await readJson<Candidate>(p);
  if (
    c.candidateId !== id ||
    digestJson({ kind: c.kind, request: c.request }) !== c.receipt.inputDigest
  )
    fail("STORE_CORRUPT", "Candidate metadata was altered");
  const operation = await readJson<{ inputDigest: string }>(
    path.join(s.root, "operations", c.receipt.operationId + ".json"),
  );
  if (operation.inputDigest !== c.receipt.inputDigest)
    fail("STORE_CORRUPT", "Candidate policy provenance mismatch");
  return c;
}
function active(s: Store, skillId: string) {
  return s.chain(skillId)[0] ?? null;
}
function checkBase(
  c: {
    baseVersion: number | null;
    baseDigest: string | null;
    baseCommit: string | null;
  },
  current: StoredRevision | null,
) {
  if (
    (current?.metadata.version ?? null) !== c.baseVersion ||
    (current?.metadata.digest ?? null) !== c.baseDigest ||
    (current?.commit ?? null) !== c.baseCommit
  )
    fail(
      "STALE_BASE",
      "The active skill has changed; prepare a new candidate or restore request",
    );
}
async function feedbackById(s: Store, id: string) {
  const p = path.join(s.root, "feedback", id + ".json");
  if (!(await exists(p)))
    fail("NOT_FOUND", "Feedback not found", { feedbackId: id });
  return readJson<FeedbackRequest & { feedbackId: string; assignment: string }>(
    p,
  );
}
async function prepare(
  s: Store,
  kind: Candidate["kind"],
  request: CreateRequest | ImproveRequest,
): Promise<CandidateResult> {
  validatePolicy(request.policy);
  return s.operation(kind, request, (receipt) =>
    s.lock("skill:" + request.skillId, async () => {
      const p = candidatePath(s, request.operationId);
      let c: Candidate;
      if (await exists(p)) c = await candidate(s, request.operationId);
      else {
        const current = active(s, request.skillId);
        if (kind === "create" && current)
          fail("ALREADY_EXISTS", "Skill already exists");
        if (kind === "improve" && !current)
          fail("NOT_FOUND", "Skill does not exist");
        if (
          kind === "improve" &&
          current!.metadata.version !==
            (request as ImproveRequest).expectedVersion
        )
          fail("STALE_BASE", "expectedVersion is not active");
        c = {
          schemaVersion: 1,
          candidateId: request.operationId,
          skillId: request.skillId,
          kind,
          request,
          receipt,
          baseVersion: current?.metadata.version ?? null,
          baseDigest: current?.metadata.digest ?? null,
          baseCommit: current?.commit ?? null,
          state: "draft",
        };
        await writeJson(p, c);
      }
      const selected = await Promise.all(
        ("feedbackIds" in request ? request.feedbackIds : []).map((id) =>
          feedbackById(s, id),
        ),
      );
      if (
        new Set(selected.map((f) => f.feedbackId)).size !== selected.length ||
        selected.some((f) => f.skillId !== request.skillId)
      )
        fail(
          "INVALID_INPUT",
          "Feedback must be unique and belong to this skill",
        );
      const workspace = path.join(s.root, "workspaces", c.candidateId),
        skill = path.join(workspace, "skill");
      await fs.mkdir(workspace, { recursive: true });
      if (!(await exists(skill))) {
        const staging = skill + ".tmp-" + randomUUID();
        if (c.baseCommit)
          await materializeTree(
            s.loadTree(s.revision(c.baseCommit, c.skillId)),
            staging,
          );
        else await fs.mkdir(staging);
        await fs.rename(staging, skill);
      }
      const exposedCases = (await attempts(s))
        .filter((a) => a.skillId === c.skillId)
        .flatMap((a) => a.exposed);
      const brief = {
        exposedCasesNowDevelopment: exposedCases,
        schemaVersion: 1,
        skillId: c.skillId,
        objective: request.objective,
        boundaries: request.boundaries,
        audience: request.audience,
        sources: request.sources,
        examples: request.examples,
        successCriteria: request.successCriteria,
        baseVersion: c.baseVersion,
        baseDigest: c.baseDigest,
        feedback: selected,
        ...(kind === "improve"
          ? { failureGroups: groupFeedback(selected), defectMap }
          : {
              creation: {
                instruction:
                  "Build the skill in four stages and declare in submit.mining the source URIs or development case ids used by each stage.",
                stages: creationStages,
              },
            }),
        lengthGuidance: `Keep SKILL.md within ${skillLengthLimit.lines} lines and ${skillLengthLimit.characters} characters; move detail into references/. Longer files publish with a warning.`,
        evaluationPlan: evaluationPlan(request.policy),
        development: request.policy.development,
        instructions: [
          "Write the substantive skill/SKILL.md yourself in this session, with frontmatter name equal to skillId and a nonempty description. The package does not call a model.",
          "Keep process evidence outside skill/. Read only development cases while authoring; the external evaluator retains holdout prompts, expected outputs and detailed results until submit.",
          "Run baseline and candidate using identical frozen settings, cases, budget, tools and criteria; baseline is without skill for create and the pinned base revision for improve.",
          "Submit all paired results and UTF-8 artifact bytes keyed by SHA-256. Hard scores are pass=1/fail=0; soft judgments are attributed to the stated verifier. Infrastructure errors are incomplete evidence.",
          "Each attempt consumes a holdout. Revealed cases become development; use the next precommitted holdout or create a new candidate/policy and comparable baseline.",
          "Compute expectedDigest using snapshotTree(workspacePath).digest, then use schemaVersion 1 submit and a fresh operationId.",
        ],
        manifestFormat: {
          schemaVersion: 1,
          candidateDigest: "<tree SHA-256>",
          baseVersion: c.baseVersion,
          baseDigest: c.baseDigest,
          policyDigest: digestJson(request.policy),
          suiteDigest: "<selected attempt suiteDigest>",
          holdoutIndex: 0,
          authorExposed: false,
          baselineKind: c.baseVersion ? "revision" : "without_skill",
          results: "See Manifest type and examples/workflow.mjs",
          artifacts: "{ sha256: UTF-8 artifact contents }",
        },
        diagnosis:
          kind === "improve"
            ? {
                instruction:
                  "Complete submit.diagnosis: distinguish skill defects from tool, data, environment and execution failures. Non-skill errors do not alone justify rewriting. Explain whether late feedback still applies to the base. Skill entries name a defect (knowledge, tool_usage, clarification, style) and every file they change; every changed file must be covered.",
                fields: [
                  "evidenceIds",
                  "cause",
                  "category",
                  "defect",
                  "files",
                  "sections",
                  "minimalChange",
                  "expectedTest",
                ],
              }
            : null,
      };
      const briefPath = path.join(workspace, "brief.json");
      await writeJson(briefPath, brief);
      const result = {
        candidateId: c.candidateId,
        briefPath,
        workspacePath: skill,
        baseVersion: c.baseVersion,
        baseDigest: c.baseDigest,
        evaluationPlan: evaluationPlan(request.policy),
      };
      await s.phase("after-prepare");
      return result;
    }),
  );
}
export function create(store: StoreInput, input: CreateRequest) {
  return execute(store, (s) =>
    prepare(s, "create", parse(createSchema, input)),
  );
}
export function improve(store: StoreInput, input: ImproveRequest) {
  return execute(store, (s) =>
    prepare(s, "improve", parse(improveSchema, input)),
  );
}
interface Attempt {
  request: SubmitRequest;
  operationId: string;
  candidateId: string;
  skillId: string;
  holdoutIndex: number;
  exposed: { id: string; inputDigest: string }[];
  snapshot?: {
    entries: (Omit<TreeEntry, "data"> & { base64?: string })[];
    digest: string;
  };
  error?: string;
}
async function attempts(s: Store): Promise<Attempt[]> {
  return Promise.all(
    (await fs.readdir(path.join(s.root, "attempts")))
      .filter((p) => p.endsWith(".json"))
      .map((p) => readJson<Attempt>(path.join(s.root, "attempts", p))),
  );
}
export function submit(
  store: StoreInput,
  input: SubmitRequest,
): Promise<Publication | Rejected> {
  return execute(store, async (s) => {
    const request = parse(submitSchema, input);
    return s.operation<Publication | Rejected>("submit", request, (receipt) =>
      s.lock("candidate:" + request.candidateId, async () => {
        const c = await candidate(s, request.candidateId);
        return s.lock("skill:" + c.skillId, async () => {
          const current = active(s, c.skillId);
          try {
            checkBase(c, current);
          } catch (e) {
            c.state = "stale";
            await writeJson(candidatePath(s, c.candidateId), c);
            throw e;
          }
          if (c.state === "published" || c.state === "stale")
            fail("STALE_BASE", "Candidate is no longer publishable");
          const policy = c.request.policy;
          const p = path.join(
            s.root,
            "attempts",
            request.operationId + ".json",
          );
          let attempt: Attempt;
          if (await exists(p)) {
            attempt = await readJson<Attempt>(p);
            if (
              digestJson({ kind: "submit", request: attempt.request }) !==
              receipt.inputDigest
            )
              fail(
                "STORE_CORRUPT",
                "Attempt evidence differs from its receipt",
              );
          } else {
            const previous = await attempts(s);
            const consumed = previous
              .filter((a) => a.candidateId === c.candidateId)
              .map((a) => a.holdoutIndex);
            const next = policy.holdouts.findIndex(
              (_, i) => !consumed.includes(i),
            );
            if (next < 0 || request.evidenceManifest.holdoutIndex !== next)
              fail(
                "EVIDENCE_INVALID",
                "Use the next unused precommitted holdout",
                { nextHoldoutIndex: next < 0 ? null : next },
              );
            const exposed = policy.holdouts[next]!;
            if (
              previous.some(
                (a) =>
                  a.skillId === c.skillId &&
                  a.exposed.some((e) =>
                    exposed.some(
                      (h) => e.id === h.id || e.inputDigest === h.inputDigest,
                    ),
                  ),
              )
            )
              fail(
                "EVIDENCE_INVALID",
                "Holdout was exposed in a previous attempt; create a candidate with fresh cases",
              );
            attempt = {
              request,
              operationId: request.operationId,
              candidateId: c.candidateId,
              skillId: c.skillId,
              holdoutIndex: next,
              exposed,
            };
            // Freeze bytes before any evaluation; retries reuse this exact snapshot.
            try {
              const tree = await snapshotTree(
                path.join(s.root, "workspaces", c.candidateId, "skill"),
                policy.limits,
              );
              checkSubmission({
                kind: c.kind,
                diagnosis: request.diagnosis,
                mining: request.mining,
                evidenceIds: new Set([
                  ...("feedbackIds" in c.request ? c.request.feedbackIds : []),
                  ...policy.development.map((d) => d.id),
                  ...c.request.sources.map((d) => d.uri),
                ]),
                sourceRefs: new Set([
                  ...c.request.sources.map((d) => d.uri),
                  ...policy.development.map((d) => d.id),
                ]),
                base: current ? s.loadTree(current) : null,
                candidate: tree,
              });
              attempt.snapshot = {
                digest: tree.digest,
                entries: tree.entries.map(({ data, ...e }) => ({
                  ...e,
                  ...(data ? { base64: data.toString("base64") } : {}),
                })),
              };
            } catch (e) {
              if (
                e instanceof AnagenesisError &&
                e.code === "VALIDATION_FAILED"
              )
                attempt.error = e.message;
              else throw e;
            }
            await writeJson(p, attempt);
          }
          const reject = async (error: AnagenesisError): Promise<Rejected> => {
            c.state = "rejected";
            await writeJson(candidatePath(s, c.candidateId), c);
            return {
              status: "rejected",
              candidateId: c.candidateId,
              reasons: [error.toJSON()],
              nextHoldoutIndex: policy.holdouts[attempt.holdoutIndex + 1]
                ? attempt.holdoutIndex + 1
                : null,
            };
          };
          try {
            if (attempt.error) fail("VALIDATION_FAILED", attempt.error);
            if (!attempt.snapshot)
              fail("STORE_CORRUPT", "Attempt snapshot missing");
            const tree = fromEntries(
              attempt.snapshot.entries.map(({ base64, ...e }) => ({
                ...e,
                ...(base64 !== undefined
                  ? { data: Buffer.from(base64, "base64") }
                  : {}),
              })),
            );
            if (tree.digest !== attempt.snapshot.digest)
              fail("STORE_CORRUPT", "Frozen snapshot corrupted");
            if (tree.digest !== request.expectedDigest)
              fail(
                "EVIDENCE_INVALID",
                "expectedDigest does not match frozen candidate",
              );
            validateTree(tree, c.skillId, policy.limits);
            const report = evaluateEvidence(
              policy,
              request.evidenceManifest,
              {
                digest: tree.digest,
                baseVersion: c.baseVersion,
                baseDigest: c.baseDigest,
                candidateId: c.candidateId,
                step: (current?.metadata.version ?? 0) + 1,
              },
              s
                .chain(c.skillId)
                .flatMap((r) => (r.metadata.report ? [r.metadata.report] : [])),
            );
            if (report.reasons.length)
              fail("VALIDATION_FAILED", "Evaluation rejected candidate", {
                reasons: report.reasons,
                report,
              });
            await s.assertDedicated();
            checkBase(c, active(s, c.skillId));
            const before = current ? s.loadTree(current) : null;
            const metadata: Revision = {
              schemaVersion: 1,
              skillId: c.skillId,
              version: (current?.metadata.version ?? 0) + 1,
              digest: tree.digest,
              algorithm: tree.algorithm,
              parent: current?.commit ?? null,
              timestamp: new Date().toISOString(),
              receipt,
              kind: "submit",
              candidateId: c.candidateId,
              author: c.request.author,
              reason: c.request.reason,
              sources: c.request.sources,
              feedbackIds:
                "feedbackIds" in c.request ? c.request.feedbackIds : [],
              policy,
              report,
              diff: diffTrees(before, tree),
              entries: tree.entries.map(({ data: _, ...e }) => e),
              evidence: request.evidenceManifest,
              ...(request.diagnosis ? { diagnosis: request.diagnosis } : {}),
              ...(request.mining ? { mining: request.mining } : {}),
              ...(skillWarnings(tree).length
                ? { warnings: skillWarnings(tree) }
                : {}),
            };
            const result = await s.publish(tree, metadata);
            c.state = "published";
            await writeJson(candidatePath(s, c.candidateId), c);
            return result;
          } catch (e) {
            if (
              e instanceof AnagenesisError &&
              ["EVIDENCE_INVALID", "VALIDATION_FAILED"].includes(e.code)
            )
              return reject(e);
            throw e;
          }
        });
      }),
    );
  });
}
export function history(store: StoreInput, input: HistoryRequest) {
  return execute(store, async (s) => {
    const req = parse(historySchema, input);
    const chain = s.chain(req.skillId);
    if (!chain.length) fail("NOT_FOUND", "Skill not found");
    const eligible = chain.filter(
      (r) => !req.cursor || r.metadata.version < req.cursor,
    );
    const revisions = eligible.slice(0, req.limit);
    return {
      skillId: req.skillId,
      revisions,
      nextCursor:
        eligible.length > req.limit ? revisions.at(-1)!.metadata.version : null,
    };
  });
}
export function resolve(store: StoreInput, input: ResolveRequest) {
  return execute(store, async (s) => {
    const req = parse(resolveSchema, input);
    const head = s.head(req.skillId); // Pin exactly one observed ref.
    const rev = s
      .chain(req.skillId, head)
      .find((r) => !req.version || r.metadata.version === req.version);
    if (!rev) fail("NOT_FOUND", "Skill revision not found");
    return {
      skillId: req.skillId,
      version: rev.metadata.version,
      commit: rev.commit,
      digest: rev.metadata.digest,
      path: await s.materialize(rev),
    };
  });
}
export function restore(store: StoreInput, input: RestoreRequest) {
  return execute(store, async (s) => {
    const req = parse(restoreSchema, input);
    return s.operation("restore", req, (receipt) =>
      s.lock("skill:" + req.skillId, async () => {
        const chain = s.chain(req.skillId);
        const current = chain[0];
        if (!current) fail("NOT_FOUND", "Skill not found");
        if (current.metadata.version !== req.expectedVersion)
          fail("STALE_BASE", "expectedVersion is not active");
        const source = chain.find(
          (r) => r.metadata.version === req.sourceVersion,
        );
        if (!source) fail("NOT_FOUND", "Source version not found");
        const tree = s.loadTree(source);
        validateTree(tree, req.skillId, source.metadata.policy.limits);
        const metadata: Revision = {
          schemaVersion: 1,
          skillId: req.skillId,
          version: current.metadata.version + 1,
          digest: tree.digest,
          algorithm: tree.algorithm,
          parent: current.commit,
          timestamp: new Date().toISOString(),
          receipt,
          kind: "restore",
          restoredFrom: req.sourceVersion,
          sourceDigest: source.metadata.digest,
          author: req.author,
          reason: req.reason,
          sources: source.metadata.sources,
          feedbackIds: source.metadata.feedbackIds,
          policy: source.metadata.policy,
          report: null,
          diff: diffTrees(s.loadTree(current), tree),
          entries: tree.entries.map(({ data: _, ...e }) => e),
          ...(skillWarnings(tree).length
            ? { warnings: skillWarnings(tree) }
            : {}),
        };
        if (s.head(req.skillId) !== current.commit)
          fail("STALE_BASE", "Skill changed before restore");
        return s.publish(tree, metadata);
      }),
    );
  });
}
export function recordFeedback(store: StoreInput, input: FeedbackRequest) {
  return execute(store, async (s) => {
    const req = parse(feedbackSchema, input);
    return s.operation("feedback", req, () =>
      s.lock("skill:" + req.skillId, async () => {
        if (req.version !== null) {
          const revision = s
            .chain(req.skillId)
            .find((r) => r.metadata.version === req.version);
          if (!revision) fail("NOT_FOUND", "Feedback revision not found");
          if (req.artifactDigest !== revision.metadata.digest)
            fail(
              "INVALID_INPUT",
              "Feedback digest does not match the used revision",
            );
        } else if (req.artifactDigest !== null)
          fail(
            "INVALID_INPUT",
            "Unassigned feedback must not claim a revision digest",
          );
        if (req.supersedes) {
          const old = await feedbackById(s, req.supersedes);
          if (old.skillId !== req.skillId)
            fail(
              "INVALID_INPUT",
              "Superseded feedback belongs to another skill",
            );
        }
        const feedbackId = req.operationId;
        const result = {
          ...req,
          feedbackId,
          assignment: req.version === null ? "unassigned" : "assigned",
          ...(req.analysis ? { failure: analyzeFailure(req.analysis) } : {}),
        };
        const p = path.join(s.root, "feedback", feedbackId + ".json");
        if (await exists(p)) {
          if (canonical(await readJson(p)) !== canonical(result))
            fail("STORE_CORRUPT", "Immutable feedback differs from request");
        } else await writeJson(p, result);
        return result;
      }),
    );
  });
}
/** Drive a handoff night, adopt its proposal, clean data, or run upstream utilities. */
export function sleep(store: StoreInput, input: SleepRequest) {
  return execute(store, (s) => sleepNight(s, input));
}
