// The agent skill must stay true to the code: its templates are validated
// against the schemas, and its documented procedures are replayed with the
// CLI only (digests included), as an agent following the skill would.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { snapshotTree } from "../dist/index.js";
import {
  createSchema,
  feedbackSchema,
  improveSchema,
  miningSchema,
  restoreSchema,
  sleepSchema,
  submitSchema,
} from "../dist/schemas.js";
import { temporary } from "./helpers.mjs";
import { opts as sleepOpts } from "./sleep-helpers.mjs";

const skillRoot = fileURLToPath(
  new URL("../skills/anagenesis/", import.meta.url),
);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const read = (rel) => fs.readFile(path.join(skillRoot, rel), "utf8");
const skill = await read("SKILL.md");
const references = {
  "references/requests.md": await read("references/requests.md"),
  "references/evaluation.md": await read("references/evaluation.md"),
  "references/sleep.md": await read("references/sleep.md"),
};
const templates = Object.fromEntries(
  [
    ...references["references/requests.md"].matchAll(
      /```json ([a-z-]+)\n([\s\S]*?)\n```/g,
    ),
  ].map(([, name, body]) => [name, JSON.parse(body)]),
);
const template = (name) => structuredClone(templates[name]);

/** Runs the CLI like an agent: JSON in, one JSON document out. */
function cliRun(args, { input, env, cwd } = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return { status: r.status, json: JSON.parse(r.stdout) };
}
function ok(r) {
  assert.equal(r.status, 0, JSON.stringify(r.json));
  return r.json;
}
const request = (store, command, body) =>
  cliRun([command, "--store", store, "--request", "-"], { input: body });

/** The examiner's job from references/evaluation.md, with CLI digests. */
async function examine(dir, prepared, attempt, [baseSoft, candSoft], base) {
  const plan = prepared.evaluationPlan.attempts[attempt];
  const expectedDigest = ok(
    cliRun(["digest", "--path", prepared.workspacePath]),
  ).digest;
  const artifacts = {};
  const record = async (c, split, side, soft) => {
    const answer = path.join(dir, `${c.id}-${side}-${attempt}.txt`);
    await fs.writeFile(answer, `${side} answer for ${c.id}`);
    const artifactDigest = ok(cliRun(["digest", "--file", answer])).digest;
    artifacts[artifactDigest] = await fs.readFile(answer, "utf8");
    return {
      ...template("run"),
      runId: `${c.id}-${side}-${attempt}`,
      caseId: c.id,
      split,
      inputDigest: c.inputDigest,
      artifactDigest,
      outcome: soft === 1 ? "pass" : "fail",
      hard: soft === 1 ? 1 : 0,
      soft,
    };
  };
  const results = [];
  for (const [cases, split, b, c] of [
    [plan.holdout, "holdout", baseSoft, candSoft],
    [plan.regression, "regression", 1, 1],
  ])
    for (const k of cases)
      results.push({
        baseline: await record(k, split, "baseline", b),
        candidate: await record(k, split, "candidate", c),
      });
  return {
    schemaVersion: 1,
    operationId: crypto.randomUUID(),
    candidateId: prepared.candidateId,
    expectedDigest,
    evidenceManifest: {
      schemaVersion: 1,
      candidateDigest: expectedDigest,
      baseVersion: base ? prepared.baseVersion : null,
      baseDigest: base ? prepared.baseDigest : null,
      baselineKind: base ? "revision" : "without_skill",
      policyDigest: prepared.evaluationPlan.policyDigest,
      suiteDigest: plan.suiteDigest,
      holdoutIndex: attempt,
      authorExposed: false,
      results,
      artifacts,
    },
  };
}
const skillText = (rule) =>
  `---\nname: zoho-mail\ndescription: Search, reply and archive Zoho Mail.\n---\n\n${rule}\n`;

async function createFromTemplate(t) {
  const dir = await temporary(t);
  const store = path.join(dir, "store");
  const created = ok(
    request(store, "create", {
      ...template("create"),
      operationId: crypto.randomUUID(),
    }),
  );
  return { dir, store, created };
}

async function publishFirst(t) {
  const { dir, store, created } = await createFromTemplate(t);
  await fs.writeFile(
    path.join(created.workspacePath, "SKILL.md"),
    skillText("Ask before sending."),
  );
  const published = ok(
    request(store, "submit", {
      ...(await examine(dir, created, 0, [0.25, 0.9])),
      mining: template("mining"),
    }),
  );
  assert.equal(published.status, "published");
  assert.equal(published.version, 1);
  return { dir, store, published };
}

