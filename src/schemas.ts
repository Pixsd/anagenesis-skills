import { z } from "zod";
import { fail } from "./errors.js";
export const uuidSchema = z.string().uuid();
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(100_000);
export const skillIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
const version = z.number().int().positive();
const score = z.number().finite().min(0).max(1);
const identity = z
  .object({ producer: text, model: text, modelVersion: text })
  .strict();
const source = z
  .object({ uri: z.string().url(), revision: text, digest: digestSchema })
  .strict();
const caseSchema = z
  .object({
    id: text,
    inputDigest: digestSchema,
    requiresIsolation: z.boolean(),
  })
  .strict();
const development = caseSchema.extend({ prompt: text, expected: text });
export const policySchema = z
  .object({
    metric: z.enum(["hard", "soft", "mixed"]),
    mixedWeight: z.number().finite(),
    aggregation: z.literal("mean"),
    repetitions: z.number().int().min(1).max(100),
    minimumHoldout: z.number().int().positive(),
    thresholds: z.object({ hard: score, soft: score }).strict(),
    regressionTolerance: z.object({ hard: score, soft: score }).strict(),
    development: z.array(development).min(1),
    holdouts: z.array(z.array(caseSchema).min(1)).min(1),
    regression: z.array(caseSchema).min(1),
    limits: z
      .object({
        maxFiles: z.number().int().positive().max(10000),
        maxBytes: z.number().int().positive().max(100_000_000),
        maxFileBytes: z.number().int().positive().max(10_000_000),
      })
      .strict(),
    evaluation: z
      .object({
        model: text,
        modelVersion: text,
        configuration: z.record(z.string(), z.unknown()),
        tools: z.array(text),
        environment: text,
        budget: z.number().finite().positive(),
        verifierId: text,
        verifierVersion: text,
      })
      .strict(),
  })
  .strict();
const mutation = {
  schemaVersion: z.literal(1),
  operationId: uuidSchema,
};
const preparation = {
  ...mutation,
  skillId: skillIdSchema,
  objective: text,
  boundaries: z.array(text),
  audience: text,
  sources: z.array(source).min(1),
  examples: z.array(z.object({ input: text, expected: text }).strict()).min(1),
  successCriteria: z.array(text).min(1),
  author: identity,
  reason: text,
  policy: policySchema,
};
export const createSchema = z.object(preparation).strict();
const severity = z.enum(["none", "low", "medium", "high"]);
export const failureDimensions = [
  "knowledge",
  "toolUsage",
  "clarification",
  "style",
] as const;
export const analysisSchema = z
  .object({
    knowledge: severity,
    toolUsage: severity,
    clarification: severity,
    style: severity,
  })
  .strict();
const miningStage = z
  .object({ sources: z.array(text).min(1), summary: text })
  .strict();
export const miningSchema = z
  .object({
    workflow: miningStage,
    tools: miningStage,
    knowledge: miningStage,
    synthesis: miningStage,
  })
  .strict();
export const improveSchema = z
  .object({
    ...preparation,
    expectedVersion: version,
    feedbackIds: z.array(uuidSchema),
  })
  .strict();
const runSchema = z
  .object({
    runId: text,
    caseId: text,
    split: z.enum(["holdout", "regression"]),
    repetition: z.number().int().nonnegative(),
    inputDigest: digestSchema,
    artifactDigest: digestSchema,
    outcome: z.enum(["pass", "fail", "infrastructure_error"]),
    hard: score,
    soft: score,
    verifierId: text,
    verifierVersion: text,
    timestamp: z.string().datetime(),
    producer: text,
    model: text,
    modelVersion: text,
    configuration: z.record(z.string(), z.unknown()),
    tools: z.array(text),
    environment: text,
    budget: z.number().finite().positive(),
    seed: z.number().int().nullable(),
    origin: z.enum(["machine", "human", "agent"]),
    sessionId: text,
    isolated: z.boolean(),
  })
  .strict();
export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidateDigest: digestSchema,
    baseVersion: version.nullable(),
    baseDigest: digestSchema.nullable(),
    policyDigest: digestSchema,
    suiteDigest: digestSchema,
    holdoutIndex: z.number().int().nonnegative(),
    authorExposed: z.boolean(),
    baselineKind: z.enum(["without_skill", "revision"]),
    results: z
      .array(z.object({ baseline: runSchema, candidate: runSchema }).strict())
      .min(1),
    artifacts: z.record(z.string(), z.string()),
  })
  .strict();
