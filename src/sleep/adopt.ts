// Upstream applies proposals; Anagenesis validates and versions the result.
import * as fs from "node:fs/promises";
import path from "node:path";
import { fail } from "../errors.js";
import {
  digestJson,
  exists,
  readJson,
  sha256,
  within,
  writeJson,
} from "../io.js";
import { diffTrees, type Publication, type Store } from "../store.js";
import { snapshotTree, validateTree } from "../tree.js";
import type { SleepAdoptRequest } from "../schemas.js";
import {
  paths,
  pinnedSkills,
  withSkillLocks,
  writeNight,
  type NightRecord,
} from "./night.js";
import {
  managedPolicy,
  publishSleep,
  SKILLOPT_PIN,
  sleepOperationId,
} from "./publish.js";
import { findPython, pythonEnv, runPython } from "./python.js";

export interface MemoryProposal {
  label: string;
  text: string;
  baseSha256: string;
}
export interface Adoption {
  operationId: string;
  author: SleepAdoptRequest["author"];
  publications: Publication[];
  memory?: MemoryProposal;
  completed?: boolean;
}
interface Row {
  proposed_file: string;
  sha256: string;
  live_sha256: string;
  live_realpath: string;
  live_path?: string;
  live_skill_path?: string;
  skill_name?: string;
}
interface Manifest {
  accepted: boolean;
  legacy?: { skill?: Row; memory?: Row };
  skills?: Row[];
}

/** O_EXCL locks survive a killed Python process. Never unlink a live or
 * unidentifiable owner's lock; recheck inode identity before removing it. */
