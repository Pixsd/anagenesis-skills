// The Sleep night state machine. Microsoft's `skillopt_sleep` runs unchanged in
// Python with its handoff backend; this module pins the input, drives the
// rounds, keeps every byte inside the store and records each night's state.
//
// States: pending ⇄ pending → staged | rejected | idle | reported.
// Adoption runs upstream once more; cleaned nights retain their receipts.
import * as fs from "node:fs/promises";
import path from "node:path";
import { fail } from "../errors.js";
import { digestJson, exists, readJson, sha256, writeJson } from "../io.js";
import type { Store } from "../store.js";
import { materializeTree } from "../tree.js";
import {
  parse,
  sleepSchema,
  type FeedbackRequest,
  type SleepConfig,
  type SleepModels,
  type SleepRunRequest,
  type Transcript,
} from "../schemas.js";
import { MANAGED_SKILL } from "./publish.js";
import {
  adoptNight,
  cleanupNight,
  discardNight,
  type Adoption,
} from "./adopt.js";
import { sleepUtility } from "./utility.js";
import { findPython, pythonEnv, runPython, type Python } from "./python.js";

export type NightState =
  | "pending"
  | "staged"
  | "rejected"
  | "idle"
  | "reported"
  | "adopted"
  | "cleaned";
export interface NightRecord {
  schemaVersion: 1;
  sleepId: string;
  action: "run" | "dry-run";
  inputDigest: string;
  createdAt: string;
  author: SleepRunRequest["author"];
  skill: {
    skillId: string;
    expectedVersion: number | null;
    commit: string | null;
    digest: string | null;
  };
  skills?: NightRecord["skill"][];
  memory?: { label: string; baseSha256: string };
  adoption?: Adoption;
  feedbackIds: string[];
  config: SleepConfig;
  state: NightState;
  rounds: number;
  models?: SleepModels;
  pending?: { count: number; items?: { id: string; kind: Kind }[] };
  result?: Record<string, unknown>;
  reason?: string;
}

const TERMINAL: NightState[] = [
  "staged",
  "rejected",
  "idle",
  "reported",
  "adopted",
  "cleaned",
];
/** Fewer LLM-mined tasks than this ends the night idle (owner decision). */
export const MIN_MINED_TASKS = 3;
const ROUND_TIMEOUT_MS = 30 * 60_000;

export const nightDir = (s: Store, id: string) =>
  path.join(s.root, "sleep", "nights", id);
export const paths = (s: Store, id: string) => {
  const root = nightDir(s, id);
  return {
    root,
    run: path.join(root, "run.json"),
    home: path.join(root, "home"),
    tmp: path.join(root, "tmp"),
    project: path.join(root, "project"),
    handoff: path.join(root, "handoff"),
    report: path.join(root, "report.json"),
    claudeHome: path.join(s.root, "sleep", "state", "claude"),
  };
};

export async function readNight(s: Store, id: string): Promise<NightRecord> {
  const p = paths(s, id).run;
  if (!(await exists(p))) fail("NOT_FOUND", "Sleep night not found");
  const night = await readJson<NightRecord>(p);
  if (night.schemaVersion !== 1 || night.sleepId !== id)
    fail("STORE_CORRUPT", "Sleep night record is invalid");
  // Nights saved before prompts carried a kind: rebuild it from the handoff.
  const handoff = path.join(paths(s, id).handoff, "pending.json");
  if (night.state === "pending" && night.pending && !night.pending.items)
    if (await exists(handoff)) {
      const { pending } = await readJson<{
        pending: { id: string; prompt: string }[];
      }>(handoff);
      night.pending.items = pending.map((i) => ({
        id: i.id,
        kind: promptKind(i.prompt),
      }));
    }
  return night;
}
export const writeNight = (s: Store, night: NightRecord) =>
  writeJson(paths(s, night.sleepId).run, night);

