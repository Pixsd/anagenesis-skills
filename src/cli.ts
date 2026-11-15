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
} from "./api.js";
import { fail, normalizeError, exitCode } from "./errors.js";
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
      ],
      usage:
        "anagenesis COMMAND --store /absolute/store --request request.json|-; history/resolve: --skill ID [--version N | --cursor N --limit N]",
    };
  if (positionals.length !== 1 || !v.store)
    fail("INVALID_INPUT", "Specify a command and --store /absolute/path");
  const command = positionals[0]!;
  const store = { storePath: v.store };
  if (command === "history" || command === "resolve") {
    if (
      v.request ||
      !v.skill ||
      (command === "history" && v.version) ||
      (command === "resolve" && (v.cursor || v.limit))
    )
      fail("INVALID_INPUT", "Invalid read command options");
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
  if (!v.request || v.skill || v.version || v.cursor || v.limit)
    fail("INVALID_INPUT", "Mutations require --request FILE or --request -");
  const commands = {
    create,
    improve,
    submit,
    restore,
    feedback: recordFeedback,
  };
  if (!(command in commands)) fail("INVALID_INPUT", "Unknown command");
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
