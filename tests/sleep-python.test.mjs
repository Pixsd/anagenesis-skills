import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../dist/index.js";
import {
  MACOS_STUB,
  findPython,
  pythonEnv,
  runPython,
  vendorRoot,
} from "../dist/sleep/python.js";
import { temporary } from "./helpers.mjs";

let python = null;
try {
  python = findPython();
} catch {}
const needsPython = {
  skip: python ? false : "Python 3.10+ not found; sleep tests skipped",
};

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

test("Vendored skillopt_sleep matches its pinned manifest exactly", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(vendorRoot, "MANIFEST.json"), "utf8"),
  );
  assert.equal(manifest.commit, "45f65ca04f5f6713bca7b9797b495696ba812751");
  for (const [rel, digest] of Object.entries(manifest.files))
    assert.equal(
      sha256(await fs.readFile(path.join(vendorRoot, rel))),
      digest,
      rel,
    );
  const present = (await walk(path.join(vendorRoot, "skillopt_sleep")))
    .map((p) => path.relative(vendorRoot, p))
    .filter((p) => !p.split(path.sep).includes("__pycache__"));
  assert.deepEqual(
    present.sort(),
    Object.keys(manifest.files)
      .filter((p) => p.startsWith("skillopt_sleep/"))
      .sort(),
  );
});

test(
  "Every vendored module imports with the standard library only",
  needsPython,
  async (t) => {
    const root = await temporary(t);
    const script = path.join(root, "import_all.py");
    await fs.writeFile(
      script,
      [
        "import importlib, pkgutil, skillopt_sleep",
        "names = [m.name for m in pkgutil.walk_packages(skillopt_sleep.__path__, 'skillopt_sleep.')]",
        "for n in names: importlib.import_module(n)",
        "print(len(names))",
      ].join("\n"),
    );
    const result = await runPython(python, "import_all", [], {
      cwd: root,
      env: pythonEnv({
        home: root,
        tmp: root,
        extra: { PYTHONPATH: `${vendorRoot}${path.delimiter}${root}` },
      }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Number(result.stdout.trim()) >= 40);
    const caches = (await walk(vendorRoot)).filter((p) =>
      p.includes("__pycache__"),
    );
    assert.deepEqual(caches, [], "no bytecode written into the vendor");
  },
);

test("A missing or too old interpreter is a clean NOT_FOUND", async (t) => {
  assert.throws(
    () => findPython({ env: { ANAGENESIS_PYTHON: "/nonexistent/python3" } }),
    (e) => e.code === "NOT_FOUND" && e.details.requirement === "python>=3.10",
  );
  const root = await temporary(t);
  const old = path.join(root, "python3");
  await fs.writeFile(old, "#!/bin/sh\necho 3.9\n", { mode: 0o755 });
  assert.throws(() => findPython({ env: { ANAGENESIS_PYTHON: old } }), {
    code: "NOT_FOUND",
  });
});

test("The macOS python3 stub is never executed without Command Line Tools", () => {
  const probed = [];
  assert.throws(
    () =>
      findPython({
        env: { PATH: path.dirname(MACOS_STUB) },
        platform: "darwin",
        hasCommandLineTools: () => false,
        probe: (p) => (probed.push(p), "3.12"),
      }),
    { code: "NOT_FOUND" },
  );
  assert.ok(!probed.includes(MACOS_STUB));
});
