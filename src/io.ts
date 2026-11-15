import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import fsExt from "fs-ext";
import { fail } from "./errors.js";
export const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      fail("INVALID_INPUT", "Non-finite JSON number");
    const result = JSON.stringify(value);
    if (result === undefined) fail("INVALID_INPUT", "Not JSON");
    return result;
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonical((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
export const digestJson = (value: unknown) => sha256(canonical(value));
export async function exists(p: string) {
  try {
    await fs.lstat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export async function syncDirectory(p: string) {
  const fd = await fs.open(p, constants.O_RDONLY);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
export async function atomicWrite(p: string, data: string | Buffer) {
  const tmp = p + "." + randomUUID() + ".tmp";
  const fd = await fs.open(tmp, "wx", 0o600);
  try {
    await fd.writeFile(data);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await fs.rename(tmp, p);
  await syncDirectory(path.dirname(p));
}
export const writeJson = (p: string, data: unknown) =>
  atomicWrite(p, canonical(data) + "\n");
export async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}
export async function withLock<T>(
  p: string,
  work: () => Promise<T>,
): Promise<T> {
  const fd = await fs.open(
    p,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      fsExt.flockSync(fd.fd, "exnb");
    } catch (e) {
      if (
        ["EAGAIN", "EWOULDBLOCK"].includes(
          (e as NodeJS.ErrnoException).code ?? "",
        )
      )
        fail("STORE_BUSY", "Another operation holds this lock");
      throw e;
    }
    return await work();
  } finally {
    await fd.close();
  } // close releases the kernel lock, including after process death
}
export function within(root: string, child: string) {
  const r = path.relative(root, child);
  return (
    r === "" ||
    (!r.startsWith(".." + path.sep) && r !== ".." && !path.isAbsolute(r))
  );
}
