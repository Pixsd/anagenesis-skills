import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  Store,
  create,
  improve,
  submit,
  restore,
  resolve,
  history,
  sha256,
  snapshotTree,
  digestJson,
} from "../dist/index.js";
import {
  fixture,
  published,
  submission,
  createRequest,
  temporary,
  policy,
  author,
  uuid,
} from "./helpers.mjs";
const mutations = {
  "contaminated holdout": (m) => {
    m.authorExposed = true;
  },
  "wrong policy": (m) => {
    m.policyDigest = "0".repeat(64);
  },
  "wrong suite": (m) => {
    m.suiteDigest = "0".repeat(64);
  },
  "wrong base": (m) => {
    m.baseVersion = 1;
  },
  "wrong candidate": (m) => {
    m.candidateDigest = "0".repeat(64);
  },
  "wrong baseline kind": (m) => {
    m.baselineKind = "revision";
  },
  "incomplete coverage": (m) => {
    m.results.pop();
  },
  "duplicate case": (m) => {
    m.results.push(m.results[0]);
  },
  "duplicate run": (m) => {
    m.results[0].candidate.runId = m.results[0].baseline.runId;
  },
  "wrong input digest": (m) => {
    m.results[0].candidate.inputDigest = "0".repeat(64);
  },
  "wrong split": (m) => {
    m.results[0].candidate.split = "regression";
  },
  "missing isolation": (m) => {
    m.results[0].candidate.isolated = false;
  },
  "infrastructure failure": (m) => {
    m.results[0].baseline.outcome = "infrastructure_error";
  },
  "changed model": (m) => {
    m.results[0].baseline.modelVersion = "other";
  },
  "changed configuration": (m) => {
    m.results[0].candidate.configuration.temperature = 1;
  },
  "changed budget": (m) => {
    m.results[0].candidate.budget = 10;
  },
  "changed verifier": (m) => {
    m.results[0].candidate.verifierVersion = "2";
  },
  "changed seed": (m) => {
    m.results[0].candidate.seed = 17;
  },
  "wrong hard score": (m) => {
    m.results[0].candidate.hard = 0;
  },
  "missing artifact": (m) => {
    delete m.artifacts[m.results[0].candidate.artifactDigest];
  },
  "tampered artifact": (m) => {
    m.artifacts[m.results[0].candidate.artifactDigest] = "tampered";
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`Evidence rejects ${name}`, async (t) => {
    const f = await fixture(t);
    const req = structuredClone(await submission(f.candidate, f.request));
    mutate(req.evidenceManifest);
    const result = await submit(f.store, req);
    assert.equal(result.status, "rejected");
    assert.equal(result.reasons[0].code, "EVIDENCE_INVALID");
    assert.equal(f.store.head("test-skill"), null);
  });
test("Non-finite scores, unknown keys/metrics, overlapping splits and undersized holdout are invalid inputs", async (t) => {
  const f = await fixture(t);
  const req = await submission(f.candidate, f.request);
  req.evidenceManifest.results[0].candidate.soft = Infinity;
  await assert.rejects(submit(f.store, req), { code: "INVALID_INPUT" });
  for (const mutate of [
    (p) => {
      p.metric = "unknown";
    },
    (p) => {
      p.holdouts[0][0].id = p.development[0].id;
    },
    (p) => {
      p.regression[0].inputDigest = p.holdouts[0][0].inputDigest;
    },
    (p) => {
      p.minimumHoldout = 2;
    },
  ]) {
    const r = createRequest("another-skill");
    mutate(r.policy);
    await assert.rejects(create(f.store, r), { code: "INVALID_INPUT" });
  }
  await assert.rejects(
    submit(f.store, {
      ...(await submission(f.candidate, f.request)),
      policy: {},
    }),
    { code: "INVALID_INPUT" },
  );
});
for (const [name, opts] of Object.entries({
  tie: { score: 0.5 },
  worse: { score: 0.4 },
  regression: { regression: 0.7 },
  threshold: { score: 0.4, baseline: 0.1 },
}))
  test(`Gate blocks ${name}`, async (t) => {
    const f = await fixture(t);
    const r = await submit(
      f.store,
      await submission(f.candidate, f.request, opts),
    );
    assert.equal(r.status, "rejected");
    assert.equal(r.reasons[0].code, "VALIDATION_FAILED");
  });
test("Changed workspace bytes cannot satisfy a previous expectedDigest", async (t) => {
  const f = await fixture(t);
  const req = await submission(f.candidate, f.request);
  await fs.appendFile(
    path.join(f.candidate.workspacePath, "SKILL.md"),
    "Changed",
  );
  const r = await submit(f.store, req);
  assert.equal(r.status, "rejected");
  assert.match(r.reasons[0].message, /expectedDigest/);
});
for (const [name, content] of Object.entries({
  missing: "# No frontmatter",
  duplicate:
    "---\nname: test-skill\nname: test-skill\ndescription: x\n---\nBody",
  wrongName: "---\nname: other\ndescription: x\n---\nBody",
  traversal: "---\nname: test-skill\ndescription: x\n---\n[bad](../secret)",
  absolute: "---\nname: test-skill\ndescription: x\n---\n[bad](/etc/passwd)",
  missingReference:
    "---\nname: test-skill\ndescription: x\n---\n[bad](references/missing.md)",
}))
  test(`Tree validation blocks ${name}`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(
      path.join(f.candidate.workspacePath, "SKILL.md"),
      content,
    );
    const r = await submit(f.store, await submission(f.candidate, f.request));
    assert.equal(r.status, "rejected");
    assert.equal(r.reasons[0].code, "VALIDATION_FAILED");
  });