export const submitSchema = z
  .object({
    ...mutation,
    candidateId: uuidSchema,
    expectedDigest: digestSchema,
    evidenceManifest: manifestSchema,
    diagnosis: z
      .array(
        z
          .object({
            evidenceIds: z.array(text).min(1),
            cause: text,
            category: z.enum([
              "skill",
              "tool",
              "data",
              "environment",
              "execution",
            ]),
            defect: z
              .enum(["knowledge", "tool_usage", "clarification", "style"])
              .optional(),
            files: z.array(text).optional(),
            sections: z.array(text).min(1),
            minimalChange: text,
            expectedTest: text,
          })
          .strict(),
      )
      .optional(),
    mining: miningSchema.optional(),
  })
  .strict();
export const restoreSchema = z
  .object({
    ...mutation,
    skillId: skillIdSchema,
    sourceVersion: version,
    expectedVersion: version,
    reason: text,
    author: identity,
  })
  .strict();
export const feedbackSchema = z
  .object({
    ...mutation,
    skillId: skillIdSchema,
    version: version.nullable(),
    artifactDigest: digestSchema.nullable(),
    runId: text,
    producer: text,
    timestamp: z.string().datetime(),
    source: source,
    observation: text,
    expected: text,
    actual: text,
    evidenceRefs: z.array(text),
    category: text,
    possibleCause: text.nullable(),
    supersedes: uuidSchema.optional(),
    analysis: analysisSchema.optional(),
    disposition: z.literal("not_skill").optional(),
  })
  .strict()
  .refine((f) => !f.disposition || f.supersedes, {
    message: "disposition requires supersedes",
    path: ["disposition"],
  });
export const historySchema = z
  .object({
    schemaVersion: z.literal(1),
    skillId: skillIdSchema,
    cursor: version.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export const resolveSchema = z
  .object({
    schemaVersion: z.literal(1),
    skillId: skillIdSchema,
    version: version.optional(),
  })
  .strict();
const transcriptText = z.string().max(200_000);
export const transcriptSchema = z
  .object({
    sessionId: text.max(200),
    project: text.max(4096),
    gitBranch: z.string().max(1000).optional(),
    startedAt: z.string().max(100).optional(),
    endedAt: z.string().max(100).optional(),
    userPrompts: z.array(transcriptText).max(1000).optional(),
    assistantFinals: z.array(transcriptText).max(1000).optional(),
    toolsUsed: z.array(z.string().max(1000)).max(1000).optional(),
    skillsUsed: z.array(z.string().max(1000)).max(1000).optional(),
    filesTouched: z.array(z.string().max(4096)).max(10_000).optional(),
    feedbackSignals: z.array(z.string().max(10_000)).max(1000).optional(),
  })
  .strict();
const fraction = z.number().finite().min(0).max(1);
/** Microsoft skillopt_sleep configuration keys that Anagenesis lets callers
 * set. Paths, backends, harvest sources and auto_adopt are fixed by the wrapper. */
export const sleepConfigSchema = z
  .object({
    max_tasks_per_night: z.number().int().min(1).max(1000),
    max_sessions_per_night: z.number().int().min(0).max(10_000),
    max_tokens_per_night: z.number().int().min(1),
    holdout_fraction: fraction,
    val_fraction: fraction,
    test_fraction: fraction,
    gate_mode: z.enum(["on", "off"]),
    gate_metric: z.enum(["hard", "soft", "mixed"]),
    gate_mixed_weight: fraction,
    gate_no_regression: z.boolean(),
    edit_budget: z.number().int().min(1).max(50),
    preferences: z.string().max(10_000),
    dream_rollouts: z.number().int().min(1).max(16),
    dream_factor: z.number().int().min(0).max(16),
    recall_k: z.number().int().min(0).max(100),
    evolve_memory: z.boolean(),
    evolve_skill: z.boolean(),
    llm_mine: z.boolean(),
    target_task_filter: z.boolean(),
    evidence_log: z.boolean(),
    evidence_max_chars: z.number().int().min(0).max(1_000_000),
    seed: z.number().int(),
    slow_update: z.literal(false),
  })
  .partial()
  .strict();
const sleepSkills = z
  .array(
    z
      .object({ skillId: skillIdSchema, expectedVersion: version.nullable() })
      .strict(),
  )
  .max(32)
  .refine(
    (skills) => new Set(skills.map((s) => s.skillId)).size === skills.length,
    {
      message: "Skill ids must be unique",
    },
  );
const sleepInput = {
  schemaVersion: z.literal(1),
  skills: sleepSkills.default([]),
  transcripts: z.array(transcriptSchema).max(1000),
  config: sleepConfigSchema.optional(),
};
export const sleepRunSchema = z
  .object({
    ...sleepInput,
    action: z.enum(["run", "dry-run"]),
    operationId: uuidSchema,
    author: identity,
    memory: z
      .object({ label: text.max(200), text: z.string().max(1_000_000) })
      .strict()
      .optional(),
  })
  .strict();
export const sleepAdoptSchema = z
  .object({
    ...mutation,
    action: z.literal("adopt"),
    sleepId: uuidSchema,
    author: identity,
  })
  .strict();
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^\//)
  .refine((s) => !/[\x00-\x1f\x7f]/.test(s), {
    message: "Paths must be absolute and contain no control characters",
  });
export const sleepScheduleSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.literal("schedule"),
    project: absolutePath,
    runner: z
      .string()
      .min(1)
      .max(10_000)
      .regex(/^[^\x00-\x1f\x7f]+$/),
    hour: z.number().int().min(0).max(23).default(3),
    minute: z.number().int().min(0).max(59).default(17),
  })
  .strict();
