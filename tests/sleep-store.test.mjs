import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  create,
  history,
  resolve,
  restore,
  snapshotTree,
  submit,
} from "../dist/index.js";
import {
  MANAGED_SKILL,
  publishSleep,
  sleepOperationId,
  uuidV5,
} from "../dist/sleep/publish.js";
import {
  author,
  createRequest,
  published,
  submission,
  temporary,
  uuid,
  writeSkill,
} from "./helpers.mjs";

async function tree(t, skillId, body) {
  const dir = path.join(await temporary(t), "skill");
  await fs.mkdir(dir);
  await writeSkill({ workspacePath: dir }, skillId, body);
  return snapshotTree(dir);
}
const night = (sleepId, skillId, expectedVersion, snapshot) => ({
  sleepId,
  skillId,
  expectedVersion,
  tree: snapshot,
  author,
  reason: "Sleep night accepted by the Microsoft gate",
  feedbackIds: [],
  sleep: { gate: { action: "accept_new_best" }, edits: 1 },
});

test("Derived operation ids are RFC 4122 v5, deterministic and per skill", () => {
  assert.equal(
    uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"),
    "2ed6657d-e927-568b-95e1-2665a8aea6a2",
  );
  const id = uuid();
  assert.equal(sleepOperationId(id, "a"), sleepOperationId(id, "a"));
  assert.notEqual(sleepOperationId(id, "a"), sleepOperationId(id, "b"));
});

test("A sleep revision coexists with submit, restore and receipts of other skills", async (t) => {
  const f = await published(t);
  const sleepId = uuid();
  const input = night(
    sleepId,
    "test-skill",
    1,
    await tree(t, "test-skill", "Learned: check inputs first."),
  );
  const v2 = await publishSleep(f.store, input);
  assert.equal(v2.version, 2);
  assert.deepEqual(await publishSleep(f.store, input), v2);
  const [latest] = (
    await history(f.store, { schemaVersion: 1, skillId: "test-skill" })
  ).revisions;
  assert.equal(latest.metadata.kind, "sleep");
  assert.equal(latest.metadata.sleep.sleepId, sleepId);
  assert.deepEqual(latest.metadata.policy, f.request.policy);
  assert.deepEqual(latest.metadata.sources, f.request.sources);
  // Other skills and receipt replays still work after a sleep revision.
  const otherReq = createRequest("other-skill");
  const other = await create(f.store, otherReq);
  await writeSkill(other, "other-skill");
  assert.equal(
    (await submit(f.store, await submission(other, otherReq))).version,
    1,
  );
  assert.deepEqual(
    (await submit(f.store, f.submitRequest)).version,
    f.publication.version,
  );
  const resolved = await resolve(f.store, {
    schemaVersion: 1,
    skillId: "test-skill",
  });
  assert.equal(resolved.digest, input.tree.digest);
  const v3 = await restore(f.store, {
    schemaVersion: 1,
    operationId: uuid(),
    skillId: "test-skill",
    sourceVersion: 1,
    expectedVersion: 2,
    reason: "Undo the night",
    author,
  });
  assert.equal(v3.digest, f.publication.digest);
  await assert.rejects(
    publishSleep(
      f.store,
      night(uuid(), "test-skill", 2, await tree(t, "test-skill", "Stale.")),
    ),
    { code: "STALE_BASE" },
  );
});

test("Sleep creates only the managed skill, with a declared policy", async (t) => {
  const f = await published(t);
  await assert.rejects(
    publishSleep(
      f.store,
      night(uuid(), "new-skill", null, await tree(t, "new-skill", "x")),
    ),
    { code: "NOT_FOUND" },
  );
  const v1 = await publishSleep(
    f.store,
    night(
      uuid(),
      MANAGED_SKILL,
      null,
      await tree(t, MANAGED_SKILL, "Learned."),
    ),
  );
  assert.equal(v1.version, 1);
  const [rev] = (
    await history(f.store, { schemaVersion: 1, skillId: MANAGED_SKILL })
  ).revisions;
  assert.match(rev.metadata.sources[0].uri, /microsoft\/SkillOpt/);
  assert.equal(rev.metadata.policy.evaluation.configuration.backend, "handoff");
});

test("Skill lookup matches the whole id, never a longer id with the same prefix", async (t) => {
  const { store } = await published(t, "release-notes");
  assert.equal(store.head("release"), null);
  assert.ok(store.head("release-notes"));
  await assert.rejects(
    resolve(store, { schemaVersion: 1, skillId: "release" }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    history(store, { schemaVersion: 1, skillId: "release" }),
    { code: "NOT_FOUND" },
  );
});
