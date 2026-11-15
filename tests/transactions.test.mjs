import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import {
  Store,
  create,
  submit,
  restore,
  resolve,
  history,
  snapshotTree,
} from "../dist/index.js";
import {
  fixture,
  published,
  temporary,
  createRequest,
  submission,
  writeSkill,
  author,
  uuid,
} from "./helpers.mjs";
async function worker(root, job) {
  const p = path.join(root, uuid() + ".json");
  await fs.writeFile(p, JSON.stringify(job));
  const child = fork(new URL("./worker.mjs", import.meta.url), [p], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stderr.on("data", () => {});
  return child;
}
const publishPhases = [
  "before-objects",
  "after-objects",
  "before-commit",
  "after-commit",
  "before-ref",
  "after-ref",
];
for (const command of ["submit", "restore"])
  for (const phase of publishPhases)
    test(`SIGKILL ${command} at ${phase}: no gap or duplicate, receipt survives`, async (t) => {
      const f = command === "submit" ? await fixture(t) : await published(t);
      const req =
        command === "submit"
          ? await submission(f.candidate, f.request)
          : {
              schemaVersion: 1,
              operationId: uuid(),
              skillId: "test-skill",
              sourceVersion: 1,
              expectedVersion: 1,
              reason: "Crash test restore",
              author,
            };
      const before = command === "submit" ? 0 : 1;
      const child = await worker(f.root, {
        storePath: f.store.root,
        command,
        request: req,
        phase,
        mode: "crash",
      });
      const [, signal] = await once(child, "exit");
      assert.equal(signal, "SIGKILL");
      assert.equal(
        f.store.chain("test-skill").length,
        before + (phase === "after-ref" ? 1 : 0),
      );
      const result = await { submit, restore }[command](f.store, req);
      assert.equal(result.version, before + 1);
      assert.deepEqual(
        await { submit, restore }[command](f.store, req),
        result,
      );
      assert.equal(f.store.chain("test-skill").length, before + 1);
    });
for (const phase of [
  "before-materialize",
  "after-materialize-write",
  "after-materialize",
])
  test(`SIGKILL resolve at ${phase}: no partial cache is exposed`, async (t) => {
    const f = await published(t);
    const req = { schemaVersion: 1, skillId: "test-skill" };
    const child = await worker(f.root, {
      storePath: f.store.root,
      command: "resolve",
      request: req,
      phase,
      mode: "crash",
    });
    assert.equal((await once(child, "exit"))[1], "SIGKILL");
    const result = await resolve(f.store, req);
    assert.equal(
      (await snapshotTree(result.path)).digest,
      f.publication.digest,
    );
    assert.equal(f.store.chain("test-skill").length, 1);
  });
test("Preparation receipt reconciles after process death without losing agent edits", async (t) => {
  const root = await temporary(t),
    storePath = path.join(root, "store");
  const req = createRequest();
  const child = await worker(root, {
    storePath,
    command: "create",
    request: req,
    phase: "after-prepare",
    mode: "crash",
  });
  assert.equal((await once(child, "exit"))[1], "SIGKILL");
  const workspacePath = path.join(
    storePath,
    "workspaces",
    req.operationId,
    "skill",
  );
  await writeSkill({ workspacePath });
  const c = await create({ storePath }, req);
  assert.equal(c.candidateId, req.operationId);
  assert.match(
    await fs.readFile(path.join(c.workspacePath, "SKILL.md"), "utf8"),
    /Follow the documented steps/,
  );
});
test("Contending publication gets STORE_BUSY, then STALE_BASE; other skills progress independently", async (t) => {
  const f = await fixture(t);
  const req2 = createRequest();
  const c2 = await create(f.store, req2);
  await writeSkill(c2);
  const a = await submission(f.candidate, f.request),
    b = await submission(c2, req2);
  const child = await worker(f.root, {
    storePath: f.store.root,
    command: "submit",
    request: a,
    phase: "before-ref",
    mode: "pause",
  });
  t.after(() => child.kill("SIGKILL"));
  assert.equal((await once(child, "message"))[0].phase, "before-ref");
  await assert.rejects(submit(f.store, b), { code: "STORE_BUSY" });
  const otherReq = createRequest("other-skill");
  const other = await create(f.store, otherReq);
  await writeSkill(other, "other-skill");
  assert.equal(
    (await submit(f.store, await submission(other, otherReq))).version,
    1,
  );
  const exit = once(child, "exit");
  child.send("continue");
  await exit;
  await assert.rejects(submit(f.store, b), { code: "STALE_BASE" });
  assert.equal(f.store.chain("test-skill").length, 1);
});
test("Submit and restore on the same base produce one new version", async (t) => {
  const f = await published(t);
  const { improve } = await import("../dist/index.js");
  const req = { ...createRequest(), expectedVersion: 1, feedbackIds: [] };
  const c = await improve(f.store, req);
  await writeSkill(c, "test-skill", "Updated steps.");
  const a = await submission(c, req);
  const b = {
    schemaVersion: 1,
    operationId: uuid(),
    skillId: "test-skill",
    sourceVersion: 1,
    expectedVersion: 1,
    reason: "Concurrent restore",
    author,
  };
  const child = await worker(f.root, {
    storePath: f.store.root,
    command: "submit",
    request: a,
    phase: "before-ref",
    mode: "pause",
  });
  t.after(() => child.kill("SIGKILL"));
  await once(child, "message");
  await assert.rejects(restore(f.store, b), { code: "STORE_BUSY" });
  const exit = once(child, "exit");
  child.send("continue");
  await exit;
  await assert.rejects(restore(f.store, b), { code: "STALE_BASE" });
  assert.equal(f.store.chain("test-skill").length, 2);
});
test("Workspace changes during commit cannot change the frozen publication", async (t) => {
  const f = await fixture(t);
  const req = await submission(f.candidate, f.request);
  const store = await Store.open({
    storePath: f.store.root,
    onPhase: async (phase) => {
      if (phase === "before-ref")
        await writeSkill(f.candidate, "test-skill", "Changed after evaluation");
    },
  });
  const result = await submit(store, req);
  assert.equal(result.digest, req.expectedDigest);
  assert.notEqual(
    (await snapshotTree(f.candidate.workspacePath)).digest,
    result.digest,
  );
  const r = await resolve(store, { schemaVersion: 1, skillId: "test-skill" });
  assert.equal((await snapshotTree(r.path)).digest, result.digest);
});
test("Interrupted store initialization is recovered from its intent", async (t) => {
  const root = await temporary(t),
    storePath = path.join(root, "store");
  await fs.mkdir(storePath);
  await fs.writeFile(path.join(storePath, ".initializing"), "{}");
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", [
    "init",
    "--bare",
    "-q",
    path.join(storePath, "repo.git"),
  ]);
  const s = await Store.open({ storePath });
  assert.equal(s.head("test-skill"), null);
});

test("Corrupted frozen attempt bytes cannot be published after restart", async (t) => {
  const f = await fixture(t);
  const req = await submission(f.candidate, f.request);
  const child = await worker(f.root, {
    storePath: f.store.root,
    command: "submit",
    request: req,
    phase: "before-objects",
    mode: "crash",
  });
  assert.equal((await once(child, "exit"))[1], "SIGKILL");
  const p = path.join(f.store.root, "attempts", req.operationId + ".json");
  const data = JSON.parse(await fs.readFile(p));
  data.snapshot.entries.find((e) => e.type === "file").base64 =
    Buffer.from("corrupted").toString("base64");
  await fs.writeFile(p, JSON.stringify(data));
  await assert.rejects(submit(f.store, req), { code: "STORE_CORRUPT" });
  assert.equal(f.store.head("test-skill"), null);
});