test("The agent skill is a valid skill within the length guidance", () => {
  const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill);
  assert.ok(front, "frontmatter with name and description");
  assert.equal(front[1], "anagenesis");
  assert.ok(front[2].length > 50);
  assert.ok(skill.split("\n").length <= 500);
  assert.ok(skill.length <= 10_000, `${skill.length} characters`);
  for (const [, link] of skill.matchAll(/\]\((references\/[^)]+)\)/g))
    assert.ok(references[link] !== undefined, `broken link ${link}`);
});

test("Every template the skill names exists and matches the request schemas", () => {
  const text = [skill, ...Object.values(references)].join("\n");
  for (const [, name] of text.matchAll(/template: ([a-z-]+)/g))
    assert.ok(templates[name], `missing template ${name}`);
  const schemas = {
    create: createSchema,
    improve: improveSchema,
    feedback: feedbackSchema,
    restore: restoreSchema,
    mining: miningSchema,
    "submit-create": submitSchema,
    "submit-improve": submitSchema,
    "sleep-run": sleepSchema,
    "sleep-resume": sleepSchema,
    "sleep-adopt": sleepSchema,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    const parsed = schema.safeParse(templates[name]);
    assert.ok(
      parsed.success,
      `${name}: ${JSON.stringify(parsed.error?.issues)}`,
    );
  }
  // Fragments are valid wherever the request accepts them.
  const submit = template("submit-improve");
  submit.diagnosis = template("diagnosis");
  submit.evidenceManifest.results[0].candidate = template("run");
  assert.ok(submitSchema.safeParse(submit).success, "run and diagnosis");
  assert.deepEqual(
    Object.keys(templates).sort(),
    [...Object.keys(schemas), "run", "diagnosis"].sort(),
  );
});

test("Following the skill with the CLI and the templates publishes a version", async (t) => {
  const { published } = await publishFirst(t);
  assert.match(published.digest, /^[a-f0-9]{64}$/);
});

test("A rejected attempt is retried on nextHoldoutIndex, as the skill describes", async (t) => {
  const { dir, store, created } = await createFromTemplate(t);
  await fs.writeFile(
    path.join(created.workspacePath, "SKILL.md"),
    skillText("Reply to customers."),
  );
  const first = request(store, "submit", {
    ...(await examine(dir, created, 0, [0.5, 0.5])),
    mining: template("mining"),
  });
  assert.equal(first.status, 4, JSON.stringify(first.json));
  assert.equal(first.json.status, "rejected");
  assert.equal(first.json.nextHoldoutIndex, 1);
  // Submitting on the burnt group again is refused with the right index.
  const wrong = request(store, "submit", {
    ...(await examine(dir, created, 0, [0.25, 0.9])),
    mining: template("mining"),
  });
  assert.equal(wrong.json.error?.code, "EVIDENCE_INVALID");
  assert.equal(wrong.json.error.details.nextHoldoutIndex, 1);
  // The author revises the skill; the examiner evaluates on the spare group.
  await fs.writeFile(
    path.join(created.workspacePath, "SKILL.md"),
    skillText("Reply to customers from sales@."),
  );
  const second = ok(
    request(store, "submit", {
      ...(await examine(dir, created, 1, [0.25, 0.9])),
      mining: template("mining"),
    }),
  );
  assert.equal(second.status, "published");
});

test("Feedback, improve with a diagnosis and restore follow the templates", async (t) => {
  const { dir, store, published } = await publishFirst(t);
  const used = ok(
    cliRun(["resolve", "--store", store, "--skill", "zoho-mail"]),
  );
  const feedback = ok(
    request(store, "feedback", {
      ...template("feedback"),
      operationId: crypto.randomUUID(),
      version: used.version,
      artifactDigest: used.digest,
    }),
  );
  const improve = template("improve");
  improve.operationId = crypto.randomUUID();
  improve.expectedVersion = published.version;
  improve.feedbackIds = [feedback.feedbackId];
  const prepared = ok(request(store, "improve", improve));
  // The examiner's baseline is the immutable base version.
  const base = ok(
    cliRun([
      "resolve",
      "--store",
      store,
      "--skill",
      "zoho-mail",
      "--version",
      String(prepared.baseVersion),
    ]),
  );
  assert.equal(base.digest, prepared.baseDigest);
  await fs.writeFile(
    path.join(prepared.workspacePath, "SKILL.md"),
    skillText("Ask before sending. Reply to customers from sales@."),
  );
  const diagnosis = template("diagnosis");
  diagnosis[0].evidenceIds = [feedback.feedbackId];
  const v2 = ok(
    request(store, "submit", {
      ...(await examine(dir, prepared, 0, [0.5, 1], true)),
      diagnosis,
    }),
  );
  assert.equal(v2.version, 2);
  const page = ok(
    cliRun([
      "history",
      "--store",
      store,
      "--skill",
      "zoho-mail",
      "--limit",
      "1",
    ]),
  );
  assert.equal(page.revisions[0].metadata.version, 2);
  assert.equal(page.nextCursor, 2);
  const older = ok(
    cliRun([
      "history",
      "--store",
      store,
      "--skill",
      "zoho-mail",
      "--cursor",
      String(page.nextCursor),
    ]),
  );
  assert.equal(older.revisions[0].metadata.version, 1);
  const restore = template("restore");
  restore.operationId = crypto.randomUUID();
  restore.sourceVersion = 1;
  restore.expectedVersion = 2;
  const v3 = ok(request(store, "restore", restore));
  assert.equal(v3.version, 3);
  assert.equal(v3.digest, published.digest);
});

