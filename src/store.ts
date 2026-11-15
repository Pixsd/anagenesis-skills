import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AnagenesisError, fail } from "./errors.js";
import {
  canonical,
  digestJson,
  exists,
  readJson,
  sha256,
  syncDirectory,
  within,
  withLock,
  writeJson,
} from "./io.js";
import {
  fromEntries,
  materializeTree,
  safeRelative,
  snapshotTree,
  type Snapshot,
  type TreeEntry,
} from "./tree.js";
import { policySchema, uuidSchema, type Policy } from "./schemas.js";
import type { EvaluationReport } from "./evaluation.js";
export type Phase =
  | "before-objects"
  | "after-objects"
  | "before-commit"
  | "after-commit"
  | "before-ref"
  | "after-ref"
  | "before-materialize"
  | "after-materialize-write"
  | "after-materialize"
  | "after-prepare";
export interface StoreOptions {
  storePath: string;
  onPhase?: (phase: Phase) => void | Promise<void>;
}
export interface Publication {
  status: "published";
  skillId: string;
  version: number;
  commit: string;
  digest: string;
  restoredFrom?: number;
  warnings?: string[];
}
export interface Receipt {
  operationId: string;
  inputDigest: string;
}
export interface Revision {
  schemaVersion: 1;
  skillId: string;
  version: number;
  digest: string;
  algorithm: "anagenesis-tree-v1";
  parent: string | null;
  timestamp: string;
  receipt: Receipt;
  kind: "submit" | "restore";
  candidateId?: string;
  restoredFrom?: number;
  sourceDigest?: string;
  author: { producer: string; model: string; modelVersion: string };
  reason: string;
  sources: unknown[];
  feedbackIds: string[];
  policy: Policy;
  report: EvaluationReport | null;
  diff: { added: string[]; modified: string[]; deleted: string[] };
  entries: Omit<TreeEntry, "data">[];
  evidence?: unknown;
  diagnosis?: unknown;
  mining?: unknown;
  warnings?: string[];
}
export interface StoredRevision {
  commit: string;
  metadata: Revision;
}
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export class Store {
  readonly root: string;
  readonly repo: string;
  private constructor(
    readonly options: StoreOptions,
    root: string,
  ) {
    this.root = root;
    this.repo = path.join(root, "repo.git");
  }
  static async open(options: StoreOptions): Promise<Store> {
    if (!options || !path.isAbsolute(options.storePath))
      fail("INVALID_INPUT", "storePath must be absolute");
    if (!["darwin", "linux"].includes(process.platform))
      fail(
        "INVALID_INPUT",
        "Supported platforms: macOS and Linux on local filesystems",
      );
    const requested = path.resolve(options.storePath);
    let ancestor = requested;
    const suffix: string[] = [];
    while (!(await exists(ancestor))) {
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
    const root = path.join(await fs.realpath(ancestor), ...suffix);
    if (within(await fs.realpath(packageRoot), root))
      fail("INVALID_INPUT", "Store must be outside the package source");
    for (let p = root; ; p = path.dirname(p)) {
      if (await exists(path.join(p, ".git")))
        fail("INVALID_INPUT", "Store must be outside source repositories");
      if (p !== root && (await exists(path.join(p, "anagenesis-store.json"))))
        fail(
          "INVALID_INPUT",
          "Nested stores and candidate workspaces cannot be stores",
        );
      if (path.dirname(p) === p) break;
    }
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const store = new Store(options, root);
    const version = /git version (\d+)\.(\d+)/.exec(
      store.gitRaw(["--version"]).toString(),
    );
    if (
      !version ||
      Number(version[1]) < 2 ||
      (Number(version[1]) === 2 && Number(version[2]) < 36)
    )
      fail("INVALID_INPUT", "Git 2.36 or newer is required for durable refs");
    await withLock(path.join(root, ".init.lock"), async () => {
      const marker = path.join(root, "anagenesis-store.json");
      if (!(await exists(marker))) {
        const entries = await fs.readdir(root);
        if (
          entries.some(
            (e) =>
              e !== ".init.lock" &&
              e !== ".initializing" &&
              !(e === "repo.git" && entries.includes(".initializing")) &&
              !e.startsWith(".repo-init-"),
          )
        )
          fail("INVALID_INPUT", "New store directory must be empty");
        // A private staging repository plus a durable intent makes initialization retryable.
        await writeJson(path.join(root, ".initializing"), { schemaVersion: 1 });
        if (!(await exists(store.repo))) {
          const staging = path.join(root, ".repo-init-" + randomUUID());
          store.gitRaw(["init", "--bare", "--template=", staging]);
          await fs.rename(staging, store.repo);
        }
        await writeJson(marker, {
          schemaVersion: 1,
          kind: "anagenesis-local-store",
        });
        await fs.rm(path.join(root, ".initializing"), { force: true });
      }
      const data = await readJson<{ schemaVersion: number; kind: string }>(
        marker,
      );
      if (data.schemaVersion !== 1 || data.kind !== "anagenesis-local-store")
        fail("STORE_CORRUPT", "Unknown store format");
      for (const dir of [
        "locks",
        "operations",
        "candidates",
        "workspaces",
        "feedback",
        "cache",
        "attempts",
      ]) {
        const p = path.join(root, dir);
        await fs.mkdir(p, { recursive: true });
        if ((await fs.lstat(p)).isSymbolicLink())
          fail("STORE_CORRUPT", "Store directories cannot be symlinks");
      }
      await store.assertDedicated();
      await syncDirectory(root);
    });
    return store;
  }
  gitRaw(args: string[], input?: string | Buffer): Buffer {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
    );
    try {
      return execFileSync("git", args, {
        input,
        maxBuffer: 128 * 1024 * 1024,
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_NAME: "Anagenesis",
          GIT_AUTHOR_EMAIL: "local@anagenesis.invalid",
          GIT_COMMITTER_NAME: "Anagenesis",
          GIT_COMMITTER_EMAIL: "local@anagenesis.invalid",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw new AnagenesisError("STORE_CORRUPT", "Git operation failed", {
        command: args.find((a) => !a.startsWith("-")),
      });
    }
  }
  git(args: string[], input?: string | Buffer): Buffer {
    return this.gitRaw(
      [
        "--git-dir=" + this.repo,
        "-c",
        "core.fsync=all",
        "-c",
        "core.fsyncMethod=fsync",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "gc.auto=0",
        ...args,
      ],
      input,
    );
  }
  async assertDedicated() {
    for (const relative of ["objects", "refs", "refs/skills", "config"]) {
      const target = path.join(this.repo, relative);
      if ((await exists(target)) && (await fs.realpath(target)) !== target)
        fail("STORE_CORRUPT", "Git paths cannot reuse external storage");
    }
    if (
      (await fs.lstat(this.repo)).isSymbolicLink() ||
      (await fs.realpath(this.repo)) !== this.repo
    )
      fail("STORE_CORRUPT", "Repository must be owned by the store");
    if (
      this.git(["rev-parse", "--is-bare-repository"]).toString().trim() !==
      "true"
    )
      fail("STORE_CORRUPT", "Store repository must be bare");
    if (this.git(["remote"]).toString().trim())
      fail("STORE_CORRUPT", "Store repository must have no remotes");
    if (
      (await exists(path.join(this.repo, "objects/info/alternates"))) ||
      (await exists(path.join(this.repo, "commondir")))
    )
      fail("STORE_CORRUPT", "Shared Git repositories are forbidden");
    const cfg = this.git(["config", "--local", "--list"]).toString();
    if (
      /^(include|includeif|extensions\.worktreeconfig|core\.worktree|core\.alternateRefsCommand|core\.sshCommand|core\.gitProxy)/im.test(
        cfg,
      )
    )
      fail("STORE_CORRUPT", "Unsupported repository configuration");
  }
  async phase(phase: Phase) {
    await this.options.onPhase?.(phase);
  }
  lock<T>(key: string, fn: () => Promise<T>) {
    return withLock(path.join(this.root, "locks", sha256(key) + ".lock"), fn);
  }
  head(skillId: string): string | null {
    const output = this.git([
      "for-each-ref",
      "--format=%(objectname)",
      `refs/skills/${skillId}`,
    ])
      .toString()
      .trim();
    if (!output) return null;
    if (!/^[a-f0-9]{40}$/.test(output))
      fail("STORE_CORRUPT", "Invalid skill ref");
    return output;
  }
  revision(commit: string, skillId: string): StoredRevision {
    const raw = this.git(["show", `${commit}:metadata.json`]);
    let metadata: Revision;
    try {
      metadata = JSON.parse(raw.toString());
    } catch {
      return fail("STORE_CORRUPT", "Malformed revision metadata");
    }
    if (
      metadata.schemaVersion !== 1 ||
      metadata.skillId !== skillId ||
      !Number.isInteger(metadata.version) ||
      metadata.version < 1 ||
      metadata.algorithm !== "anagenesis-tree-v1" ||
      !metadata.receipt?.operationId ||
      !metadata.author?.producer ||
      !metadata.reason ||
      !Array.isArray(metadata.entries)
    )
      fail("STORE_CORRUPT", "Revision provenance is invalid");
    if (
      !/^[a-f0-9]{64}$/.test(metadata.digest) ||
      !/^[a-f0-9]{64}$/.test(metadata.receipt.inputDigest) ||
      !uuidSchema.safeParse(metadata.receipt.operationId).success ||
      !policySchema.safeParse(metadata.policy).success ||
      !Array.isArray(metadata.sources) ||
      !metadata.sources.length ||
      !Array.isArray(metadata.feedbackIds) ||
      !["submit", "restore"].includes(metadata.kind)
    )
      fail("STORE_CORRUPT", "Invalid revision provenance or frozen policy");
    const parents = this.git(["rev-list", "--parents", "-n", "1", commit])
      .toString()
      .trim()
      .split(" ")
      .slice(1);
    if (
      parents.length > 1 ||
      (parents[0] ?? null) !== metadata.parent ||
      (metadata.version === 1) !== (metadata.parent === null)
    )
      fail("STORE_CORRUPT", "Invalid revision parent");
    return { commit, metadata };
  }
  chain(skillId: string, head = this.head(skillId)): StoredRevision[] {
    const list: StoredRevision[] = [];
    let current = head;
    let expected: number | undefined;
    while (current) {
      const rev = this.revision(current, skillId);
      if (expected !== undefined && rev.metadata.version !== expected)
        fail("STORE_CORRUPT", "Non-consecutive revision history");
      list.push(rev);
      expected = rev.metadata.version - 1;
      current = rev.metadata.parent;
    }
    for (const { metadata } of list)
      if (metadata.kind === "restore") {
        const source = list.find(
          (r) => r.metadata.version === metadata.restoredFrom,
        );
        if (
          !source ||
          source.metadata.version >= metadata.version ||
          source.metadata.digest !== metadata.sourceDigest ||
          metadata.digest !== metadata.sourceDigest
        )
          fail("STORE_CORRUPT", "Unverifiable restore provenance");
      }
    return list;
  }
  loadTree(revision: StoredRevision): Snapshot {
    const { metadata, commit } = revision;
    const entries: TreeEntry[] = [];
    const listing = this.git(["ls-tree", "-r", "-t", "-z", commit, "skill/"])
      .toString()
      .split("\0")
      .filter(Boolean);
    for (const line of listing) {
      if (line.endsWith("\tskill")) continue;
      const match = /^(\d+) (blob|tree) ([a-f0-9]+)\t(skill\/.+)$/.exec(line);
      if (!match) fail("STORE_CORRUPT", "Invalid committed tree entry");
      const p = match[4]!.slice(6);
      safeRelative(p);
      const mode = match[1]!;
      if (!["040000", "100644", "100755"].includes(mode))
        fail("STORE_CORRUPT", "Unsupported committed file mode");
      const data =
        mode === "040000"
          ? undefined
          : this.git(["cat-file", "blob", match[3]!]);
      entries.push({
        path: p,
        type: mode === "040000" ? "directory" : "file",
        mode: mode as TreeEntry["mode"],
        digest: sha256(data ?? ""),
        ...(data ? { data } : {}),
      });
    }
    const tree = fromEntries(entries);
    if (
      tree.digest !== metadata.digest ||
      digestJson(tree.entries.map(({ data: _, ...e }) => e)) !==
        digestJson(metadata.entries)
    )
      fail("STORE_CORRUPT", "Revision content digest mismatch");
    return tree;
  }
  publication(rev: StoredRevision): Publication {
    const m = rev.metadata;
    return {
      status: "published",
      skillId: m.skillId,
      version: m.version,
      commit: rev.commit,
      digest: m.digest,
      ...(m.restoredFrom ? { restoredFrom: m.restoredFrom } : {}),
      ...(m.warnings?.length ? { warnings: m.warnings } : {}),
    };
  }
  findReceipt(
    operationId: string,
  ): { revision: StoredRevision; inputDigest: string } | undefined {
    const refs = this.git([
      "for-each-ref",
      "--format=%(refname)",
      "refs/skills/",
    ])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const ref of refs)
      for (const revision of this.chain(ref.slice("refs/skills/".length)))
        if (revision.metadata.receipt.operationId === operationId)
          return {
            revision,
            inputDigest: revision.metadata.receipt.inputDigest,
          };
  }
  async operation<T>(
    kind: string,
    request: { operationId: string },
    work: (receipt: Receipt) => Promise<T>,
  ): Promise<T> {
    const inputDigest = digestJson({ kind, request });
    const op = request.operationId;
    return this.lock("operation:" + op, async () => {
      await this.assertDedicated();
      const p = path.join(this.root, "operations", op + ".json");
      const prior = (await exists(p))
        ? await readJson<{
            inputDigest: string;
            result?: T;
            error?: {
              code: AnagenesisError["code"];
              message: string;
              details: Record<string, unknown>;
            };
          }>(p)
        : undefined;
      if (prior && prior.inputDigest !== inputDigest)
        fail(
          "IDEMPOTENCY_CONFLICT",
          "operationId was already used for another input",
        );
      const committed = this.findReceipt(op);
      if (committed) {
        if (committed.inputDigest !== inputDigest)
          fail(
            "IDEMPOTENCY_CONFLICT",
            "operationId was published with another input",
          );
        return this.publication(committed.revision) as T;
      }
      if (prior?.result !== undefined) return prior.result;
      if (prior?.error)
        throw new AnagenesisError(
          prior.error.code,
          prior.error.message,
          prior.error.details,
        );
      await writeJson(p, { inputDigest });
      try {
        const result = await work({ operationId: op, inputDigest });
        await writeJson(p, { inputDigest, result });
        return result;
      } catch (e) {
        if (
          e instanceof AnagenesisError &&
          !["STORE_BUSY", "STORE_CORRUPT"].includes(e.code)
        )
          await writeJson(p, { inputDigest, error: e.toJSON() });
        throw e;
      }
    });
  }
  private writeTree(tree: Snapshot): string {
    const blobs = new Map<string, string>();
    for (const entry of tree.entries)
      if (entry.type === "file")
        blobs.set(
          entry.path,
          this.git(["hash-object", "-w", "--stdin"], entry.data)
            .toString()
            .trim(),
        );
    const build = (prefix: string): string => {
      const children = tree.entries.filter(
        (e) => path.posix.dirname(e.path) === (prefix || "."),
      );
      const input = children
        .map(
          (e) =>
            `${e.mode} ${e.type === "directory" ? "tree" : "blob"} ${e.type === "directory" ? build(e.path) : blobs.get(e.path)}\t${path.posix.basename(e.path)}\0`,
        )
        .join("");
      return this.git(["mktree", "-z"], input).toString().trim();
    };
    return build("");
  }
  async publish(tree: Snapshot, metadata: Revision): Promise<Publication> {
    await this.assertDedicated();
    await this.phase("before-objects");
    const skillTree = this.writeTree(tree);
    const meta = this.git(
      ["hash-object", "-w", "--stdin"],
      canonical(metadata) + "\n",
    )
      .toString()
      .trim();
    const root = this.git(
      ["mktree"],
      `100644 blob ${meta}\tmetadata.json\n040000 tree ${skillTree}\tskill\n`,
    )
      .toString()
      .trim();
    await this.phase("after-objects");
    await this.phase("before-commit");
    const commit = this.git([
      "commit-tree",
      root,
      ...(metadata.parent ? ["-p", metadata.parent] : []),
      "-m",
      `${metadata.skillId} v${metadata.version}: ${metadata.kind}`,
    ])
      .toString()
      .trim();
    await this.phase("after-commit");
    await this.phase("before-ref");
    try {
      this.git([
        "update-ref",
        `refs/skills/${metadata.skillId}`,
        commit,
        metadata.parent ?? "0".repeat(40),
      ]);
    } catch (e) {
      if (this.head(metadata.skillId) !== metadata.parent)
        fail("STALE_BASE", "Skill changed before publication");
      throw e;
    }
    await this.phase("after-ref");
    return this.publication({ commit, metadata });
  }
  async materialize(revision: StoredRevision): Promise<string> {
    await this.assertDedicated();
    const tree = this.loadTree(revision);
    const destination = path.join(this.root, "cache", revision.commit);
    return this.lock("cache:" + revision.commit, async () => {
      if (await exists(destination)) {
        try {
          if (
            (await snapshotTree(destination, revision.metadata.policy.limits))
              .digest === tree.digest
          )
            return destination;
        } catch {
          /* Cache is disposable; Git remains authoritative. */
        }
        // Quarantine corrupted cache without mutating any previously returned tree in place.
        await fs.rename(destination, destination + ".corrupt-" + randomUUID());
      }
      await this.phase("before-materialize");
      const temp = destination + ".tmp-" + randomUUID();
      await materializeTree(tree, temp, true);
      await this.phase("after-materialize-write");
      await fs.rename(temp, destination);
      await syncDirectory(path.dirname(destination));
      await this.phase("after-materialize");
      return destination;
    });
  }
}
export function diffTrees(before: Snapshot | null, after: Snapshot) {
  const old = new Map(before?.entries.map((e) => [e.path, e]) ?? []),
    next = new Map(after.entries.map((e) => [e.path, e]));
  return {
    added: [...next.keys()].filter((p) => !old.has(p)),
    modified: [...next.keys()].filter(
      (p) =>
        old.has(p) &&
        (old.get(p)!.digest !== next.get(p)!.digest ||
          old.get(p)!.mode !== next.get(p)!.mode),
    ),
    deleted: [...old.keys()].filter((p) => !next.has(p)),
  };
}
