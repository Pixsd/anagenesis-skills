import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateGate, selectGateScore, sha256 } from "../dist/index.js";
const fixtures = JSON.parse(
  await readFile(new URL("../fixtures/gate-parity.json", import.meta.url)),
);
test("Pinned Microsoft source matches fixture provenance", async () => {
  assert.equal(
    sha256(
      await readFile(
        new URL("../vendor/skillopt/skillopt_sleep/gate.py", import.meta.url),
      ),
    ),
    fixtures.sourceSha256,
  );
});
for (const [index, row] of fixtures.rows.entries())
  test(`Microsoft parity ${index}: ${row.input.metric}, weight ${row.input.mixed_weight}, ${row.result.action}`, () => {
    assert.deepEqual(evaluateGate(row.input), row.result);
    assert.equal(
      selectGateScore(
        row.input.cand_hard,
        row.input.cand_soft,
        row.input.metric,
        row.input.mixed_weight,
      ),
      row.score,
    );
  });
test("Project wrapper rejects invalid metrics and non-finite numbers", () => {
  for (const metric of ["unknown", null, {}])
    assert.throws(() => selectGateScore(1, 1, metric), {
      code: "INVALID_INPUT",
    });
  for (const n of [NaN, Infinity, -Infinity]) {
    assert.throws(() => selectGateScore(n, 1), { code: "INVALID_INPUT" });
    assert.throws(
      () => evaluateGate({ ...fixtures.rows[0].input, best_score: n }),
      { code: "INVALID_INPUT" },
    );
  }
});