test(
  "The sleep-run template starts a night that hashes the supplied memory",
  sleepOpts,
  async (t) => {
    const { store, dir } = await publishFirst(t);
    const run = template("sleep-run");
    run.operationId = crypto.randomUUID();
    run.skills = [{ skillId: "zoho-mail", expectedVersion: 1 }];
    const night = ok(request(store, "sleep", run));
    assert.equal(night.status, "pending");
    const { pending } = JSON.parse(
      await fs.readFile(night.pending.pendingPath, "utf8"),
    );
    assert.ok(pending.length > 0);
    for (const item of pending) {
      assert.equal(typeof item.prompt, "string");
      assert.ok(path.isAbsolute(item.answer_file));
    }
    // The memory hash the skill compares before adopting is the file digest.
    const memory = path.join(dir, "AGENTS.md");
    await fs.writeFile(memory, run.memory.text);
    const record = JSON.parse(
      await fs.readFile(
        path.join(store, "sleep", "nights", night.sleepId, "run.json"),
        "utf8",
      ),
    );
    assert.equal(record.memory.label, "AGENTS.md");
    assert.equal(
      record.memory.baseSha256,
      ok(cliRun(["digest", "--file", memory])).digest,
    );
  },
);

test("digest hashes trees and regular files and refuses special files", async (t) => {
  const dir = await temporary(t);
  const tree = path.join(dir, "skill");
  await fs.mkdir(path.join(tree, "references"), { recursive: true });
  await fs.writeFile(path.join(tree, "SKILL.md"), skillText("Body"));
  await fs.writeFile(path.join(tree, "references", "a.md"), "A\n");
  const byTree = ok(cliRun(["digest", "--path", tree]));
  assert.equal(byTree.digest, (await snapshotTree(tree)).digest);
  assert.equal(byTree.files, 2);
  const file = path.join(tree, "SKILL.md");
  assert.deepEqual(ok(cliRun(["digest", "--file", file])), {
    algorithm: "sha256",
    digest: crypto
      .createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex"),
  });
  const fifo = path.join(dir, "fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  for (const [args, code] of [
    [["--file", fifo], "INVALID_INPUT"],
    [["--file", dir], "INVALID_INPUT"],
    [["--file", path.join(dir, "absent")], "NOT_FOUND"],
    [["--path", path.join(dir, "absent")], "NOT_FOUND"],
    [["--path", file], "INVALID_INPUT"],
    [[], "INVALID_INPUT"],
    [["--path", tree, "--file", file], "INVALID_INPUT"],
    [["--path", tree, "--store", dir], "INVALID_INPUT"],
  ]) {
    const r = cliRun(["digest", ...args]);
    assert.equal(r.json.error?.code, code, JSON.stringify([args, r.json]));
  }
});

test("Commands refuse options they do not accept", () => {
  for (const args of [
    ["create", "--store", "/tmp/x", "--request", "-", "--path", "/tmp"],
    ["history", "--store", "/tmp/x", "--skill", "a", "--version", "1"],
    ["resolve", "--store", "/tmp/x", "--skill", "a", "--limit", "1"],
    ["resolve", "--store", "/tmp/x", "--skill", "a", "--request", "-"],
    ["install-skill", "--file", "/tmp/x"],
    ["unknown"],
    ["create", "extra", "--store", "/tmp/x", "--request", "-"],
  ]) {
    const r = cliRun(args, { input: {} });
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.json.error.code, "INVALID_INPUT");
  }
});

