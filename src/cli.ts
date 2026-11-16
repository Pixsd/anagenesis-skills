#!/usr/bin/env node
import * as fs from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  create,
  improve,
  submit,
  history,
  restore,
  recordFeedback,
  resolve,
  sleep,
} from "./api.js";
import { fail, normalizeError, exitCode } from "./errors.js";
import {
  defaultStore,
  fileDigest,
  installSkill,
  skillStatus,
  treeDigest,
} from "./setup.js";
/** Options each command accepts; anything else is an error, not ignored. */
const allowed: Record<string, string[]> = {
  create: ["store", "request"],
  improve: ["store", "request"],
  submit: ["store", "request"],
  restore: ["store", "request"],
  feedback: ["store", "request"],
  sleep: ["store", "request"],
  history: ["store", "skill", "cursor", "limit"],
  resolve: ["store", "skill", "version"],
  digest: ["path", "file"],
  "install-skill": ["store", "agent", "project"],
};
async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        request: { type: "string" },
        store: { type: "string" },
        skill: { type: "string" },
        version: { type: "string" },
        cursor: { type: "string" },
        limit: { type: "string" },
        help: { type: "boolean" },
        path: { type: "string" },
        file: { type: "string" },
        agent: { type: "string" },
        project: { type: "string" },
      },
    });
  } catch {
    return fail("INVALID_INPUT", "Invalid command options");
  }
  const { values: v, positionals } = parsed;
  if (v.help)
    return {
      name: "anagenesis",
      schemaVersion: 1,
      commands: [
        "create",
        "improve",
        "submit",
        "history",
        "restore",
        "feedback",
        "resolve",
        "sleep",
        "digest",
        "install-skill",
      ],
      sleepActions: [
        "run",
        "resume",
        "dry-run",
        "harvest",
        "status",
        "adopt",
        "cleanup",
        "discard",
        "schedule",
        "unschedule",
        "evalkit",
      ],
      usage:
        "anagenesis COMMAND [--store /absolute/store] --request request.json|-; history/resolve: --skill ID [--version N | --cursor N --limit N]; digest: --path SKILL_DIR | --file FILE; install-skill [--store /absolute/store] [--agent all|claude|agents] [--project DIR]. Without --store: ANAGENESIS_STORE, then the store saved by install-skill.",
      skill: await skillStatus(),
    };
  const command = positionals[0];
  if (positionals.length !== 1 || !command || !(command in allowed))
    return fail("INVALID_INPUT", "Specify one known command; see --help");
  const extra = Object.keys(v).filter((k) => !allowed[command]!.includes(k));
  if (extra.length)
    fail("INVALID_INPUT", `Options not accepted by ${command}`, {
      options: extra,
    });
  // Digests need no store: they let callers fill expectedDigest,
  // candidateDigest, inputDigest and artifact keys without the library.
  if (command === "digest") {
    if (!!v.path === !!v.file)
      fail(
        "INVALID_INPUT",
        "digest takes exactly one of --path DIR or --file FILE",
      );
    return v.file ? fileDigest(v.file) : treeDigest(v.path!);
  }
  if (command === "install-skill")
    return installSkill({
      ...(v.agent !== undefined ? { agent: v.agent } : {}),
      ...(v.project !== undefined ? { project: v.project } : {}),
      ...(v.store !== undefined ? { store: v.store } : {}),
    });
  const storePath = v.store ?? (await defaultStore());
  if (!storePath) {
    const skill = await skillStatus();
    fail(
      "INVALID_INPUT",
      skill.installed
        ? "No store set: pass --store /absolute/path, set ANAGENESIS_STORE or run install-skill --store"
        : "No store set. Run anagenesis install-skill --store /absolute/path: it saves the store and installs the agent skill. Or pass --store / ANAGENESIS_STORE",
      { skill },
    );
  }
  const store = { storePath: storePath! };
  if (command === "history" || command === "resolve") {
    if (!v.skill) fail("INVALID_INPUT", `${command} requires --skill ID`);
    return command === "history"
      ? history(store, {
          schemaVersion: 1,
          skillId: v.skill,
          ...(v.cursor ? { cursor: Number(v.cursor) } : {}),
          ...(v.limit ? { limit: Number(v.limit) } : {}),
        })
      : resolve(store, {
          schemaVersion: 1,
          skillId: v.skill,
          ...(v.version ? { version: Number(v.version) } : {}),
        });
  }
  if (!v.request)
    fail("INVALID_INPUT", "Mutations require --request FILE or --request -");
  const commands = {
    create,
    improve,
    submit,
    restore,
    feedback: recordFeedback,
    sleep,
  };
  let raw: string;
  if (v.request === "-") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024)
        fail("INVALID_INPUT", "Request exceeds 32 MiB");
      chunks.push(Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks).toString("utf8");
  } else {
    if ((await fs.stat(v.request)).size > 32 * 1024 * 1024)
      fail("INVALID_INPUT", "Request exceeds 32 MiB");
    raw = await fs.readFile(v.request, "utf8");
  }
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    return fail("INVALID_INPUT", "Request must be JSON");
  }
  return commands[command as keyof typeof commands](store, request);
}
try {
  const result = await main();
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result && "status" in result && result.status === "rejected")
    process.exitCode = 4;
} catch (error) {
  const e = normalizeError(error);
  process.stdout.write(JSON.stringify({ error: e.toJSON() }) + "\n");
  process.exitCode = exitCode(e.code);
}
