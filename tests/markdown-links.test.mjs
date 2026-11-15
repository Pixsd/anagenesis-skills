import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { submit, restore, resolve } from "../dist/index.js";
import { fixture, submission, writeSkill, uuid, author } from "./helpers.mjs";

test("dot-relative inline and reference links survive submit and restore", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.candidate.workspacePath, "references"));
  await fs.writeFile(
    path.join(f.candidate.workspacePath, "references/guide.md"),
    "# Guide\n[Details](./details.md)\n",
  );
  await fs.writeFile(
    path.join(f.candidate.workspacePath, "references/details.md"),
    "# Details\n",
  );
  await writeSkill(
    f.candidate,
    "test-skill",
    "[Guide](./references/guide.md)\n[Encoded](%2E/references/guide.md#section)\n[Reference][guide]\n\n[guide]: ./references/./guide.md",
  );
  const published = await submit(
    f.store,
    await submission(f.candidate, f.request),
  );
  assert.equal(published.status, "published");
  const restored = await restore(f.store, {
    schemaVersion: 1,
    operationId: uuid(),
    skillId: "test-skill",
    sourceVersion: 1,
    expectedVersion: 1,
    reason: "Restore valid relative references",
    author,
  });
  assert.equal(restored.digest, published.digest);
  assert.equal(
    (await resolve(f.store, { schemaVersion: 1, skillId: "test-skill" }))
      .digest,
    published.digest,
  );
});

for (const ref of [
  "./../outside.md",
  "./%2e%2e/outside.md",
  "./references/../guide.md",
  "/etc/passwd",
  ".//etc/passwd",
  "./.git/config",
  "./references/missing.md",
]) {
  test(`dot-relative normalization still rejects unsafe or missing link ${ref}`, async (t) => {
    const f = await fixture(t);
    await writeSkill(f.candidate, "test-skill", `[Bad](${ref})`);
    const result = await submit(
      f.store,
      await submission(f.candidate, f.request),
    );
    assert.equal(result.status, "rejected");
    assert.equal(result.reasons[0].code, "VALIDATION_FAILED");
  });
}
