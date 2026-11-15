import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  create,
  improve,
  submit,
  restore,
  history,
  resolve,
  recordFeedback,
  snapshotTree,
} from "../dist/index.js";
import {
  fixture,
  published,
  createRequest,
  submission,
  writeSkill,
  author,
  uuid,
} from "./helpers.mjs";
test("create → submit → improve → restore keeps exact content, provenance and per-skill history", async (t) => {
  const f = await published(t);
  const v1 = f.publication;
  assert.equal(v1.version, 1);
  const r1 = await resolve(f.store, {
    schemaVersion: 1,
    skillId: "test-skill",
  });
  assert.equal((await snapshotTree(r1.path)).digest, v1.digest);
  const req = { ...createRequest(), expectedVersion: 1, feedbackIds: [] };
  const c2 = await improve(f.store, req);
  await writeSkill(c2, "test-skill", "An improved documented procedure.");
  const v2 = await submit(f.store, await submission(c2, req));
  assert.equal(v2.version, 2);
  assert.notEqual(v1.digest, v2.digest);
  const otherReq = createRequest("other-skill");
  const other = await create(f.store, otherReq);
  await writeSkill(other, "other-skill");
  const otherPub = await submit(f.store, await submission(other, otherReq));
  const restoreReq = {
    schemaVersion: 1,
    operationId: uuid(),
    skillId: "test-skill",
    sourceVersion: 1,
    expectedVersion: 2,
    reason: "Historical procedure required",
    author,
  };
  const v3 = await restore(f.store, restoreReq);
  assert.equal(v3.version, 3);
  assert.equal(v3.digest, v1.digest);
  assert.equal(v3.restoredFrom, 1);
  assert.deepEqual(await restore(f.store, restoreReq), v3);
  assert.deepEqual(await submit(f.store, f.submitRequest), v1); // Receipt lookup after later publications.
  const h = await history(f.store, {
    schemaVersion: 1,
    skillId: "test-skill",
    limit: 2,
  });
  assert.deepEqual(
    h.revisions.map((r) => r.metadata.version),
    [3, 2],
  );
  assert.equal(h.revisions[0].metadata.parent, v2.commit);
  assert.equal(h.revisions[0].metadata.sourceDigest, v1.digest);
  assert.equal(h.nextCursor, 2);
  const page = await history(f.store, {
    schemaVersion: 1,
    skillId: "test-skill",
    cursor: h.nextCursor,
  });
  assert.equal(page.revisions[0].metadata.version, 1);
  assert.equal(
    (await history(f.store, { schemaVersion: 1, skillId: "other-skill" }))
      .revisions[0].commit,
    otherPub.commit,
  );
  const r3 = await resolve(f.store, {
    schemaVersion: 1,
    skillId: "test-skill",
  });
  assert.equal((await snapshotTree(r3.path)).digest, r1.digest);
  await assert.rejects(
    restore(f.store, { ...restoreReq, operationId: uuid() }),
    { code: "STALE_BASE" },
  );
});
test("Preparations and publications are idempotent; conflicting inputs never reuse IDs", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await create(f.store, f.request), f.candidate);
  await assert.rejects(create(f.store, { ...f.request, reason: "different" }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  const req = await submission(f.candidate, f.request);
  const result = await submit(f.store, req);
  assert.deepEqual(await submit(f.store, req), result);
  await assert.rejects(
    submit(f.store, { ...req, expectedDigest: "0".repeat(64) }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  await assert.rejects(create(f.store, { ...f.request, operationId: uuid() }), {
    code: "ALREADY_EXISTS",
  });
});
test("Feedback remains append-only and pinned to the used version, including corrections and unassigned signals", async (t) => {
  const f = await published(t);
  const req = {
    schemaVersion: 1,
    operationId: uuid(),
    skillId: "test-skill",
    version: 1,
    artifactDigest: f.publication.digest,
    runId: "used-v1",
    producer: "test",
    timestamp: new Date().toISOString(),
    source: f.request.sources[0],
    observation: "Missing a step",
    expected: "Complete result",
    actual: "Incomplete result",
    evidenceRefs: ["run:used-v1"],
    category: "skill",
    possibleCause: "Missing instruction",
  };
  await restore(f.store, {
    schemaVersion: 1,
    operationId: uuid(),
    skillId: "test-skill",
    sourceVersion: 1,
    expectedVersion: 1,
    reason: "Republish",
    author,
  });
  const first = await recordFeedback(f.store, req);
  assert.equal(first.version, 1);
  assert.deepEqual(await recordFeedback(f.store, req), first);
  const correction = await recordFeedback(f.store, {
    ...req,
    operationId: uuid(),
    supersedes: first.feedbackId,
    observation: "Corrected observation",
  });
  assert.equal(correction.supersedes, first.feedbackId);
  const unknown = await recordFeedback(f.store, {
    ...req,
    operationId: uuid(),
    version: null,
    artifactDigest: null,
  });
  assert.equal(unknown.assignment, "unassigned");
  const c = await improve(f.store, {
    ...createRequest(),
    expectedVersion: 2,
    feedbackIds: [first.feedbackId, correction.feedbackId],
  });
  const brief = JSON.parse(await fs.readFile(c.briefPath, "utf8"));
  assert.equal(brief.feedback[0].observation, req.observation);
  assert.equal(brief.feedback[0].version, 1);
  await assert.rejects(
    recordFeedback(f.store, {
      ...req,
      operationId: uuid(),
      artifactDigest: "0".repeat(64),
    }),
    { code: "INVALID_INPUT" },
  );
});
test("Rejected attempts do not allocate versions and a corrected draft uses a fresh frozen holdout", async (t) => {
  const f = await fixture(t);
  const request = await submission(f.candidate, f.request, { score: 0.5 });
  const result = await submit(f.store, request);
  assert.equal(result.status, "rejected");
  assert.equal(result.nextHoldoutIndex, 1);
  assert.deepEqual(await submit(f.store, request), result);
  await assert.rejects(
    resolve(f.store, { schemaVersion: 1, skillId: "test-skill" }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(submit(f.store, { ...request, operationId: uuid() }), {
    code: "EVIDENCE_INVALID",
  });
  await writeSkill(f.candidate, "test-skill", "Corrected procedure.");
  const second = await submit(
    f.store,
    await submission(f.candidate, f.request, { index: 1 }),
  );
  assert.equal(second.version, 1);
});
test("Resolve regenerates a corrupted cache from immutable Git", async (t) => {
  const f = await published(t);
  const req = { schemaVersion: 1, skillId: "test-skill" };
  const a = await resolve(f.store, req);
  const p = path.join(a.path, "SKILL.md");
  await fs.chmod(p, 0o644);
  await fs.writeFile(p, "corrupt");
  const b = await resolve(f.store, req);
  assert.equal((await snapshotTree(b.path)).digest, f.publication.digest);
});

test("uppercase operation UUIDs remain readable and idempotent across publications", async (t) => {
  const f = await fixture(t);
  const request = createRequest("uppercase-skill");
  request.operationId = request.operationId.toUpperCase();
  const candidate = await create(f.store, request);
  await writeSkill(candidate, request.skillId);
  assert.deepEqual(await create(f.store, request), candidate);
  const submitRequest = await submission(candidate, request);
  submitRequest.operationId = submitRequest.operationId.toUpperCase();
  const publication = await submit(f.store, submitRequest);
  assert.equal(publication.status, "published");
  const query = { schemaVersion: 1, skillId: request.skillId };
  assert.equal(
    (await history(f.store, query)).revisions[0].metadata.receipt.operationId,
    submitRequest.operationId,
  );
  assert.equal((await resolve(f.store, query)).digest, publication.digest);
  const restoreRequest = {
    ...query,
    operationId: uuid().toUpperCase(),
    sourceVersion: 1,
    expectedVersion: 1,
    reason: "Restore with uppercase UUID",
    author,
  };
  const restored = await restore(f.store, restoreRequest);
  assert.equal(restored.version, 2);
  assert.deepEqual(await restore(f.store, restoreRequest), restored);
  assert.deepEqual(await submit(f.store, submitRequest), publication);
  assert.equal((await history(f.store, query)).revisions.length, 2);
  assert.equal((await resolve(f.store, query)).digest, publication.digest);
});
