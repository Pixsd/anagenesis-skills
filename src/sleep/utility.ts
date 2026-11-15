// Scheduler and evalkit remain upstream commands, isolated inside the store.
import * as fs from "node:fs/promises";
import path from "node:path";
import type { Store } from "../store.js";
import type { SleepEvalkitRequest, SleepScheduleRequest } from "../schemas.js";
import { fail } from "../errors.js";
import { atomicWrite, exists } from "../io.js";
import { findPython, pythonEnv, runPython } from "./python.js";

type Unschedule = { action: "unschedule"; project: string; all?: boolean };
export async function sleepUtility(
  s: Store,
  req: SleepScheduleRequest | SleepEvalkitRequest | Unschedule,
) {
  const python = findPython();
  const root = path.join(s.root, "sleep", "commands");
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, "command-"));
  const home = path.join(dir, "home"),
    tmp = path.join(dir, "tmp"),
    bin = path.join(dir, "bin");
  try {
    for (const d of [home, tmp, bin]) await fs.mkdir(d, { mode: 0o700 });
    // A second barrier if a future upstream change bypasses the shim hooks.
    await fs.writeFile(path.join(bin, "crontab"), "#!/bin/sh\nexit 1\n", {
      mode: 0o700,
    });
    const env = pythonEnv({
      home,
      tmp,
      path: bin + path.delimiter + (process.env.PATH ?? "/usr/bin:/bin"),
    });
    if (req.action === "evalkit") {
      const args = [
        "evalkit",
        "--manifest",
        req.manifest,
        "--a",
        req.a,
        "--json",
      ];
      if (req.b) args.push("--b", req.b);
      if (req.aa) args.push("--aa");
      if (req.allowGraded) args.push("--allow-graded");
      for (const key of ["alpha", "boot", "seed"] as const)
        if (req[key] !== undefined) args.push("--" + key, String(req[key]));
      const result = await runPython(python, "anagenesis_sleep", args, {
        cwd: tmp,
        env,
      });
      if (result.code !== 0)
        fail("VALIDATION_FAILED", "SkillOpt evalkit refused the comparison", {
          code: result.code,
          stderr: result.stderr.slice(-4000),
        });
      return {
        status: "evaluated",
        result: JSON.parse(result.stdout) as Record<string, unknown>,
      };
    }
    return await s.lock("sleep-schedule", async () => {
      const schedule = path.join(s.root, "sleep", "schedule");
      await fs.mkdir(schedule, { recursive: true });
      const crontabPath = path.join(schedule, "crontab");
      // Project is only an upstream scheduler identifier; it is never a cwd.
      const args = [
        req.action,
        "--project",
        req.project,
        "--backend",
        "handoff",
      ];
      if (req.action === "schedule")
        args.push("--hour", String(req.hour), "--minute", String(req.minute));
      else if (req.all) args.push("--all");
      const result = await runPython(python, "anagenesis_sleep", args, {
        cwd: tmp,
        env: {
          ...env,
          ANAGENESIS_CRONTAB_IN: crontabPath,
          ANAGENESIS_CRONTAB_OUT: path.join(tmp, "crontab"),
          ANAGENESIS_RUNNER: req.action === "schedule" ? req.runner : "unused",
        },
      });
      if (result.code !== 0)
        fail("VALIDATION_FAILED", "SkillOpt scheduler failed", {
          code: result.code,
          stdout: result.stdout.slice(-4000),
          stderr: result.stderr.slice(-4000),
        });
      const out = path.join(tmp, "crontab");
      if (!(await exists(out)))
        fail("VALIDATION_FAILED", "SkillOpt scheduler returned no crontab");
      const crontab = await fs.readFile(out, "utf8");
      await atomicWrite(crontabPath, crontab);
      return {
        status: req.action === "schedule" ? "scheduled" : "unscheduled",
        crontabPath,
        crontab,
      };
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
