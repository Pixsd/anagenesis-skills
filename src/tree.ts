import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { digestJson, sha256, syncDirectory } from "./io.js";
import { fail } from "./errors.js";
import type { Policy } from "./schemas.js";
export interface TreeEntry {
  path: string;
  type: "file" | "directory";
  mode: "100644" | "100755" | "040000";
  digest: string;
  data?: Buffer;
}
export interface Snapshot {
  algorithm: "anagenesis-tree-v1";
  digest: string;
  entries: TreeEntry[];
}
export const defaultLimits = {
  maxFiles: 1000,
  maxBytes: 10_000_000,
  maxFileBytes: 1_000_000,
};
export function safeRelative(p: string) {
  if (
    !p ||
    p.includes("\\") ||
    p.includes("\0") ||
    p.includes("\n") ||
    path.posix.isAbsolute(p) ||
    /^[a-zA-Z]:/.test(p) ||
    p
      .split("/")
      .some(
        (s) => !s || s === "." || s === ".." || s.toLowerCase() === ".git",
      ) ||
    p !== p.normalize("NFC")
  )
    fail("VALIDATION_FAILED", "Unsafe or non-normalized tree path", {
      path: p,
    });
}
export function fromEntries(entries: TreeEntry[]): Snapshot {
  for (const entry of entries) {
    if (
      (entry.type === "file" && !Buffer.isBuffer(entry.data)) ||
      entry.digest !== sha256(entry.data ?? "")
    )
      fail("STORE_CORRUPT", "Snapshot bytes do not match entry digest", {
        path: entry.path,
      });
  }
  entries.sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  return {
    algorithm: "anagenesis-tree-v1",
    digest: digestJson({
      algorithm: "anagenesis-tree-v1",
      entries: entries.map(({ data: _, ...entry }) => entry),
    }),
    entries,
  };
}
export async function snapshotTree(
  root: string,
  limits = defaultLimits,
): Promise<Snapshot> {
  const entries: TreeEntry[] = [];
  let total = 0;
  let files = 0;
  async function walk(dir: string, prefix: string) {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail(
        "VALIDATION_FAILED",
        "Skill root and directories must not be symlinks",
      );
    for (const name of await fs.readdir(dir)) {
      const relative = prefix ? prefix + "/" + name : name;
      safeRelative(relative);
      const p = path.join(dir, name);
      const s = await fs.lstat(p);
      if (entries.length >= limits.maxFiles * 2)
        fail("VALIDATION_FAILED", "Too many tree entries");
      if (s.isDirectory()) {
        entries.push({
          path: relative,
          type: "directory",
          mode: "040000",
          digest: sha256(""),
        });
        await walk(p, relative);
      } else if (s.isFile()) {
        if (
          ++files > limits.maxFiles ||
          s.size > limits.maxFileBytes ||
          total + s.size > limits.maxBytes
        )
          fail("VALIDATION_FAILED", "Skill exceeds configured size limits");
        const fd = await fs.open(
          p,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        let data: Buffer;
        try {
          const checked = await fd.stat();
          if (
            !checked.isFile() ||
            checked.ino !== s.ino ||
            checked.dev !== s.dev
          )
            fail("VALIDATION_FAILED", "File changed during snapshot");
          data = await fd.readFile();
        } finally {
          await fd.close();
        }
        total += data.length;
        if (data.length > limits.maxFileBytes || total > limits.maxBytes)
          fail("VALIDATION_FAILED", "Skill exceeds configured size limits");
        entries.push({
          path: relative,
          type: "file",
          mode: s.mode & 0o111 ? "100755" : "100644",
          digest: sha256(data),
          data,
        });
      } else
        fail(
          "VALIDATION_FAILED",
          "Symlinks and special files are not supported",
          { path: relative },
        );
    }
  }
  await walk(root, "");
  return fromEntries(entries);
}
export function validateTree(
  tree: Snapshot,
  skillId: string,
  limits: Policy["limits"] = defaultLimits,
) {
  const files = tree.entries.filter((e) => e.type === "file");
  if (
    files.length > limits.maxFiles ||
    files.reduce((s, e) => s + e.data!.length, 0) > limits.maxBytes ||
    files.some((e) => e.data!.length > limits.maxFileBytes)
  )
    fail("VALIDATION_FAILED", "Skill exceeds configured size limits");
  const names = new Set<string>();
  for (const e of tree.entries) {
    safeRelative(e.path);
    const key = e.path.toLowerCase();
    if (names.has(key))
      fail("VALIDATION_FAILED", "Duplicate or case-colliding path");
    names.add(key);
  }
  const main = files.find((e) => e.path === "SKILL.md");
  if (!main) fail("VALIDATION_FAILED", "SKILL.md is required");
  for (const file of files) {
    if (
      !/\.(md|txt|json|ya?ml|[cm]?[jt]s|tsx|jsx|py|sh|csv|html|css|xml|svg)$/i.test(
        file.path,
      )
    )
      continue;
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
    } catch {
      return fail("VALIDATION_FAILED", "Text files must be UTF-8", {
        path: file.path,
      });
    }
    if (file.path === "SKILL.md") {
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
      if (!match)
        fail("VALIDATION_FAILED", "SKILL.md requires YAML frontmatter");
      const doc = parseDocument(match[1]!);
      if (doc.errors.length)
        fail("VALIDATION_FAILED", "Invalid or duplicate YAML keys");
      let meta: Record<string, unknown>;
      try {
        meta = doc.toJS({ maxAliasCount: 20 }) as Record<string, unknown>;
      } catch {
        return fail("VALIDATION_FAILED", "Invalid YAML frontmatter aliases");
      }
      if (
        !meta ||
        meta.name !== skillId ||
        typeof meta.description !== "string" ||
        !meta.description.trim() ||
        !content.slice(match[0].length).trim()
      )
        fail(
          "VALIDATION_FAILED",
          "Frontmatter name must equal skillId; description and body are required",
        );
    }
    if (!file.path.endsWith(".md")) continue;
    const refs = [...content.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)].map(
      (m) => m[1]!,
    );
    refs.push(
      ...[...content.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map((m) => m[1]!),
    );
    for (let ref of refs) {
      ref = ref.replace(/^<|>$/g, "");
      if (/^(https?:|mailto:)/i.test(ref) || ref.startsWith("#")) continue;
      try {
        ref = decodeURIComponent(ref.split(/[?#]/)[0]!);
      } catch {
        fail("VALIDATION_FAILED", "Invalid reference encoding");
      }
      safeRelative(ref);
      const target = path.posix.join(path.posix.dirname(file.path), ref);
      if (!tree.entries.some((e) => e.path === target))
        fail("VALIDATION_FAILED", "Missing local reference", {
          path: file.path,
          target,
        });
    }
  }
}
export async function materializeTree(
  tree: Snapshot,
  destination: string,
  readonly = false,
) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of tree.entries) {
    const p = path.join(destination, entry.path);
    if (entry.type === "directory") await fs.mkdir(p, { recursive: true });
    else {
      await fs.mkdir(path.dirname(p), { recursive: true });
      const f = await fs.open(p, "wx", entry.mode === "100755" ? 0o755 : 0o644);
      try {
        await f.writeFile(entry.data!);
        await f.sync();
      } finally {
        await f.close();
      }
      if (readonly) await fs.chmod(p, entry.mode === "100755" ? 0o555 : 0o444);
    }
  }
  for (const e of [...tree.entries].reverse())
    if (e.type === "directory") {
      await syncDirectory(path.join(destination, e.path));
      if (readonly) await fs.chmod(path.join(destination, e.path), 0o555);
    }
  await syncDirectory(destination);
  if (readonly) await fs.chmod(destination, 0o555);
}