test("Symlinks, file limits, invalid UTF-8 and special files are rejected without execution", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.candidate.workspacePath, "link");
  await fs.symlink("/etc/passwd", target);
  await assert.rejects(snapshotTree(f.candidate.workspacePath), {
    code: "VALIDATION_FAILED",
  });
  await fs.rm(target);
  execFileSync("mkfifo", [target]);
  await assert.rejects(snapshotTree(f.candidate.workspacePath), {
    code: "VALIDATION_FAILED",
  });
  await fs.rm(target);
  await fs.writeFile(
    path.join(f.candidate.workspacePath, "bad.txt"),
    Buffer.from([0xff]),
  );
  const invalid = await submit(
    f.store,
    await submission(f.candidate, f.request),
  );
  assert.equal(invalid.status, "rejected");
  await fs.rm(path.join(f.candidate.workspacePath, "bad.txt"));
  await fs.writeFile(
    path.join(f.candidate.workspacePath, "huge.bin"),
    Buffer.alloc(50001),
  );
  await assert.rejects(
    snapshotTree(f.candidate.workspacePath, f.request.policy.limits),
    { code: "VALIDATION_FAILED" },
  );
});
test("Tree digest preserves assets, executable mode and empty directories across restore", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.candidate.workspacePath, "assets/empty"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(f.candidate.workspacePath, "assets/file.bin"),
    Buffer.from([0, 255, 42]),
  );
  const script = path.join(f.candidate.workspacePath, "script.sh");
  await fs.writeFile(script, "exit 99\n");
  await fs.chmod(script, 0o755);
  const pub = await submit(f.store, await submission(f.candidate, f.request));
  assert.equal(pub.version, 1);
  const r = await restore(f.store, {
    schemaVersion: 1,
    operationId: uuid(),
    skillId: "test-skill",
    sourceVersion: 1,
    expectedVersion: 1,
    reason: "Check exact tree",
    author,
  });
  assert.equal(r.digest, pub.digest);
  const resolved = await resolve(f.store, {
    schemaVersion: 1,
    skillId: "test-skill",
  });
  assert.equal((await snapshotTree(resolved.path)).digest, pub.digest);
  assert.equal(
    (await fs.stat(path.join(resolved.path, "script.sh"))).mode & 0o111,
    0o111,
  );
});
test("Store rejects source repositories, relative paths, aliases, nested stores and remotes", async (t) => {
  const root = await temporary(t);
  const repo = path.join(root, "source");
  await fs.mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  await assert.rejects(Store.open({ storePath: path.join(repo, "store") }), {
    code: "INVALID_INPUT",
  });
  const alias = path.join(root, "alias");
  await fs.symlink(repo, alias);
  await assert.rejects(Store.open({ storePath: path.join(alias, "store") }), {
    code: "INVALID_INPUT",
  });
  await assert.rejects(Store.open({ storePath: "relative" }), {
    code: "INVALID_INPUT",
  });
  const s = await Store.open({ storePath: path.join(root, "store") });
  await assert.rejects(
    Store.open({ storePath: path.join(s.root, "workspaces/nested") }),
    { code: "INVALID_INPUT" },
  );
  execFileSync("git", [
    "--git-dir=" + s.repo,
    "config",
    "remote.bad.url",
    "https://example.org/repo",
  ]);
  await assert.rejects(create(s, createRequest()), { code: "STORE_CORRUPT" });
});
test("Tampered candidate policy cannot lower evaluation requirements", async (t) => {
  const f = await fixture(t);
  const p = path.join(
    f.store.root,
    "candidates",
    f.candidate.candidateId + ".json",
  );
  const data = JSON.parse(await fs.readFile(p));
  data.request.policy.thresholds.hard = 0;
  await fs.writeFile(p, JSON.stringify(data));
  await assert.rejects(
    submit(f.store, await submission(f.candidate, f.request)),
    { code: "STORE_CORRUPT" },
  );
});
test("Missing, stale and malformed requests return structured error codes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    improve(f.store, {
      ...createRequest(),
      expectedVersion: 1,
      feedbackIds: [],
    }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    history(f.store, { schemaVersion: 1, skillId: "../escape" }),
    { code: "INVALID_INPUT" },
  );
  await assert.rejects(
    create(f.store, { ...createRequest(), schemaVersion: 2 }),
    { code: "INVALID_INPUT" },
  );
});

