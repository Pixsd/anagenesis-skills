// Locating and running the Python interpreter used only by `sleep`.
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { fail } from "../errors.js";

export const PYTHON_REQUIREMENT = "python>=3.10";
export const MACOS_STUB = "/usr/bin/python3";
export const vendorRoot = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "vendor",
  "skillopt",
);
export const shimRoot = path.resolve(import.meta.dirname, "..", "..", "python");

export interface Python {
  path: string;
  version: [number, number];
}
export interface FindPythonOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Returns "major.minor" or null; injectable for tests. */
  probe?: (executable: string) => string | null;
  /** Whether Apple's Command Line Tools are installed (macOS only). */
  hasCommandLineTools?: () => boolean;
}

const names = [
  "python3.15",
  "python3.14",
  "python3.13",
  "python3.12",
  "python3.11",
  "python3.10",
  "python3",
];
function executable(p: string) {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function defaultProbe(p: string): string | null {
  try {
    return execFileSync(
      p,
      ["-S", "-B", "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
      { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000, stdio: "pipe" },
    )
      .toString()
      .trim();
  } catch {
    return null;
  }
}
function defaultCommandLineTools() {
  try {
    execFileSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** ANAGENESIS_PYTHON when set, otherwise the newest python3.x on PATH. On macOS
 * the /usr/bin/python3 stub is skipped without Command Line Tools, because
 * running it opens an installation dialog. */
export function findPython(options: FindPythonOptions = {}): Python {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? defaultProbe;
  const tools = options.hasCommandLineTools ?? defaultCommandLineTools;
  const explicit = env.ANAGENESIS_PYTHON;
  const candidates = explicit
    ? [explicit]
    : names.flatMap((n) =>
        (env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((d) => path.join(d, n)),
      );
  const tried: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    if (!executable(candidate)) continue;
    if (platform === "darwin" && candidate === MACOS_STUB && !tools()) continue;
    tried.push(candidate);
    const match = /^(\d+)\.(\d+)$/.exec(probe(candidate) ?? "");
    if (!match) continue;
    const version: [number, number] = [Number(match[1]), Number(match[2])];
    if (version[0] === 3 && version[1] >= 10)
      return { path: candidate, version };
  }
  return fail(
    "NOT_FOUND",
    "sleep requires Python 3.10 or newer; set ANAGENESIS_PYTHON or install python3",
    { requirement: PYTHON_REQUIREMENT, tried },
  );
}

/** Child environment built from scratch: nothing inherited except PATH. */
export function pythonEnv(o: {
  home: string;
  tmp: string;
  path?: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  return {
    PATH: o.path ?? process.env.PATH ?? "/usr/bin:/bin",
    HOME: o.home,
    TMPDIR: o.tmp,
    PYTHONPATH: [vendorRoot, shimRoot].join(path.delimiter),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    PYTHONHASHSEED: "0",
    LANG: "C.UTF-8",
    ...o.extra,
  };
}

export interface PythonResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
const children = new Set<number>();
let exitHook = false;
function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Runs `python -S -B -m <module> ...args` in its own process group, with a
 * controlled cwd so nothing in the caller's directory can shadow the stdlib.
 * The group is killed on timeout and when this process exits. */
export function runPython(
  python: Python,
  module: string,
  args: string[],
  o: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): Promise<PythonResult> {
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => children.forEach(killGroup));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(python.path, ["-S", "-B", "-m", module, ...args], {
      cwd: o.cwd,
      env: o.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [],
      err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    if (child.pid) children.add(child.pid);
    const timer = setTimeout(
      () => child.pid && killGroup(child.pid),
      o.timeoutMs ?? 600_000,
    );
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (child.pid) children.delete(child.pid);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}
