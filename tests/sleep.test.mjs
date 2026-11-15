// Sleep nights driven end to end through Microsoft's unchanged skillopt_sleep,
// with a scripted responder standing in for the calling agent.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sleep, recordFeedback } from "../dist/index.js";
import { published, temporary, uuid } from "./helpers.mjs";

import {
  opts,
  transcripts,
  respond,
  night,
  fresh,
  run,
} from "./sleep-helpers.mjs";

test(
  "A full night stages Microsoft's proposal and never reruns Python after",
  opts,
  async (t) => {
    const store = await fresh(t);
    const request = run();
    const view = await night(store, request);
    assert.equal(view.status, "staged");
    assert.equal(view.skillId, "skillopt-sleep-learned");
    assert.equal(view.result.accepted, true);
    assert.equal(view.result.has_skill, true);
    assert.ok(view.result.candidate > view.result.baseline);
    const proposal = await fs.readFile(
      path.join(view.result.staging_dir, "proposed_SKILL.md"),
      "utf8",
    );
    assert.match(proposal, /Always say GOOD/);
    // Terminal: resume and an identical run return the record unchanged.
    const again = await sleep(store, {
      schemaVersion: 1,
      action: "resume",
      sleepId: view.sleepId,
    });
    assert.equal(again.rounds, view.rounds);
    assert.deepEqual(await sleep(store, request), again);
    await assert.rejects(
      sleep(store, { ...request, transcripts: transcripts(3) }),
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    const list = await sleep(store, { schemaVersion: 1, action: "status" });
    assert.deepEqual(
      list.nights.map((n) => [n.sleepId, n.status]),
      [[view.sleepId, "staged"]],
    );
    // Everything stays in the store; shared upstream state lives in one place.
    const state = path.join(
      store.root,
      "sleep",
      "state",
      ".skillopt-sleep",
      "state.json",
    );
    assert.ok(JSON.parse(await fs.readFile(state, "utf8")));
  },
);

test("A gate that sees no improvement rejects the night", opts, async (t) => {
  const store = await fresh(t);
  const view = await night(store, run(), "flat");
  assert.equal(view.status, "rejected");
  assert.equal(view.result.accepted, false);
  assert.equal(view.result.has_skill, false);
});

test("dry-run reports without staging", opts, async (t) => {
  const store = await fresh(t);
  const view = await night(store, run({ action: "dry-run" }));
  assert.equal(view.status, "reported");
  assert.equal(view.result.staging_dir, "");
});

test("Nights without enough mined tasks end idle", opts, async (t) => {
  const store = await fresh(t);
  const empty = await night(store, run({ transcripts: [] }));
  assert.equal(empty.status, "idle");
  assert.equal(empty.reason, "no_tasks");
  const few = await night(
    store,
    run({ transcripts: transcripts(1) }),
    "good",
    2,
  );
  assert.equal(few.status, "idle");
  assert.equal(few.reason, "insufficient_tasks");
  assert.equal(few.rounds, 2); // mining, then pinning the tasks
});

test(
  "Malformed answers are refused before Python and can be rewritten",
  opts,
  async (t) => {
    const store = await fresh(t);
    const first = await sleep(store, run());
    assert.equal(first.status, "pending");
    await respond(first, "malformed");
    const resume = {
      schemaVersion: 1,
      action: "resume",
      sleepId: first.sleepId,
    };
    await assert.rejects(sleep(store, resume), (e) => {
      assert.equal(e.code, "VALIDATION_FAILED");
      assert.equal(e.details.invalid[0].kind, "miner");
      return true;
    });
    const still = await sleep(store, {
      schemaVersion: 1,
      action: "status",
      sleepId: first.sleepId,
    });
    assert.equal(still.status, "pending");
    assert.equal(still.rounds, 1);
    await respond(first);
    const view = await night(store, resume);
    assert.equal(view.status, "staged");
  },
);

test("Two rounds of one night cannot run at once", opts, async (t) => {
  const store = await fresh(t);
  const first = await sleep(store, run());
  await respond(first);
  const resume = { schemaVersion: 1, action: "resume", sleepId: first.sleepId };
  const results = await Promise.allSettled([
    sleep(store, resume),
    sleep(store, resume),
  ]);
  const busy = results.filter((r) => r.status === "rejected");
  assert.equal(busy.length, 1);
  assert.equal(busy[0].reason.code, "STORE_BUSY");
});

test(
  "An existing skill is pinned, and its feedback joins the night",
  opts,
  async (t) => {
    const { store, publication, request } = await published(t, "notes-skill");
    const fb = (extra = {}) => ({
      schemaVersion: 1,
      operationId: uuid(),
      skillId: "notes-skill",
      version: 1,
      artifactDigest: publication.digest,
      runId: "s0",
      producer: "test-agent",
      timestamp: "2026-11-14T10:00:00Z",
      source: request.sources[0],
      observation: "Release notes miss the summary",
      expected: "A summary first",
      actual: "No summary",
      evidenceRefs: ["log:1"],
      category: "output",
      possibleCause: null,
      ...extra,
    });
    const kept = await recordFeedback(store, fb());
    const wrong = await recordFeedback(store, fb({ runId: "other" }));
    await recordFeedback(
      store,
      fb({ supersedes: wrong.feedbackId, disposition: "not_skill" }),
    );
    const skills = [{ skillId: "notes-skill", expectedVersion: 1 }];
    const harvest = await sleep(store, {
      schemaVersion: 1,
      action: "harvest",
      skills,
      transcripts: transcripts(2),
    });
    assert.deepEqual(harvest.feedbackIds, [kept.feedbackId]);
    assert.equal(harvest.transcripts.length, 2);
    assert.match(harvest.transcripts[0].feedbackSignals.at(-1), /summary/);
    await assert.rejects(
      sleep(
        store,
        run({ skills: [{ skillId: "notes-skill", expectedVersion: 2 }] }),
      ),
      { code: "STALE_BASE" },
    );
    await assert.rejects(
      sleep(
        store,
        run({ skills: [{ skillId: "unknown", expectedVersion: null }] }),
      ),
      { code: "NOT_FOUND" },
    );
    const view = await sleep(store, run({ skills }));
    assert.equal(view.status, "pending");
    const skillMd = path.join(
      store.root,
      "sleep",
      "nights",
      view.sleepId,
      "project",
      "skills",
      "notes-skill",
      "SKILL.md",
    );
    assert.match(await fs.readFile(skillMd, "utf8"), /notes-skill/);
  },
);

test("A missing interpreter fails cleanly before any night is written", async (t) => {
  const store = await fresh(t);
  const saved = process.env.ANAGENESIS_PYTHON;
  process.env.ANAGENESIS_PYTHON = "/nonexistent/python3";
  t.after(() => {
    if (saved === undefined) delete process.env.ANAGENESIS_PYTHON;
    else process.env.ANAGENESIS_PYTHON = saved;
  });
  await assert.rejects(sleep(store, run()), { code: "NOT_FOUND" });
  await assert.rejects(fs.access(path.join(store.root, "sleep", "nights")));
});

test("The CLI exposes sleep", async (t) => {
  const root = await temporary(t);
  const cli = path.resolve(import.meta.dirname, "..", "dist", "cli.js");
  const request = path.join(root, "status.json");
  await fs.writeFile(
    request,
    JSON.stringify({ schemaVersion: 1, action: "status" }),
  );
  const { stdout } = await promisify(execFile)(process.execPath, [
    cli,
    "sleep",
    "--store",
    path.join(root, "store"),
    "--request",
    request,
  ]);
  assert.deepEqual(JSON.parse(stdout), { status: "listed", nights: [] });
});

test(
  "A night whose record was lost after Python finished is recovered without rerunning it",
  opts,
  async (t) => {
    const store = await fresh(t);
    const view = await night(store, run());
    assert.equal(view.status, "staged");
    const runJson = path.join(
      store.root,
      "sleep",
      "nights",
      view.sleepId,
      "run.json",
    );
    const record = JSON.parse(await fs.readFile(runJson, "utf8"));
    delete record.result;
    await fs.writeFile(
      runJson,
      JSON.stringify({ ...record, state: "pending" }),
    );
    const recovered = await sleep(store, {
      schemaVersion: 1,
      action: "resume",
      sleepId: view.sleepId,
    });
    assert.equal(recovered.status, "staged");
    assert.equal(recovered.rounds, view.rounds);
    assert.equal(recovered.result.staging_dir, view.result.staging_dir);
  },
);

test(
  "A round that finished before its record was written is reused, not rerun",
  opts,
  async (t) => {
    const store = await fresh(t);
    const runJson = (id) =>
      path.join(store.root, "sleep", "nights", id, "run.json");
    const rewind = async (id, record) => {
      const { reason: _r, result: _s, pending: _p, ...rest } = record;
      await fs.writeFile(
        runJson(id),
        JSON.stringify({
          ...rest,
          state: "pending",
          rounds: record.rounds - 1,
        }),
      );
    };
    // Python is unreachable from here on: any rerun would fail with NOT_FOUND.
    const saved = process.env.ANAGENESIS_PYTHON;
    const unreachable = () =>
      (process.env.ANAGENESIS_PYTHON = "/nonexistent/python3");
    t.after(() => {
      if (saved === undefined) delete process.env.ANAGENESIS_PYTHON;
      else process.env.ANAGENESIS_PYTHON = saved;
    });
    const resume = (sleepId) =>
      sleep(store, { schemaVersion: 1, action: "resume", sleepId });

    // An idle night: Python printed nothing and archived nothing.
    const idle = await night(store, run({ transcripts: [] }));
    assert.equal(idle.reason, "no_tasks");
    const idleRecord = JSON.parse(await fs.readFile(runJson(idle.sleepId)));
    await rewind(idle.sleepId, idleRecord);
    unreachable();
    const again = await resume(idle.sleepId);
    assert.equal(again.status, "idle");
    assert.equal(again.reason, "no_tasks");
    assert.equal(again.rounds, idleRecord.rounds);

    // A pending round is recovered the same way.
    if (saved === undefined) delete process.env.ANAGENESIS_PYTHON;
    else process.env.ANAGENESIS_PYTHON = saved;
    const first = await sleep(store, run());
    assert.equal(first.status, "pending");
    const record = JSON.parse(await fs.readFile(runJson(first.sleepId)));
    await rewind(first.sleepId, record);
    unreachable();
    const recovered = await resume(first.sleepId);
    assert.equal(recovered.status, "pending");
    assert.equal(recovered.rounds, 1);
    assert.equal(recovered.pending.count, first.pending.count);
  },
);
