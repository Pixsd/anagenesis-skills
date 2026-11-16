// Caller-side helpers for the CLI: digests without the library, the default
// store, and installing the agent skill where agents discover skills.
import * as fs from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./errors.js";
import { snapshotTree } from "./tree.js";
import { findPython } from "./sleep/python.js";

/** The widest limits a policy may set, so any submittable tree can be hashed. */
const digestLimits = {
  maxFiles: 10_000,
  maxBytes: 100_000_000,
  maxFileBytes: 10_000_000,
};

export async function treeDigest(dir: string) {
  const tree = await snapshotTree(path.resolve(dir), digestLimits);
  return {
    algorithm: tree.algorithm,
    digest: tree.digest,
    files: tree.entries.filter((e) => e.type === "file").length,
  };
}

/** SHA-256 of a regular file, streamed. Opening non-blocking keeps FIFOs
 * from hanging; anything but a regular file is refused before reading. */
export async function fileDigest(file: string) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fail("NOT_FOUND", "File not found");
    throw e;
  }
  try {
    if (!(await handle.stat()).isFile())
      fail("INVALID_INPUT", "digest --file needs a regular file");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return { algorithm: "sha256", digest: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export function configPath(env = process.env) {
  if (env.ANAGENESIS_CONFIG) return env.ANAGENESIS_CONFIG;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "anagenesis", "config.json");
}

/** --store wins, then ANAGENESIS_STORE, then the store saved by install-skill. */
export async function defaultStore(env = process.env): Promise<string | null> {
  if (env.ANAGENESIS_STORE) return env.ANAGENESIS_STORE;
  try {
    const config = JSON.parse(await fs.readFile(configPath(env), "utf8"));
    return typeof config.storePath === "string" ? config.storePath : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail("INVALID_INPUT", "Unreadable Anagenesis config", {
      path: configPath(env),
    });
  }
}

const skillSource = fileURLToPath(
  new URL("../skills/anagenesis", import.meta.url),
);

/** Where agents look for skills (user scope under HOME, project scope under
 * the project). `.agents/skills` is the cross-client Agent Skills location
 * read by Codex, Gemini CLI, Cursor, GitHub Copilot and OpenCode; Claude Code
 * reads only `.claude/skills`. */
const targets = {
  claude: { dir: ".claude/skills", readBy: ["Claude Code"] },
  agents: {
    dir: ".agents/skills",
    readBy: ["Codex", "Gemini CLI", "Cursor", "GitHub Copilot", "OpenCode"],
  },
} as const;

const installCommand = "anagenesis install-skill --store /absolute/path/store";

/** Where the agent skill is visible: the user folders under HOME and the
 * project folders from the working directory up. Copies made elsewhere (other
 * installers, AGENTS.md references) are not seen, so this only ever hints. */
export async function skillStatus(cwd = process.cwd()) {
  const bases = [os.homedir()];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (dir !== os.homedir()) bases.push(dir);
    if (dir === path.dirname(dir)) break;
  }
  const found = [];
  const seen = new Set<string>();
  for (const base of bases)
    for (const { dir } of Object.values(targets)) {
      const candidate = path.join(base, dir, "anagenesis");
      if ((await skillName(candidate)) !== "anagenesis") continue;
      const real = await fs.realpath(candidate);
      if (!seen.has(real)) found.push(candidate);
      seen.add(real);
    }
  return found.length
    ? { installed: true, found }
    : {
        installed: false,
        hint: `Agents need the anagenesis skill to use this CLI correctly. Install it with: ${installCommand}`,
        install: installCommand,
      };
}

async function skillName(dir: string) {
  try {
    const text = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
    return /^---\n(?:.*\n)*?name:\s*(\S+)/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

function onPath(command: string, env = process.env) {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        accessSync(path.join(dir, command), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

export async function installSkill(options: {
  agent?: string;
  project?: string;
  store?: string;
}) {
  const agent = options.agent ?? "all";
  if (!["all", "claude", "agents"].includes(agent))
    fail("INVALID_INPUT", "--agent must be all, claude or agents");
  if (options.store !== undefined && !path.isAbsolute(options.store))
    fail("INVALID_INPUT", "--store must be an absolute path");
  const base = options.project ? path.resolve(options.project) : os.homedir();
  if (
    options.project &&
    !(await fs.stat(base).catch(() => null))?.isDirectory()
  )
    fail("NOT_FOUND", "Project directory not found");
  const chosen = (agent === "all" ? ["claude", "agents"] : [agent]) as Array<
    keyof typeof targets
  >;
  const installed = [];
  for (const key of chosen) {
    const dest = path.join(base, targets[key].dir, "anagenesis");
    const existing = await fs.lstat(dest).catch(() => null);
    if (existing && (await skillName(dest)) !== "anagenesis")
      fail("ALREADY_EXISTS", "Another skill already uses this folder", {
        path: dest,
      });
    // Copy beside the target, then swap, so an agent never reads half a skill.
    const staging = `${dest}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(skillSource, staging, { recursive: true });
    if (existing) await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(staging, dest);
    installed.push({ path: dest, readBy: targets[key].readBy });
  }
  let config = null;
  if (options.store !== undefined) {
    const file = configPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(
      tmp,
      JSON.stringify({ schemaVersion: 1, storePath: options.store }, null, 2) +
        "\n",
    );
    await fs.rename(tmp, file);
    config = { path: file, storePath: options.store };
  }
  const warnings = [];
  if (!onPath("anagenesis"))
    warnings.push(
      "The anagenesis command is not on PATH: install the package globally so agents can run it.",
    );
  if (!config && !(await defaultStore()))
    warnings.push(
      "No default store: pass --store /absolute/path or set ANAGENESIS_STORE.",
    );
  try {
    findPython();
  } catch {
    warnings.push(
      "Python 3.10+ not found: every command works except sleep. Set ANAGENESIS_PYTHON or install Python.",
    );
  }
  return {
    installed,
    config,
    agentsWithoutSkills: `Add to AGENTS.md: "Before creating, fixing, using or restoring skills, read ${installed[0]?.path ?? skillSource}/SKILL.md and follow it."`,
    restart:
      "Start a new agent session (or reload skills) so the agent lists the skill.",
    warnings,
  };
}