test("install-skill puts the skill where agents look and saves the store", async (t) => {
  const home = await temporary(t);
  const config = path.join(home, "config", "anagenesis.json");
  const store = path.join(home, "store");
  const env = { HOME: home, ANAGENESIS_CONFIG: config, ANAGENESIS_STORE: "" };
  // Before installing, help and the missing-store error point to install-skill.
  const before = ok(cliRun(["--help"], { env, cwd: home })).skill;
  assert.equal(before.installed, false);
  assert.match(before.install, /^anagenesis install-skill --store /);
  const noStore = cliRun(["history", "--skill", "x"], { env, cwd: home });
  assert.equal(noStore.json.error.code, "INVALID_INPUT");
  assert.match(noStore.json.error.message, /installs the agent skill/);
  assert.equal(noStore.json.error.details.skill.installed, false);
  const result = ok(cliRun(["install-skill", "--store", store], { env }));
  const after = ok(cliRun(["--help"], { env, cwd: home })).skill;
  assert.deepEqual(after, {
    installed: true,
    found: [".claude/skills", ".agents/skills"].map((d) =>
      path.join(home, d, "anagenesis"),
    ),
  });
  for (const dir of [".claude/skills", ".agents/skills"]) {
    const dest = path.join(home, dir, "anagenesis");
    assert.ok(result.installed.some((i) => i.path === dest));
    for (const file of [
      "SKILL.md",
      "references/requests.md",
      "references/evaluation.md",
      "references/sleep.md",
    ])
      assert.equal(
        await fs.readFile(path.join(dest, file), "utf8"),
        await read(file),
      );
  }
  assert.deepEqual(JSON.parse(await fs.readFile(config, "utf8")), {
    schemaVersion: 1,
    storePath: store,
  });
  // Commands now find the store without --store.
  const created = cliRun(["create", "--request", "-"], {
    input: { ...template("create"), operationId: crypto.randomUUID() },
    env,
  });
  assert.equal(created.status, 0, JSON.stringify(created.json));
  assert.ok((await fs.stat(path.join(store))).isDirectory());
  // Reinstalling replaces our own folder; another skill's folder is refused.
  ok(cliRun(["install-skill", "--agent", "claude"], { env }));
  const project = path.join(home, "project");
  const foreign = path.join(project, ".agents", "skills", "anagenesis");
  await fs.mkdir(foreign, { recursive: true });
  await fs.writeFile(
    path.join(foreign, "SKILL.md"),
    "---\nname: something-else\ndescription: x\n---\n",
  );
  const refused = cliRun(
    ["install-skill", "--agent", "agents", "--project", project],
    { env },
  );
  assert.equal(refused.json.error?.code, "ALREADY_EXISTS");
  // A damaged copy of ours (SKILL.md gone) is repaired; an unknown file is not.
  const damaged = path.join(project, ".claude", "skills", "anagenesis");
  await fs.mkdir(path.join(damaged, "references"), { recursive: true });
  await fs.writeFile(path.join(damaged, "references", "sleep.md"), "partial");
  await fs.writeFile(path.join(damaged, "notes.txt"), "mine");
  const kept = cliRun(
    ["install-skill", "--agent", "claude", "--project", project],
    { env },
  );
  assert.equal(kept.json.error?.code, "ALREADY_EXISTS");
  await fs.rm(path.join(damaged, "notes.txt"));
  const projectClaude = ok(
    cliRun(["install-skill", "--agent", "claude", "--project", project], {
      env,
    }),
  );
  assert.equal(
    projectClaude.installed[0].path,
    path.join(project, ".claude", "skills", "anagenesis"),
  );
  // A project install is found from inside the project.
  const nested = path.join(project, "src");
  await fs.mkdir(nested);
  const inProject = ok(
    cliRun(["--help"], {
      env: { ...env, HOME: path.join(home, "other") },
      cwd: nested,
    }),
  ).skill;
  // The nearest copy comes first; the folders above are listed after it.
  assert.equal(
    await fs.realpath(inProject.found[0]),
    await fs.realpath(path.join(project, ".claude", "skills", "anagenesis")),
  );
  for (const bad of [
    ["install-skill", "--agent", "vim"],
    ["install-skill", "--store", "relative/store"],
  ])
    assert.equal(cliRun(bad, { env }).json.error?.code, "INVALID_INPUT");
  // Without --store and without a config, commands explain how to set one.
  const bare = cliRun(["history", "--skill", "x"], {
    env: { ...env, ANAGENESIS_CONFIG: path.join(home, "none.json") },
    cwd: home,
  });
  assert.equal(bare.json.error.details.skill.installed, true);
  assert.equal(bare.json.error?.code, "INVALID_INPUT");
  assert.match(bare.json.error.message, /install-skill --store/);
});
