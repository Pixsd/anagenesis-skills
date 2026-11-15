import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { findPython, pythonEnv, runPython } from "../dist/sleep/python.js";
import { temporary } from "./helpers.mjs";

let python = null;
try {
  python = findPython();
} catch {}
const opts = {
  skip: python ? false : "Python 3.10+ not found; sleep tests skipped",
};
async function env(t, extra = {}) {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, "home"));
  await fs.mkdir(path.join(root, "tmp"));
  return {
    root,
    env: pythonEnv({
      home: path.join(root, "home"),
      tmp: path.join(root, "tmp"),
      extra,
    }),
  };
}
async function script(t, code) {
  const e = await env(t);
  await fs.writeFile(path.join(e.root, "probe.py"), code);
  const r = await runPython(python, "probe", [], {
    cwd: e.root,
    env: {
      ...e.env,
      PYTHONPATH: `${e.env.PYTHONPATH}${path.delimiter}${e.root}`,
    },
  });
  return { ...r, root: e.root };
}

test(
  "Ingest converts generic transcripts into redacted digests",
  opts,
  async (t) => {
    const { root, env: childEnv } = await env(t);
    const secret = "sk-live-ABCDEF1234567890abcdef";
    const transcripts = [
      {
        sessionId: "s1",
        project: "/work/demo",
        startedAt: "2026-11-14T10:00:00Z",
        userPrompts: [`Deploy with api_key=${secret}`],
        assistantFinals: ["Done"],
        feedbackSignals: ["still broken"],
      },
    ];
    const input = path.join(root, "transcripts.json");
    const out = path.join(root, "handoff", "digests.json");
    await fs.writeFile(input, JSON.stringify(transcripts));
    const r = await runPython(
      python,
      "anagenesis_sleep",
      ["ingest", input, out],
      {
        cwd: root,
        env: childEnv,
      },
    );
    assert.equal(r.code, 0, r.stderr);
    const text = await fs.readFile(out, "utf8");
    assert.ok(!text.includes(secret));
    const [digest] = JSON.parse(text);
    assert.equal(digest.session_id, "s1");
    assert.equal(digest.n_user_turns, 1);
    assert.deepEqual(digest.feedback_signals, ["still broken"]);
    await fs.writeFile(
      input,
      JSON.stringify([{ ...transcripts[0], extra: 1 }]),
    );
    const bad = await runPython(
      python,
      "anagenesis_sleep",
      ["ingest", input, out],
      { cwd: root, env: childEnv },
    );
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /unknown transcript fields/);
  },
);

test(
  "Rollouts get distinct prompt ids; sample 0 keeps upstream ids",
  opts,
  async (t) => {
    const r = await script(
      t,
      [
        "import json, tempfile",
        "from anagenesis_sleep.__main__ import install",
        "from skillopt_sleep.handoff_backend import HandoffBackend as Upstream",
        "install()",
        "import skillopt_sleep.handoff_backend as hb",
        "from anagenesis_sleep import backend",
        "ours, up = hb.HandoffBackend(handoff_dir=tempfile.mkdtemp()), Upstream(handoff_dir=tempfile.mkdtemp())",
        "up._call('PROMPT')",
        "ours._call('PROMPT')",
        "backend._local.sample_id = 2",
        "ours._call('PROMPT')",
        "print(json.dumps({'up': list(up.pending), 'ours': list(ours.pending)}))",
      ].join("\n"),
    );
    assert.equal(r.code, 0, r.stderr);
    const { up, ours } = JSON.parse(r.stdout.trim().split("\n").at(-1));
    assert.equal(ours[0], up[0]);
    assert.equal(ours.length, 2);
    assert.notEqual(ours[1], ours[0]);
  },
);

test(
  "schedule writes the crontab only into the store, never runs crontab",
  opts,
  async (t) => {
    const { root, env: childEnv } = await env(t);
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    const marker = path.join(root, "crontab-was-run");
    await fs.writeFile(
      path.join(bin, "crontab"),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`,
      { mode: 0o755 },
    );
    const out = path.join(root, "crontab.out");
    const input = path.join(root, "crontab.in");
    await fs.writeFile(input, "0 1 * * * existing-job\n");
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const r = await runPython(
      python,
      "anagenesis_sleep",
      ["schedule", "--project", project, "--hour", "4", "--minute", "5"],
      {
        cwd: root,
        env: {
          ...childEnv,
          PATH: `${bin}${path.delimiter}${childEnv.PATH}`,
          ANAGENESIS_CRONTAB_IN: input,
          ANAGENESIS_CRONTAB_OUT: out,
          ANAGENESIS_RUNNER: "my-agent-cli run-sleep",
        },
      },
    );
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const crontab = await fs.readFile(out, "utf8");
    assert.match(crontab, /existing-job/);
    assert.match(crontab, /# >>> skillopt-sleep \(managed\) >>>/);
    assert.match(crontab, /^5 4 \* \* \* {2}my-agent-cli run-sleep/m);
    await assert.rejects(fs.access(marker));
  },
);

test(
  "The shim refuses to run when an upstream hook disappeared",
  opts,
  async (t) => {
    const r = await script(
      t,
      [
        "import skillopt_sleep.scheduler as s",
        "del s._runner_cmd",
        "from anagenesis_sleep.__main__ import install",
        "install()",
      ].join("\n"),
    );
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /_runner_cmd no longer exists/);
  },
);