export const sleepEvalkitSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.literal("evalkit"),
    manifest: absolutePath,
    a: absolutePath,
    b: absolutePath.optional(),
    aa: z.boolean().default(false),
    alpha: z.number().finite().gt(0).lt(1).optional(),
    boot: z.number().int().min(1).max(1_000_000).optional(),
    seed: z.number().int().optional(),
    allowGraded: z.boolean().optional(),
  })
  .strict()
  .refine((r) => r.aa !== (r.b !== undefined), {
    message: "Specify exactly one of b or aa: true",
  });
export const sleepSchema = z.union([
  sleepRunSchema,
  sleepAdoptSchema,
  sleepScheduleSchema,
  sleepEvalkitSchema,
  z
    .object({
      schemaVersion: z.literal(1),
      action: z.literal("unschedule"),
      project: absolutePath,
      all: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      action: z.literal("cleanup"),
      sleepId: uuidSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      action: z.literal("resume"),
      sleepId: uuidSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      action: z.literal("status"),
      sleepId: uuidSchema.optional(),
      prune: z.boolean().optional(),
      retentionDays: z.number().finite().min(0).default(30),
    })
    .strict(),
  z.object({ ...sleepInput, action: z.literal("harvest") }).strict(),
]);
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    fail("INVALID_INPUT", "Request does not match schemaVersion 1", {
      issues: result.error.issues.map(({ path, message }) => ({
        path,
        message,
      })),
    });
  return result.data;
}
export type CreateRequest = z.input<typeof createSchema>;
export type ImproveRequest = z.input<typeof improveSchema>;
export type SubmitRequest = z.input<typeof submitSchema>;
export type RestoreRequest = z.input<typeof restoreSchema>;
export type FeedbackRequest = z.input<typeof feedbackSchema>;
export type HistoryRequest = z.input<typeof historySchema>;
export type ResolveRequest = z.input<typeof resolveSchema>;
export type SleepRequest = z.input<typeof sleepSchema>;
export type SleepRunRequest = z.infer<typeof sleepRunSchema>;
export type SleepAdoptRequest = z.infer<typeof sleepAdoptSchema>;
export type SleepScheduleRequest = z.infer<typeof sleepScheduleSchema>;
export type SleepEvalkitRequest = z.infer<typeof sleepEvalkitSchema>;
export type SleepConfig = z.infer<typeof sleepConfigSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
export type Mining = z.infer<typeof miningSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Manifest = z.infer<typeof manifestSchema>;