/** Public view of a night: what to do next and where. */
export function view(s: Store, night: NightRecord) {
  const p = paths(s, night.sleepId);
  return {
    status: night.state,
    sleepId: night.sleepId,
    action: night.action,
    skillId: night.skill.skillId,
    expectedVersion: night.skill.expectedVersion,
    rounds: night.rounds,
    ...(night.state === "pending"
      ? {
          pending: {
            count: night.pending?.count ?? 0,
            items: night.pending?.items ?? [],
            ...(night.models ? { models: night.models } : {}),
            pendingPath: path.join(p.handoff, "pending.json"),
            promptsPath: path.join(p.handoff, "PROMPTS.md"),
            answersDir: path.join(p.handoff, "answers"),
          },
        }
      : {}),
    ...(night.reason ? { reason: night.reason } : {}),
    ...(night.result ? { result: night.result } : {}),
    ...(night.adoption?.completed ? { adoption: night.adoption } : {}),
  };
}

export const pinnedSkills = (night: NightRecord) =>
  night.skills ?? [night.skill];
/** Acquire multiple skill locks in stable order, also used during pinning. */
export function withSkillLocks<T>(
  s: Store,
  ids: string[],
  work: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(ids)].sort();
  const next = (i: number): Promise<T> =>
    i === keys.length ? work() : s.lock("skill:" + keys[i], () => next(i + 1));
  return next(0);
}

// ── feedback → transcripts ──────────────────────────────────────────────
type StoredFeedback = FeedbackRequest & { feedbackId: string };
async function eligibleFeedback(
  s: Store,
  skillId: string,
): Promise<StoredFeedback[]> {
  const dir = path.join(s.root, "feedback");
  const all: StoredFeedback[] = [];
  for (const name of (await fs.readdir(dir)).sort())
    if (name.endsWith(".json"))
      all.push(await readJson<StoredFeedback>(path.join(dir, name)));
  const mine = all.filter((f) => f.skillId === skillId);
  const consumed = new Set(
    s.chain(skillId).flatMap((r) => r.metadata.feedbackIds),
  );
  const superseded = new Set(mine.flatMap((f) => f.supersedes ?? []));
  return mine
    .filter(
      (f) =>
        !consumed.has(f.feedbackId) &&
        !superseded.has(f.feedbackId) &&
        !f.disposition,
    )
    .sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) ||
        a.feedbackId.localeCompare(b.feedbackId),
    );
}
/** Feedback joins the session with the same id as its runId, or becomes a
 * one-turn session of its own. */
export function withFeedback(
  transcripts: Transcript[],
  feedback: StoredFeedback[],
  project: string,
): Transcript[] {
  const out = transcripts.map((t) => ({
    ...t,
    feedbackSignals: [...(t.feedbackSignals ?? [])],
  }));
  for (const f of feedback) {
    const signal = `${f.category}: ${f.observation} (expected: ${f.expected}; actual: ${f.actual})`;
    const session = out.find((t) => t.sessionId === f.runId);
    if (session) session.feedbackSignals.push(signal);
    else
      out.push({
        sessionId: f.runId,
        project,
        startedAt: f.timestamp,
        endedAt: f.timestamp,
        userPrompts: [f.observation],
        assistantFinals: [f.actual],
        feedbackSignals: [signal],
      });
  }
  return out;
}

// ── input pinning ───────────────────────────────────────────────────────
/** Keys Anagenesis always sets; callers cannot override them. */
function upstreamConfig(config: SleepConfig, project: string, multi: boolean) {
  const { slow_update: _, ...rest } = config;
  return {
    ...rest,
    backend: "handoff",
    auto_adopt: false,
    redact_secrets: true,
    multi_skill_fanout: multi,
    skill_roots: [path.join(project, "skills")],
    ...(multi ? { target_task_filter: false } : {}),
    multi_skill_report: false,
    projects: "invoked",
    transcript_source: "claude",
  };
}

