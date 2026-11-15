import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  temporary,
  createRequest,
  writeSkill,
  submission,
} from "./helpers.mjs";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function run(args, input, env) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { ...r, json: JSON.parse(r.stdout) };
}
test("CLI JSON stdin/file workflow, output channels, structured errors and exit codes", async (t) => {
  const root = await temporary(t);
  const store = path.join(root, "store");
  const req = createRequest();
  const created = run(
    ["create", "--store", store, "--request", "-"],
    JSON.stringify(req),
  );
  assert.equal(created.status, 0);
  assert.equal(created.stderr, "");
  await writeSkill(created.json);
  const submitReq = await submission(created.json, req);
  const p = path.join(root, "submit.json");
  await fs.writeFile(p, JSON.stringify(submitReq));
  const published = run(["submit", "--store", store, "--request", p]);
  assert.equal(published.status, 0);
  assert.equal(published.json.version, 1);
  assert.equal(
    run(["history", "--store", store, "--skill", "test-skill"]).json.revisions
      .length,
    1,
  );
  assert.equal(
    run(["resolve", "--store", store, "--skill", "test-skill"]).json.digest,
    published.json.digest,
  );
  const bad = run(["create", "--store", store, "--request", "-"], "{bad");
  assert.equal(bad.status, 2);
  assert.equal(bad.json.error.code, "INVALID_INPUT");
  assert.equal(bad.json.error.retryable, false);
  assert.deepEqual(bad.json.error.details, {});
  const conflict = run(
    ["create", "--store", store, "--request", "-"],
    JSON.stringify({ ...req, reason: "Different" }),
  );
  assert.equal(conflict.status, 3);
  assert.equal(
    run(["resolve", "--store", store, "--skill", "absent"]).status,
    5,
  );
  assert.equal(run(["--help"]).status, 0);
});
test("Git environment cannot redirect writes into the calling repository", async (t) => {
  const root = await temporary(t);
  const req = createRequest();
  const sourceGit = fileURLToPath(new URL("../.git", import.meta.url));
  const before = await fs.readFile(path.join(sourceGit, "HEAD"));
  const r = run(
    ["create", "--store", path.join(root, "store"), "--request", "-"],
    JSON.stringify(req),
    {
      GIT_DIR: sourceGit,
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: path.join(root, "injected-index"),
    },
  );
  assert.equal(r.status, 0);
  assert.deepEqual(await fs.readFile(path.join(sourceGit, "HEAD")), before);
  await assert.rejects(fs.stat(path.join(root, "injected-index")), {
    code: "ENOENT",
  });
});