test("Restore refuses corrupted Git object bytes", async (t) => {
  const f = await published(t);
  const blob = f.store
    .git(["rev-parse", `${f.publication.commit}:skill/SKILL.md`])
    .toString()
    .trim();
  await fs.chmod(
    path.join(f.store.repo, "objects", blob.slice(0, 2), blob.slice(2)),
    0o644,
  );
  await fs.writeFile(
    path.join(f.store.repo, "objects", blob.slice(0, 2), blob.slice(2)),
    "corrupt object",
  );
  await assert.rejects(
    restore(f.store, {
      schemaVersion: 1,
      operationId: uuid(),
      skillId: "test-skill",
      sourceVersion: 1,
      expectedVersion: 1,
      reason: "Must reject corruption",
      author,
    }),
    { code: "STORE_CORRUPT" },
  );
  assert.equal(f.store.head("test-skill"), f.publication.commit);
});

test("Restore refuses invalid skill format even with a matching content digest", async (t) => {
  const f = await published(t);
  const base = f.store.revision(f.publication.commit, "test-skill");
  await fs.writeFile(
    path.join(f.candidate.workspacePath, "SKILL.md"),
    "# Invalid historical skill",
  );
  const tree = await snapshotTree(f.candidate.workspacePath);
  const forged = {
    ...base.metadata,
    version: 2,
    parent: base.commit,
    digest: tree.digest,
    receipt: { operationId: uuid(), inputDigest: sha256("forged") },
    entries: tree.entries.map(({ data, ...entry }) => entry),
  };
  const bad = await f.store.publish(tree, forged);
  await assert.rejects(
    restore(f.store, {
      schemaVersion: 1,
      operationId: uuid(),
      skillId: "test-skill",
      sourceVersion: 2,
      expectedVersion: 2,
      reason: "Must reject invalid format",
      author,
    }),
    { code: "VALIDATION_FAILED" },
  );
  assert.equal(f.store.head("test-skill"), bad.commit);
});

test("Restore refuses unverifiable revision provenance", async (t) => {
  const f = await published(t);
  const base = f.store.revision(f.publication.commit, "test-skill");
  const tree = f.store.loadTree(base);
  const forged = {
    ...base.metadata,
    version: 2,
    parent: base.commit,
    sources: [],
    receipt: { operationId: uuid(), inputDigest: sha256("forged") },
  };
  const bad = await f.store.publish(tree, forged);
  await assert.rejects(
    restore(f.store, {
      schemaVersion: 1,
      operationId: uuid(),
      skillId: "test-skill",
      sourceVersion: 2,
      expectedVersion: 2,
      reason: "Must reject missing provenance",
      author,
    }),
    { code: "STORE_CORRUPT" },
  );
  assert.equal(f.store.head("test-skill"), bad.commit);
});

test("Exposed holdout cannot be recycled in another candidate", async (t) => {
  const f = await fixture(t);
  await submit(
    f.store,
    await submission(f.candidate, f.request, { score: 0.5 }),
  );
  const second = { ...f.request, operationId: uuid() };
  const c = await create(f.store, second);
  const { writeSkill } = await import("./helpers.mjs");
  await writeSkill(c);
  const brief = JSON.parse(await fs.readFile(c.briefPath));
  assert.equal(
    brief.exposedCasesNowDevelopment[0].id,
    f.request.policy.holdouts[0][0].id,
  );
  await assert.rejects(submit(f.store, await submission(c, second)), {
    code: "EVIDENCE_INVALID",
  });
});

test("Repetitions require full paired coverage and aggregate consistently", async (t) => {
  const f = await fixture(t);
  const p = policy();
  p.repetitions = 2;
  const req = createRequest("repeated-skill", p);
  const c = await create(f.store, req);
  const { writeSkill } = await import("./helpers.mjs");
  await writeSkill(c, "repeated-skill");
  const manifest = await submission(c, req);
  assert.equal(manifest.evidenceManifest.results.length, 4);
  assert.equal((await submit(f.store, manifest)).version, 1);
});
