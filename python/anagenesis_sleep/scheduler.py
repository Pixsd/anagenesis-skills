"""Crontab I/O redirected to files in the store; the host installs the result."""
from __future__ import annotations

import os


def _env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} is required by the Anagenesis scheduler shim")
    return value


def read_crontab() -> str:
    path = os.environ.get("ANAGENESIS_CRONTAB_IN", "")
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return f.read()
    return ""


def write_crontab(content: str) -> bool:
    out = _env("ANAGENESIS_CRONTAB_OUT")
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, out)
    return True


def have_crontab() -> bool:
    return True


def runner_cmd(project: str, backend: str, extra: str, python: str) -> str:
    runner = _env("ANAGENESIS_RUNNER")
    if any(ord(c) < 32 or ord(c) == 127 for c in runner):
        raise ValueError("runner cannot contain control characters")
    return runner
