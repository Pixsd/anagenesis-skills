import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  Store,
  create,
  submit,
  sleep,
  restore,
  sha256,
} from "../dist/index.js";
import { findPython, pythonEnv, runPython } from "../dist/sleep/python.js";
import {
  author,
  createRequest,
  published,
  submission,
  uuid,
  writeSkill,
} from "./helpers.mjs";
import { opts, fresh, night, run, transcripts } from "./sleep-helpers.mjs";

const adopt = (sleepId) => ({
  schemaVersion: 1,
  action: "adopt",
  operationId: uuid(),
  sleepId,
  author,
});
const action = (sleepId, action = "status") => ({
  schemaVersion: 1,
  action,
  sleepId,
});
const rootOf = (store, view) =>
  path.join(store.root, "sleep", "nights", view.sleepId);

async function staged(t) {
  const { store, request } = await published(t);
  const view = await night(
    store,
    run({ skills: [{ skillId: request.skillId, expectedVersion: 1 }] }),
  );
  assert.equal(view.status, "staged");
  return { store, view, request };
}

test(
  "adopt publishes v N+1 with only SKILL.md changed, provenance and automatic cleanup",
  opts,
  async (t) => {
    const store = await fresh(t);
    const request = createRequest();
    const candidate = await create(store, request);
    await writeSkill(
      candidate,
      request.skillId,
      "Follow the documented steps.\n" + "Detail.\n".repeat(501),
    );
    await fs.mkdir(path.join(candidate.workspacePath, "references"));
    await fs.writeFile(
      path.join(candidate.workspacePath, "references", "guide.md"),
      "Keep this reference.\n",
    );
    await fs.mkdir(path.join(candidate.workspacePath, "empty"));
    await fs.mkdir(path.join(candidate.workspacePath, "assets"));
    await fs.writeFile(
      path.join(candidate.workspacePath, "assets", "data.bin"),
      Buffer.from([0, 255, 42]),
    );
    await fs.mkdir(path.join(candidate.workspacePath, "scripts"));
    await fs.writeFile(
      path.join(candidate.workspacePath, "scripts", "check.sh"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    await submit(store, await submission(candidate, request));
    const before = store.loadTree(store.chain(request.skillId)[0]);
    const view = await night(
      store,
      run({ skills: [{ skillId: request.skillId, expectedVersion: 1 }] }),
    );
    const reference = path.join(
      rootOf(store, view),
      "project",
      "skills",
      request.skillId,
      "references",
      "guide.md",
    );
    await fs.writeFile(reference, "Unexpected edit");
    await assert.rejects(sleep(store, adopt(view.sleepId)), {
      code: "VALIDATION_FAILED",
    });
    assert.equal(store.chain(request.skillId).length, 1);
    await fs.writeFile(reference, "Keep this reference.\n");
    const adopted = await sleep(store, adopt(view.sleepId));
    assert.equal(adopted.status, "cleaned");
    const [publication] = adopted.adoption.publications;
    assert.equal(publication.version, 2);
    assert.deepEqual(publication.warnings, ["skill_md_too_long"]);
    const rev = store.chain(request.skillId)[0];
    assert.equal(rev.metadata.kind, "sleep");
    assert.deepEqual(rev.metadata.diff, {
      added: [],
      deleted: [],
      modified: ["SKILL.md"],
    });
    assert.deepEqual(rev.metadata.policy, request.policy);
    assert.deepEqual(rev.metadata.sources, request.sources);
    assert.equal(rev.metadata.sleep.sleepId, view.sleepId);
    assert.match(rev.metadata.sleep.pin, /^45f65ca/);
    assert.ok(rev.metadata.sleep.edits.length);
    assert.ok(
      rev.metadata.sleep.scores.candidate > rev.metadata.sleep.scores.baseline,
    );
    assert.match(rev.metadata.sleep.hashes.skill, /^[a-f0-9]{64}$/);
    const after = store.loadTree(rev);
    assert.deepEqual(
      after.entries.filter((e) => e.path !== "SKILL.md"),
      before.entries.filter((e) => e.path !== "SKILL.md"),
    );
    const root = rootOf(store, view);
    assert.deepEqual((await fs.readdir(root)).sort(), [
      "report.json",
      "run.json",
    ]);
    const report = JSON.parse(
      await fs.readFile(path.join(root, "report.json")),
    );
    assert.equal(report.publications[0].commit, publication.commit);
    // A retry also removes data left by an interrupted cleanup.
    await fs.mkdir(path.join(root, "home"));
    await fs.writeFile(path.join(root, "home", "leftover"), "temporary data");
    assert.deepEqual(await sleep(store, adopt(view.sleepId)), adopted);
    assert.deepEqual((await fs.readdir(root)).sort(), [
      "report.json",
      "run.json",
    ]);
    assert.deepEqual(
      await sleep(store, action(view.sleepId, "cleanup")),
      adopted,
    );
    assert.ok(
      await fs.stat(
        path.join(
          store.root,
          "sleep",
          "state",
          ".skillopt-sleep",
          "state.json",
        ),
      ),
    );
  },
);

test("adopt creates the managed skill at v1", opts, async (t) => {
  const store = await fresh(t);
  const view = await night(store, run());
  const result = await sleep(store, adopt(view.sleepId));
  assert.equal(result.adoption.publications[0].version, 1);
  const revision = store.chain("skillopt-sleep-learned")[0];
  assert.equal(
    revision.metadata.policy.evaluation.configuration.backend,
    "handoff",
  );
  assert.match(revision.metadata.sources[0].uri, /microsoft\/SkillOpt/);
});

test(
  "memory-only adoption returns upstream text and the original baseSha256 without publishing",
  opts,
  async (t) => {
    const store = await fresh(t);
    const memory = {
      label: "project-memory",
      text: "  # Rules\r\nRemember the release format and café names.\r\n",
    };
    const view = await night(
      store,
      run({ memory, config: { evolve_skill: false } }),
    );
    assert.equal(view.result.has_memory, true);
    const adopted = await sleep(store, adopt(view.sleepId));
    assert.deepEqual(adopted.adoption.publications, []);
    assert.equal(adopted.adoption.memory.label, memory.label);
    assert.equal(adopted.adoption.memory.baseSha256, sha256(memory.text));
    assert.match(adopted.adoption.memory.text, /Always say GOOD/);
    assert.equal(store.chain("skillopt-sleep-learned").length, 0);
    assert.deepEqual(await sleep(store, adopt(view.sleepId)), adopted);
  },
);

test(
  "adopt refuses STALE_BASE before upstream changes files",
  opts,
  async (t) => {
    const { store, view, request } = await staged(t);
    await restore(store, {
      schemaVersion: 1,
      operationId: uuid(),
      skillId: request.skillId,
      sourceVersion: 1,
      expectedVersion: 1,
      author,
      reason: "Advance the base",
    });
    const live = path.join(
      rootOf(store, view),
      "project",
      "skills",
      request.skillId,
      "SKILL.md",
    );
    const before = await fs.readFile(live);
    await assert.rejects(sleep(store, adopt(view.sleepId)), {
      code: "STALE_BASE",
    });
    assert.deepEqual(await fs.readFile(live), before);
    assert.equal((await sleep(store, action(view.sleepId))).status, "staged");
  },
);

test(
  "a crash after upstream adopt resumes via matching adopted_legacy.json",
  opts,
  async (t) => {
    const { store, view, request } = await staged(t);
    const root = rootOf(store, view);
    const adopted = await runPython(
      findPython(),
      "anagenesis_sleep",
      [
        "adopt",
        "--staging",
        view.result.staging_dir,
        "--project",
        path.join(root, "project"),
        "--target-skill-path",
        path.join(root, "project", "skills", request.skillId, "SKILL.md"),
        "--json",
      ],
      {
        cwd: path.join(root, "tmp"),
        env: pythonEnv({
          home: path.join(root, "home"),
          tmp: path.join(root, "tmp"),
        }),
      },
    );
    assert.equal(adopted.code, 0, adopted.stdout + adopted.stderr);
    assert.equal(
      (await sleep(store, adopt(view.sleepId))).adoption.publications[0]
        .version,
      2,
    );
  },
);

test(
  "a crash after the publication ref recovers its receipt and cleans up, even after a newer revision",
  opts,
  async (t) => {
    const { store, view, request } = await staged(t);
    const crash = await Store.open({
      storePath: store.root,
      onPhase(phase) {
        if (phase === "after-ref") throw new Error("simulated crash");
      },
    });
    await assert.rejects(sleep(crash, adopt(view.sleepId)), {
      code: "STORE_CORRUPT",
      details: { cause: "simulated crash" },
    });
    const commit = store.chain(request.skillId)[0].commit;
    await restore(store, {
      schemaVersion: 1,
      operationId: uuid(),
      skillId: request.skillId,
      sourceVersion: 1,
      expectedVersion: 2,
      author,
      reason: "Advance again",
    });
    const savedPython = process.env.ANAGENESIS_PYTHON;
    process.env.ANAGENESIS_PYTHON = "/missing/python";
    t.after(() => {
      if (savedPython === undefined) delete process.env.ANAGENESIS_PYTHON;
      else process.env.ANAGENESIS_PYTHON = savedPython;
    });
    const result = await sleep(store, adopt(view.sleepId));
    assert.equal(result.status, "cleaned");
    assert.equal(result.adoption.publications[0].commit, commit);
    assert.equal(store.chain(request.skillId).length, 3);
  },
);

test(
  "dead upstream adopt locks are removed; live and unidentified owners are kept",
  opts,
  async (t) => {
    const { store, view } = await staged(t);
    const lock = path.join(view.result.staging_dir, ".adopt-skills.lock");
    for (const contents of [`pid=${process.pid}\n`, "unknown owner"]) {
      await fs.writeFile(lock, contents);
      await assert.rejects(sleep(store, adopt(view.sleepId)), {
        code: "STORE_BUSY",
      });
      assert.equal(await fs.readFile(lock, "utf8"), contents);
    }
    // This PID is outside the OS pid range; kill(0) must establish ESRCH.
    const dead = 2_000_000_000;
    assert.throws(() => process.kill(dead, 0), { code: "ESRCH" });
    await fs.writeFile(lock, `pid=${dead}\n`);
    const tmpLocks = path.join(
      rootOf(store, view),
      "tmp",
      `skillopt-sleep-adopt-${process.getuid()}`,
    );
    await fs.mkdir(tmpLocks, { mode: 0o700 });
    await fs.writeFile(path.join(tmpLocks, "orphan.lock"), `pid=${dead}\n`);
    assert.equal((await sleep(store, adopt(view.sleepId))).status, "cleaned");
  },
);

test("a mismatched upstream adopted receipt is refused", opts, async (t) => {
  const { store, view } = await staged(t);
  await fs.writeFile(
    path.join(view.result.staging_dir, "adopted_legacy.json"),
    JSON.stringify([
      { target: "skill", live_path: "wrong", sha256_after: "0".repeat(64) },
    ]),
  );
  await assert.rejects(sleep(store, adopt(view.sleepId)), {
    code: "VALIDATION_FAILED",
  });
  assert.equal(store.chain("test-skill").length, 1);
});

test(
  "cleanup and retention pruning are idempotent for idle, rejected and reported nights",
  opts,
  async (t) => {
    const store = await fresh(t);
    for (const req of [
      run({ transcripts: [] }),
      run({ action: "dry-run" }),
      run(),
    ]) {
      const view = await night(store, req, "flat");
      assert.ok(["idle", "reported", "rejected"].includes(view.status));
      const cleaned = await sleep(store, {
        ...action(view.sleepId),
        prune: true,
        retentionDays: 0,
      });
      assert.equal(cleaned.status, "cleaned");
      assert.deepEqual(
        await sleep(store, action(view.sleepId, "cleanup")),
        cleaned,
      );
      assert.deepEqual((await fs.readdir(rootOf(store, view))).sort(), [
        "report.json",
        "run.json",
      ]);
    }
    const pending = await sleep(store, run());
    await assert.rejects(sleep(store, action(pending.sleepId, "cleanup")), {
      code: "VALIDATION_FAILED",
    });
  },
);

test(
  "discard drops a pending or staged night without publishing, idempotently",
  opts,
  async (t) => {
    const { store, view, request } = await staged(t);
    await assert.rejects(
      sleep(store, { ...action(view.sleepId, "discard"), force: true }),
      { code: "INVALID_INPUT" },
    );
    const discarded = await sleep(store, action(view.sleepId, "discard"));
    assert.equal(discarded.status, "cleaned");
    assert.equal(discarded.reason, "discarded");
    assert.equal(store.chain(request.skillId).length, 1);
    assert.deepEqual(
      await sleep(store, action(view.sleepId, "discard")),
      discarded,
    );
    assert.deepEqual((await fs.readdir(rootOf(store, view))).sort(), [
      "report.json",
      "run.json",
    ]);
    await assert.rejects(sleep(store, adopt(view.sleepId)), {
      code: "VALIDATION_FAILED",
    });

    const pending = await sleep(store, run());
    assert.equal(pending.status, "pending");
    const dropped = await sleep(store, action(pending.sleepId, "discard"));
    assert.equal(dropped.status, "cleaned");
    assert.equal(dropped.reason, "discarded");
    // A discarded night is terminal: resume returns it unchanged.
    assert.deepEqual(
      await sleep(store, action(pending.sleepId, "resume")),
      dropped,
    );

    const flat = await night(store, run({ transcripts: [] }), "flat");
    assert.equal(flat.status, "idle");
    await assert.rejects(sleep(store, action(flat.sleepId, "discard")), {
      code: "VALIDATION_FAILED",
    });
  },
);

test(
  "a partial multi-skill publication resumes the missing skills",
  opts,
  async (t) => {
    const { store } = await published(t, "first-skill");
    const request = createRequest("second-skill");
    const candidate = await create(store, request);
    await writeSkill(candidate, request.skillId);
    await submit(store, await submission(candidate, request));
    const skills = ["first-skill", "second-skill"].map((skillId) => ({
      skillId,
      expectedVersion: 1,
    }));
    const input = transcripts().map((item, i) => ({
      ...item,
      skillsUsed: [skills[i % 2].skillId],
    }));
    const view = await night(store, run({ skills, transcripts: input }));
    assert.equal(view.status, "staged");
    const manifest = JSON.parse(
      await fs.readFile(path.join(view.result.staging_dir, "manifest.json")),
    );
    assert.ok(manifest.skills?.some((r) => r.skill_name === "second-skill"));
    const crash = await Store.open({
      storePath: store.root,
      onPhase(phase) {
        if (phase === "after-ref") throw new Error("partial publication");
      },
    });
    await assert.rejects(sleep(crash, adopt(view.sleepId)), {
      code: "STORE_CORRUPT",
    });
    assert.equal(store.chain("first-skill")[0].metadata.version, 2);
    assert.equal(store.chain("second-skill")[0].metadata.version, 1);
    const result = await sleep(store, adopt(view.sleepId));
    assert.equal(result.status, "cleaned");
    assert.deepEqual(
      result.adoption.publications.map((p) => [p.skillId, p.version]),
      [
        ["first-skill", 2],
        ["second-skill", 2],
      ],
    );
    assert.deepEqual(await sleep(store, adopt(view.sleepId)), result);
  },
);