async function pinNight(
  s: Store,
  req: SleepRunRequest,
  inputDigest: string,
): Promise<NightRecord> {
  const requested = req.skills.length
    ? req.skills
    : [
        {
          skillId: MANAGED_SKILL,
          expectedVersion: s.chain(MANAGED_SKILL)[0]?.metadata.version ?? null,
        },
      ];
  const python = findPython();
  const p = paths(s, req.operationId);
  return withSkillLocks(
    s,
    requested.map((r) => r.skillId),
    async () => {
      const skills = requested.map(({ skillId, expectedVersion }) => {
        const current = s.chain(skillId)[0] ?? null;
        if ((current?.metadata.version ?? null) !== expectedVersion)
          fail("STALE_BASE", "The skill changed; pin the active version");
        if (!current && skillId !== MANAGED_SKILL)
          fail("NOT_FOUND", "Sleep can only create the managed skill");
        return {
          skillId,
          expectedVersion,
          commit: current?.commit ?? null,
          digest: current?.metadata.digest ?? null,
        };
      });
      const feedback = (
        await Promise.all(skills.map((r) => eligibleFeedback(s, r.skillId)))
      ).flat();
      const transcripts = withFeedback(req.transcripts, feedback, p.project);
      await fs.rm(p.root, { recursive: true, force: true });
      for (const d of [p.home, p.tmp, p.project, p.handoff, p.claudeHome])
        await fs.mkdir(d, { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(p.home, ".skillopt-sleep"));
      await writeJson(
        path.join(p.home, ".skillopt-sleep", "config.json"),
        upstreamConfig(req.config ?? {}, p.project, skills.length > 1),
      );
      if (req.memory)
        await fs.writeFile(path.join(p.project, "CLAUDE.md"), req.memory.text);
      const raw = path.join(p.tmp, "transcripts.json");
      await fs.writeFile(raw, JSON.stringify(transcripts), { mode: 0o600 });
      const ingest = await runPython(
        python,
        "anagenesis_sleep",
        ["ingest", raw, path.join(p.handoff, "digests.json")],
        { cwd: p.tmp, env: pythonEnv({ home: p.home, tmp: p.tmp }) },
      );
      await fs.rm(raw, { force: true });
      if (ingest.code !== 0)
        fail("INVALID_INPUT", "Transcripts were rejected", {
          stderr: ingest.stderr.slice(-2000),
        });
      const night: NightRecord = {
        schemaVersion: 1,
        sleepId: req.operationId,
        action: req.action,
        inputDigest,
        createdAt: new Date().toISOString(),
        author: req.author,
        skill: skills[0]!,
        skills,
        memory: {
          label: req.memory?.label ?? "CLAUDE.md",
          baseSha256: sha256(req.memory?.text ?? ""),
        },
        feedbackIds: feedback.map((f) => f.feedbackId),
        config: req.config ?? {},
        ...(req.models ? { models: req.models } : {}),
        state: "pending",
        rounds: 0,
      };
      await writeNight(s, night);
      return night;
    },
  );
}

// ── answers ─────────────────────────────────────────────────────────────
export type Kind = "miner" | "attempt" | "judge" | "reflect" | "other";
export function promptKind(prompt: string): Kind {
  if (prompt.startsWith("You are mining")) return "miner";
  if (prompt.startsWith("Complete the following task")) return "attempt";
  if (prompt.startsWith("Score how well")) return "judge";
  if (prompt.startsWith("You are SkillOpt's optimizer")) return "reflect";
  return "other";
}
function jsonShape(text: string): "array" | "object" | null {
  const body = text
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  try {
    const v: unknown = JSON.parse(body);
    return Array.isArray(v)
      ? "array"
      : v && typeof v === "object"
        ? "object"
        : null;
  } catch {
    return null;
  }
}
/** JSON prompts need parseable JSON of the right shape; a malformed answer is
 * reported before Python reads it, so the caller can rewrite it. */
async function checkAnswers(handoff: string) {
  const p = path.join(handoff, "pending.json");
  if (!(await exists(p))) return;
  const { pending } = await readJson<{
    pending: { id: string; prompt: string }[];
  }>(p);
  const invalid: { id: string; kind: Kind }[] = [];
  for (const item of pending) {
    if (!/^[a-f0-9]{16}$/.test(item.id))
      fail("STORE_CORRUPT", "Invalid pending prompt id");
    const answer = path.join(handoff, "answers", item.id + ".md");
    if (!(await exists(answer))) continue;
    const kind = promptKind(item.prompt);
    const want =
      kind === "miner" || kind === "reflect"
        ? "array"
        : kind === "judge"
          ? "object"
          : null;
    if (want && jsonShape(await fs.readFile(answer, "utf8")) !== want)
      invalid.push({ id: item.id, kind });
  }
  if (invalid.length)
    fail(
      "VALIDATION_FAILED",
      "Some answers are not the JSON the prompt asks for",
      {
        invalid,
      },
    );
}

// ── rounds ──────────────────────────────────────────────────────────────
/** LLM-mined tasks pinned for the night; every task counts when the caller
 * turned LLM mining off. */
async function minedTasks(
  night: NightRecord,
  dir: string,
): Promise<number | null> {
  const p = path.join(dir, "tasks.json");
  if (!(await exists(p))) return null;
  const { tasks } = await readJson<{ tasks: { tags?: string[] }[] }>(p);
  if (night.config.llm_mine === false) return tasks.length;
  return tasks.filter((t) => t.tags?.includes("mined:llm")).length;
}
async function archivedHandoffs(root: string) {
  return (await fs.readdir(root))
    .filter((n) => n.startsWith("handoff.night") && n.includes(".done"))
    .map((n) => path.join(root, n));
}
async function stagingDirs(project: string) {
  const root = path.join(project, ".skillopt-sleep", "staging");
  if (!(await exists(root))) return [];
  // Upstream reserves <timestamp>[-N] directories; dotfiles such as `.latest`
  // are its own pointers.
  return (await fs.readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => path.join(root, e.name))
    .sort();
}
/** A crashed round can leave a reserved staging dir without a manifest. */
async function removeOrphanStagings(project: string) {
  for (const d of await stagingDirs(project))
    if (!(await exists(path.join(d, "manifest.json"))))
      await fs.rm(d, { recursive: true, force: true });
}
async function latestStaging(project: string) {
  for (const d of (await stagingDirs(project)).reverse())
    if (await exists(path.join(d, "manifest.json"))) return d;
  return null;
}
/** Night result from a finished staging dir (used when stdout was lost). */
async function resultFromStaging(dir: string) {
  const report = await readJson<Record<string, unknown>>(
    path.join(dir, "report.json"),
  );
  const manifest = await readJson<Record<string, unknown>>(
    path.join(dir, "manifest.json"),
  );
  return {
    ...report,
    staging_dir: dir,
    has_skill:
      manifest.has_managed_skill === true ||
      (Array.isArray(manifest.skills) && manifest.skills.length > 0),
    has_memory: manifest.has_managed_memory === true,
  };
}
function outcome(night: NightRecord, proposal: boolean): NightState {
  if (night.action === "dry-run") return "reported";
  return proposal ? "staged" : "rejected";
}

async function materializeBase(
  s: Store,
  skill: NightRecord["skill"],
  project: string,
) {
  const target = path.join(project, "skills", skill.skillId);
  await fs.rm(target, { recursive: true, force: true });
  if (skill.commit) {
    const revision = s
      .chain(skill.skillId)
      .find((r) => r.commit === skill.commit);
    if (!revision) fail("STORE_CORRUPT", "Pinned skill revision disappeared");
    await materializeTree(s.loadTree(revision), target);
  } else await fs.mkdir(target, { recursive: true });
  return path.join(target, "SKILL.md");
}

interface RoundResult {
  round: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
/** Runs the next upstream round, or returns its saved outcome when the
 * wrapper died after Python finished but before run.json was updated:
 * a finished round is never executed twice. Failures are not saved, so a
 * failed round can be retried. */
async function execute(s: Store, night: NightRecord): Promise<RoundResult> {
  const p = paths(s, night.sleepId);
  const saved = path.join(p.root, "round.json");
  if (await exists(saved)) {
    const last = await readJson<RoundResult>(saved);
    if (last.round === night.rounds + 1) return last;
  }
  if (await exists(p.handoff)) await checkAnswers(p.handoff);
  for (const skill of pinnedSkills(night))
    await materializeBase(s, skill, p.project);
  const skillPath = path.join(
    p.project,
    "skills",
    night.skill.skillId,
    "SKILL.md",
  );
  await removeOrphanStagings(p.project);
  const python = findPython();
  const run = await s.lock("sleep-state", () =>
    runPython(
      python,
      "anagenesis_sleep",
      [
        night.action,
        "--backend",
        "handoff",
        "--project",
        p.project,
        "--claude-home",
        p.claudeHome,
        "--target-skill-path",
        skillPath,
        "--json",
      ],
      {
        cwd: p.tmp,
        timeoutMs: ROUND_TIMEOUT_MS,
        env: pythonEnv({
          home: p.home,
          tmp: p.tmp,
          extra: {
            SKILLOPT_SLEEP_HANDOFF_DIR: p.handoff,
            ANAGENESIS_DIGESTS: path.join(p.handoff, "digests.json"),
          },
        }),
      },
    ),
  );
  await removeOrphanStagings(p.project);
  const result = { round: night.rounds + 1, ...run };
  if (run.code === 0 || run.code === 3) await writeJson(saved, result);
  return result;
}

async function round(s: Store, night: NightRecord) {
  const p = paths(s, night.sleepId);
  const run = await execute(s, night);
  night.rounds += 1;
  delete night.pending;
  if (run.code === 3) {
    const mined = await minedTasks(night, p.handoff);
    if (mined !== null && mined < MIN_MINED_TASKS)
      return finish(s, night, "idle", "insufficient_tasks", { mined });
    const { pending } = await readJson<{
      pending: { id: string; prompt: string }[];
    }>(path.join(p.handoff, "pending.json"));
    night.state = "pending";
    night.pending = {
      count: pending.length,
      items: pending.map((i) => ({ id: i.id, kind: promptKind(i.prompt) })),
    };
    return night;
  }
  if (run.code !== 0)
    fail("VALIDATION_FAILED", "SkillOpt Sleep failed", {
      code: run.code,
      signal: run.signal,
      stderr: run.stderr.slice(-4000),
    });
  const stdout = run.stdout.trim();
  if (!stdout) return finish(s, night, "idle", "no_tasks");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return fail("VALIDATION_FAILED", "SkillOpt Sleep printed no JSON report", {
      stdout: stdout.slice(-2000),
    });
  }
  if (payload.ok === false)
    fail("VALIDATION_FAILED", "SkillOpt Sleep refused the night", payload);
  const mined = await minedTasks(
    night,
    night.action === "dry-run"
      ? p.handoff
      : ((await archivedHandoffs(p.root)).at(-1) ?? p.handoff),
  );
  if (mined !== null && mined < MIN_MINED_TASKS)
    return finish(s, night, "idle", "insufficient_tasks", { mined });
  const staging =
    typeof payload.staging_dir === "string" && payload.staging_dir
      ? payload.staging_dir
      : null;
  const staged = staging ? await resultFromStaging(staging) : null;
  const result = {
    ...payload,
    has_skill: staged?.has_skill ?? false,
    has_memory: staged?.has_memory ?? false,
  };
  return finish(
    s,
    night,
    outcome(night, result.has_skill || result.has_memory),
    undefined,
    result,
  );
}
async function finish(
  s: Store,
  night: NightRecord,
  state: NightState,
  reason?: string,
  result?: Record<string, unknown>,
) {
  night.state = state;
  if (reason) night.reason = reason;
  if (result) {
    night.result = result;
    await writeJson(paths(s, night.sleepId).report, result);
  }
  return night;
}

/** Recovers a night whose last round finished but whose record was not
 * updated (crash after Python archived the handoff dir). */
async function recover(s: Store, night: NightRecord) {
  const p = paths(s, night.sleepId);
  if (night.action !== "run" || (await exists(p.handoff))) return null;
  const done = (await archivedHandoffs(p.root)).at(-1);
  const staging = await latestStaging(p.project);
  if (!done || !staging) return null;
  const mined = await minedTasks(night, done);
  if (mined !== null && mined < MIN_MINED_TASKS)
    return finish(s, night, "idle", "insufficient_tasks", { mined });
  const result = await resultFromStaging(staging);
  return finish(
    s,
    night,
    outcome(night, result.has_skill || result.has_memory),
    undefined,
    result,
  );
}

async function advance(s: Store, night: NightRecord) {
  if (TERMINAL.includes(night.state)) return night;
  const next = (await recover(s, night)) ?? (await round(s, night));
  await writeNight(s, next);
  return next;
}

// ── entry point ─────────────────────────────────────────────────────────
export async function sleepNight(s: Store, input: unknown) {
  const req = parse(sleepSchema, input);
  if (req.action === "status") {
    const prune = async (id: string) => {
      if (!req.prune) return readNight(s, id);
      return s.lock("sleep:" + id, async () => {
        const night = await readNight(s, id);
        if (
          ["adopted", "cleaned", "rejected", "idle", "reported"].includes(
            night.state,
          ) &&
          Date.now() - Date.parse(night.createdAt) >=
            req.retentionDays * 86_400_000
        )
          await cleanupNight(s, night);
        return night;
      });
    };
    if (req.sleepId) return view(s, await prune(req.sleepId));
    const root = path.join(s.root, "sleep", "nights");
    const ids = (await exists(root)) ? (await fs.readdir(root)).sort() : [];
    const nights = [];
    for (const id of ids)
      if (await exists(paths(s, id).run)) nights.push(await prune(id));
    return {
      status: "listed",
      nights: nights
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((n) => ({
          sleepId: n.sleepId,
          status: n.state,
          action: n.action,
          skillId: n.skill.skillId,
          createdAt: n.createdAt,
        })),
    };
  }
  if (req.action === "harvest") {
    // Shows what a night would mine from, without running Python or writing.
    const skillId = req.skills[0]?.skillId ?? MANAGED_SKILL;
    const feedback = (
      await Promise.all(
        (req.skills.length ? req.skills.map((r) => r.skillId) : [skillId]).map(
          (id) => eligibleFeedback(s, id),
        ),
      )
    ).flat();
    return {
      status: "harvested",
      skillId,
      feedbackIds: feedback.map((f) => f.feedbackId),
      transcripts: withFeedback(req.transcripts, feedback, ""),
    };
  }
  if (
    req.action === "schedule" ||
    req.action === "unschedule" ||
    req.action === "evalkit"
  )
    return sleepUtility(s, req);
  if (
    req.action === "adopt" ||
    req.action === "cleanup" ||
    req.action === "discard"
  )
    return s.lock("sleep:" + req.sleepId, async () => {
      const night = await readNight(s, req.sleepId);
      if (req.action === "adopt") await adoptNight(s, night, req);
      else if (req.action === "discard") await discardNight(s, night);
      else await cleanupNight(s, night);
      return view(s, night);
    });
  if (req.action === "resume")
    return s.lock("sleep:" + req.sleepId, async () =>
      view(s, await advance(s, await readNight(s, req.sleepId))),
    );
  const { operationId: _, ...rest } = req;
  const inputDigest = digestJson({ kind: "sleep", request: rest });
  return s.lock("sleep:" + req.operationId, async () => {
    let night: NightRecord;
    if (await exists(paths(s, req.operationId).run)) {
      night = await readNight(s, req.operationId);
      if (night.inputDigest !== inputDigest)
        fail(
          "IDEMPOTENCY_CONFLICT",
          "This sleep id was used with a different request",
        );
    } else night = await pinNight(s, req, inputDigest);
    return view(s, await advance(s, night));
  });
}
