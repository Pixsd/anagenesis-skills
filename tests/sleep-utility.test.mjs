import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { sleep } from "../dist/index.js";
import { opts, fresh } from "./sleep-helpers.mjs";

test(
  "schedule and unschedule keep a store crontab, replace entries and never invoke crontab",
  opts,
  async (t) => {
    const store = await fresh(t);
    const outside = path.dirname(store.root);
    const bin = path.join(outside, "bin");
    await fs.mkdir(bin);
    const marker = path.join(outside, "real-crontab-ran");
    await fs.writeFile(
      path.join(bin, "crontab"),
      `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
      { mode: 0o755 },
    );
    const saved = process.env.PATH;
    process.env.PATH = bin + path.delimiter + saved;
    t.after(() => {
      process.env.PATH = saved;
    });
    const req = {
      schemaVersion: 1,
      action: "schedule",
      project: "/work/project one",
      runner: "my-agent sleep-night --store '/store with spaces'",
      hour: 4,
      minute: 5,
    };
    const result = await sleep(store, req);
    assert.equal(result.status, "scheduled");
    assert.equal(
      result.crontabPath,
      path.join(store.root, "sleep", "schedule", "crontab"),
    );
    assert.match(result.crontab, /^5 4 \* \* \* {2}my-agent sleep-night/m);
    assert.deepEqual(await sleep(store, req), result);
    await sleep(store, {
      ...req,
      project: "/work/second",
      runner: "other-agent sleep",
    });
    const removed = await sleep(store, {
      schemaVersion: 1,
      action: "unschedule",
      project: req.project,
    });
    assert.doesNotMatch(removed.crontab, /my-agent/);
    assert.match(removed.crontab, /other-agent/);
    assert.deepEqual(
      await sleep(store, {
        schemaVersion: 1,
        action: "unschedule",
        project: req.project,
      }),
      removed,
    );
    const all = await sleep(store, {
      schemaVersion: 1,
      action: "unschedule",
      project: req.project,
      all: true,
    });
    assert.doesNotMatch(all.crontab, /skillopt-sleep/);
    await assert.rejects(fs.access(marker));
    assert.deepEqual(
      await fs.readdir(path.join(store.root, "sleep", "commands")),
      [],
    );
  },
);

test(
  "evalkit executes upstream paired A/B and A/A comparisons with caller files",
  opts,
  async (t) => {
    const store = await fresh(t);
    const root = path.dirname(store.root);
    const manifest = path.join(root, "manifest.json"),
      a = path.join(root, "a.json"),
      b = path.join(root, "b.json");
    await fs.writeFile(
      manifest,
      JSON.stringify(["task-1", "task-2", "task-3", "task-4"]),
    );
    await fs.writeFile(
      a,
      JSON.stringify({ "task-1": 0, "task-2": 0, "task-3": 0, "task-4": 1 }),
    );
    await fs.writeFile(
      b,
      JSON.stringify({ "task-1": 1, "task-2": 1, "task-3": 0, "task-4": 1 }),
    );
    const req = {
      schemaVersion: 1,
      action: "evalkit",
      manifest,
      a,
      b,
      boot: 100,
      seed: 7,
    };
    const compared = await sleep(store, req);
    assert.equal(compared.status, "evaluated");
    assert.equal(compared.result.n_tasks, 4);
    assert.equal(compared.result.delta, 0.5);
    assert.equal(compared.result.bootstrap.seed, 7);
    const { b: _, ...aa } = req;
    assert.equal((await sleep(store, { ...aa, aa: true })).result.delta, 0);
    await assert.rejects(sleep(store, { ...req, aa: true }), {
      code: "INVALID_INPUT",
    });
    await fs.writeFile(b, JSON.stringify({ "task-1": 1 }));
    await assert.rejects(
      sleep(store, req),
      (e) =>
        e.code === "VALIDATION_FAILED" && /task ids/.test(e.details.stderr),
    );
    assert.deepEqual(
      await fs.readdir(path.join(store.root, "sleep", "commands")),
      [],
    );
  },
);

test("Sleep utility request schemas reject unknown keys, unsafe paths and invalid options", async (t) => {
  const store = await fresh(t);
  for (const request of [
    { action: "schedule", project: "/work/demo", runner: "agent\ncrontab -r" },
    { action: "schedule", project: "/work/demo", runner: "agent", hour: 24 },
    {
      action: "schedule",
      project: "/work/demo",
      runner: "agent",
      crontabPath: "/tmp/crontab",
    },
    { action: "evalkit", manifest: "relative.json", a: "/a.json", aa: true },
    { action: "evalkit", manifest: "/m.json", a: "/a.json" },
  ])
    await assert.rejects(sleep(store, { schemaVersion: 1, ...request }), {
      code: "INVALID_INPUT",
    });
});