async function removeDeadLock(file: string) {
  if (!(await exists(file))) return;
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink())
    fail("STORE_CORRUPT", "Unsafe upstream adoption lock");
  const match = /^pid=([1-9][0-9]*)\n$/.exec(await fs.readFile(file, "utf8"));
  const pid = Number(match?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0)
    fail("STORE_BUSY", "Upstream adoption lock has no identifiable owner");
  try {
    process.kill(pid, 0);
    fail("STORE_BUSY", "Upstream adoption is still running");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
  const after = await fs.lstat(file);
  if (before.ino === after.ino && before.dev === after.dev)
    await fs.unlink(file);
}
async function removeDeadLocks(tmp: string, staging: string) {
  await removeDeadLock(path.join(staging, ".adopt-skills.lock"));
  for (const entry of await fs.readdir(tmp, { withFileTypes: true })) {
    if (!entry.name.startsWith("skillopt-sleep-adopt-")) continue;
    const dir = path.join(tmp, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      fail("STORE_CORRUPT", "Unsafe upstream adoption lock directory");
    for (const name of await fs.readdir(dir))
      if (name.endsWith(".lock")) await removeDeadLock(path.join(dir, name));
  }
}

async function checkRow(
  row: Row,
  live: string,
  staging: string,
  baseline: string,
) {
  const proposed = path.join(staging, row.proposed_file);
  if (
    row.live_realpath !== live ||
    (row.live_path ?? row.live_skill_path) !== live ||
    row.live_sha256 !== baseline ||
    !within(staging, proposed) ||
    path.dirname(proposed) !== staging ||
    (await fs.realpath(proposed)) !== proposed ||
    sha256(await fs.readFile(proposed)) !== row.sha256
  )
    fail(
      "VALIDATION_FAILED",
      "Sleep proposal does not match its pinned target and hashes",
    );
}

/** After upstream's 'already adopted', require its ledger AND the live bytes
 * to match the pinned proposal. A message alone is never a success receipt. */
async function verifyAdopted(
  staging: string,
  rows: { key: string; row: Row }[],
  legacy: boolean,
) {
  const file = path.join(
    staging,
    legacy ? "adopted_legacy.json" : "adopted_skills.json",
  );
  if (!(await exists(file)))
    fail("VALIDATION_FAILED", "Upstream adoption receipt is missing");
  const receipts = await readJson<Record<string, string>[]>(file);
  for (const { key, row } of rows) {
    const live = row.live_path ?? row.live_skill_path!;
    const receipt = receipts.find(
      (r) => (legacy ? r.target : r.skill_name) === key,
    );
    if (
      !receipt ||
      (receipt.live_path ?? receipt.live_skill_path) !== live ||
      receipt.sha256_before !== row.live_sha256 ||
      receipt.sha256_after !== row.sha256 ||
      (await fs.realpath(live)) !== live ||
      sha256(await fs.readFile(live)) !== row.sha256
    )
      fail(
        "VALIDATION_FAILED",
        "Upstream adoption receipt does not match the proposal",
      );
    const backup = row.live_sha256
      ? path.join(
          staging,
          "backup",
          ...(legacy ? [] : ["skills", key]),
          path.basename(live),
        )
      : "";
    if (
      receipt.backup_path !== backup ||
      (backup && sha256(await fs.readFile(backup)) !== row.live_sha256)
    )
      fail(
        "VALIDATION_FAILED",
        "Upstream adoption backup does not match the pinned base",
      );
  }
}

export async function adoptNight(
  s: Store,
  night: NightRecord,
  req: SleepAdoptRequest,
) {
  if (night.adoption?.completed) {
    await cleanupNight(s, night);
    return;
  }
  if (night.state !== "staged")
    fail("VALIDATION_FAILED", "Only a staged night can be adopted");
  if (
    night.adoption &&
    digestJson(night.adoption.author) !== digestJson(req.author)
  )
    fail(
      "IDEMPOTENCY_CONFLICT",
      "This night is being adopted by another author",
    );
  const p = paths(s, night.sleepId);
  const staging = night.result?.staging_dir;
  if (
    typeof staging !== "string" ||
    !within(path.join(p.project, ".skillopt-sleep", "staging"), staging) ||
    (await fs.realpath(staging)) !== staging
  )
    fail("STORE_CORRUPT", "Sleep staging directory is invalid");
  const manifest = await readJson<Manifest>(
    path.join(staging, "manifest.json"),
  );
  const report = await readJson<Record<string, unknown>>(
    path.join(staging, "report.json"),
  );
  const skills = pinnedSkills(night);
  await withSkillLocks(
    s,
    skills.map((r) => r.skillId),
    async () => {
      // Published receipts take precedence over the base check after a crash,
      // including when another revision has since been published.
      const published = new Map(
        skills.map((r) => [
          r.skillId,
          s.findReceipt(sleepOperationId(night.sleepId, r.skillId))?.revision,
        ]),
      );
      for (const skill of skills)
        if (
          !published.get(skill.skillId) &&
          s.head(skill.skillId) !== skill.commit
        )
          fail("STALE_BASE", "The skill changed since the night was pinned", {
            skillId: skill.skillId,
          });
      const targets: {
        skill: NightRecord["skill"];
        row: Row;
        legacy: boolean;
      }[] = [];
      if (manifest.legacy?.skill) {
        if (!manifest.accepted)
          fail("VALIDATION_FAILED", "The managed proposal was not accepted");
        targets.push({
          skill: night.skill,
          row: manifest.legacy.skill,
          legacy: true,
        });
      }
      for (const row of manifest.skills ?? []) {
        const skill = skills.find((r) => r.skillId === row.skill_name);
        if (!skill || targets.some((r) => r.skill.skillId === skill.skillId))
          fail(
            "VALIDATION_FAILED",
            "Upstream proposed an unpinned or duplicate skill",
          );
        targets.push({ skill, row, legacy: false });
      }
      for (const { skill, row } of targets) {
        const base = skill.commit
          ? s.loadTree(s.revision(skill.commit, skill.skillId))
          : null;
        await checkRow(
          row,
          path.join(p.project, "skills", skill.skillId, "SKILL.md"),
          staging,
          base?.entries.find((e) => e.path === "SKILL.md")?.digest ?? "",
        );
      }
      const memory = manifest.legacy?.memory;
      night.memory ??= {
        label: "CLAUDE.md",
        baseSha256: memory?.live_sha256 || sha256(""),
      };
      if (memory) {
        if (!manifest.accepted)
          fail("VALIDATION_FAILED", "The memory proposal was not accepted");
        await checkRow(
          memory,
          path.join(p.project, "CLAUDE.md"),
          staging,
          memory.live_sha256 === "" && night.memory?.baseSha256 === sha256("")
            ? ""
            : (night.memory?.baseSha256 ?? sha256("")),
        );
      }
      if (!targets.length && !memory)
        fail("VALIDATION_FAILED", "The night contains no proposal");
      for (const { skill, row } of targets) {
        const committed = published.get(skill.skillId);
        if (
          committed &&
          (committed.metadata.kind !== "sleep" ||
            committed.metadata.parent !== skill.commit ||
            (committed.metadata.sleep as Record<string, unknown>)?.sleepId !==
              night.sleepId ||
            s.loadTree(committed).entries.find((e) => e.path === "SKILL.md")
              ?.digest !== row.sha256)
        )
          fail(
            "STORE_CORRUPT",
            "Sleep publication receipt does not match the pinned proposal",
          );
      }
      const allPublished =
        targets.length > 0 &&
        targets.every(
          ({ skill }) =>
            published.has(skill.skillId) && published.get(skill.skillId),
        );
      const python = allPublished ? null : findPython();
      night.adoption ??= {
        operationId: req.operationId,
        author: req.author,
        publications: [],
      };
      await writeNight(s, night);
      await removeDeadLocks(p.tmp, staging);
      const upstream = async (
        selection: string[],
        rows: { key: string; row: Row }[],
        legacy: boolean,
      ) => {
        const run = await s.lock("sleep-state", () =>
          runPython(
            python!,
            "anagenesis_sleep",
            [
              "adopt",
              "--staging",
              staging,
              "--project",
              p.project,
              "--claude-home",
              p.claudeHome,
              "--target-skill-path",
              path.join(p.project, "skills", night.skill.skillId, "SKILL.md"),
              "--backend",
              "handoff",
              "--json",
              ...selection,
            ],
            {
              cwd: p.tmp,
              env: pythonEnv({
                home: p.home,
                tmp: p.tmp,
                extra: { SKILLOPT_SLEEP_HANDOFF_DIR: p.handoff },
              }),
            },
          ),
        );
        if (
          run.code !== 0 &&
          !(run.code === 2 && run.stdout.includes("already adopted"))
        )
          fail("VALIDATION_FAILED", "SkillOpt Sleep adoption failed", {
            code: run.code,
            stdout: run.stdout.slice(-4000),
            stderr: run.stderr.slice(-4000),
          });
        await verifyAdopted(staging, rows, legacy);
      };
      const legacy = Object.entries(manifest.legacy ?? {}).map(
        ([key, row]) => ({ key, row }),
      );
      if (legacy.length) {
        if (allPublished) await verifyAdopted(staging, legacy, true);
        else await upstream(["--legacy"], legacy, true);
      }
      for (const { skill, row, legacy: isLegacy } of targets)
        if (!isLegacy) {
          const rows = [{ key: skill.skillId, row }];
          if (published.get(skill.skillId))
            await verifyAdopted(staging, rows, false);
          else await upstream(["--skill", skill.skillId], rows, false);
        }
      // Snapshot only after upstream applied the proposal. References, assets,
      // modes and empty directories must still match the pinned Git tree.
      for (const { skill, row } of targets) {
        const committed = published.get(skill.skillId);
        if (committed) continue;
        const base = skill.commit
          ? s.revision(skill.commit, skill.skillId)
          : null;
        const policy = base?.metadata.policy ?? managedPolicy();
        const tree = await snapshotTree(
          path.join(p.project, "skills", skill.skillId),
          policy.limits,
        );
        const diff = diffTrees(base ? s.loadTree(base) : null, tree);
        if (
          [...diff.added, ...diff.modified, ...diff.deleted].some(
            (f) => f !== "SKILL.md",
          ) ||
          tree.entries.find((e) => e.path === "SKILL.md")?.digest !== row.sha256
        )
          fail("VALIDATION_FAILED", "Sleep may only change SKILL.md");
        validateTree(tree, skill.skillId, policy.limits);
        const group = row.skill_name
          ? (
              report.skill_groups as Record<string, unknown>[] | undefined
            )?.find((r) => r.skill_name === skill.skillId)
          : undefined;
        const evidence = group ?? report;
        await publishSleep(
          s,
          {
            sleepId: night.sleepId,
            skillId: skill.skillId,
            expectedVersion: skill.expectedVersion,
            tree,
            author: night.adoption.author,
            reason: "Sleep night accepted by the Microsoft gate",
            feedbackIds: night.feedbackIds,
            sleep: {
              config: night.config,
              base: skill,
              gate: evidence.gate_action ?? null,
              scores: {
                baseline: evidence.baseline_score ?? null,
                candidate: evidence.candidate_score ?? null,
              },
              edits: group
                ? {
                    applied: group.n_applied_edits,
                    rejected: group.n_rejected_edits,
                  }
                : (report.edits ?? []),
              report,
              hashes: {
                manifest: sha256(
                  await fs.readFile(path.join(staging, "manifest.json")),
                ),
                report: sha256(
                  await fs.readFile(path.join(staging, "report.json")),
                ),
                skill: row.sha256,
                ...(memory ? { memory: memory.sha256 } : {}),
              },
            },
          },
          true,
        );
      }
      // Receipts are authoritative, including after a partial publication.
      night.adoption.publications = targets.map(({ skill }) =>
        s.publication(
          s.findReceipt(sleepOperationId(night.sleepId, skill.skillId))!
            .revision,
        ),
      );
      if (memory)
        night.adoption.memory = {
          label: night.memory?.label ?? "CLAUDE.md",
          text: await fs.readFile(path.join(p.project, "CLAUDE.md"), "utf8"),
          baseSha256: night.memory?.baseSha256 ?? sha256(""),
        };
      night.adoption.completed = true;
      night.state = "adopted";
      await writeJson(p.report, {
        ...night.result,
        sleepId: night.sleepId,
        pin: SKILLOPT_PIN,
        config: night.config,
        feedbackIds: night.feedbackIds,
        publications: night.adoption.publications,
        hashes: {
          manifest: sha256(
            await fs.readFile(path.join(staging, "manifest.json")),
          ),
          report: sha256(await fs.readFile(path.join(staging, "report.json"))),
          skills: Object.fromEntries(
            targets.map(({ skill, row }) => [skill.skillId, row.sha256]),
          ),
          ...(memory
            ? {
                memory: memory.sha256,
                memoryBase: night.adoption.memory!.baseSha256,
              }
            : {}),
        },
      });
      await writeNight(s, night);
    },
  );
  await cleanupNight(s, night);
}

/** Drop a pending or staged night the user declined. Nothing is published;
 * the night ends cleaned with reason "discarded", so a new one can start. */
export async function discardNight(s: Store, night: NightRecord) {
  if (night.state === "cleaned" && night.reason === "discarded") return;
  if (night.state !== "pending" && night.state !== "staged")
    fail(
      "VALIDATION_FAILED",
      "Only a pending or staged night can be discarded",
    );
  if (night.adoption)
    fail("VALIDATION_FAILED", "Adoption has started: finish it with adopt");
  night.reason = "discarded";
  await cleanupNight(s, night, true);
}

/** Keep the durable result and report; the shared redacted task archive stays. */
export async function cleanupNight(
  s: Store,
  night: NightRecord,
  discard = false,
) {
  if (
    !discard &&
    !["adopted", "cleaned", "rejected", "idle", "reported"].includes(
      night.state,
    )
  )
    fail(
      "VALIDATION_FAILED",
      "This night is still pending or awaiting adoption",
    );
  const p = paths(s, night.sleepId);
  if (!(await exists(p.report)))
    await writeJson(
      p.report,
      night.result ?? { reason: night.reason ?? night.state },
    );
  for (const name of await fs.readdir(p.root))
    if (name !== "run.json" && name !== "report.json")
      await fs.rm(path.join(p.root, name), { recursive: true, force: true });
  night.state = "cleaned";
  await writeNight(s, night);
}
