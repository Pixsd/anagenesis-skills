"""Generic JSON transcripts -> redacted upstream SessionDigest dictionaries."""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List

from skillopt_sleep.staging import redact_secrets
from skillopt_sleep.types import SessionDigest

# Anagenesis Transcript field -> upstream SessionDigest field.
FIELDS = {
    "sessionId": "session_id",
    "project": "project",
    "gitBranch": "git_branch",
    "startedAt": "started_at",
    "endedAt": "ended_at",
    "userPrompts": "user_prompts",
    "assistantFinals": "assistant_finals",
    "toolsUsed": "tools_used",
    "skillsUsed": "skills_used",
    "filesTouched": "files_touched",
    "feedbackSignals": "feedback_signals",
}
LISTS = {
    "userPrompts",
    "assistantFinals",
    "toolsUsed",
    "skillsUsed",
    "filesTouched",
    "feedbackSignals",
}
STRINGS = set(FIELDS) - LISTS


def to_digest(t: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(t, dict):
        raise ValueError("transcript must be an object")
    unknown = set(t) - set(FIELDS)
    if unknown:
        raise ValueError(f"unknown transcript fields: {sorted(unknown)}")
    for key in ("sessionId", "project"):
        if not isinstance(t.get(key), str) or not t[key]:
            raise ValueError(f"{key} must be a non-empty string")
    for key in STRINGS & set(t):
        if not isinstance(t[key], str):
            raise ValueError(f"{key} must be a string")
    for key in LISTS & set(t):
        if not isinstance(t[key], list) or not all(isinstance(v, str) for v in t[key]):
            raise ValueError(f"{key} must be a list of strings")
    d = SessionDigest(**{FIELDS[k]: v for k, v in t.items()})
    d.n_user_turns = len(d.user_prompts)
    d.n_assistant_turns = len(d.assistant_finals)
    return redact_secrets(d.to_dict())


def build_digests(transcripts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not isinstance(transcripts, list):
        raise ValueError("transcripts must be a list")
    ids = [t.get("sessionId") for t in transcripts if isinstance(t, dict)]
    if len(set(ids)) != len(ids):
        raise ValueError("sessionId values must be unique")
    return [to_digest(t) for t in transcripts]


def write_digests(transcripts_path: str, out_path: str) -> int:
    with open(transcripts_path, encoding="utf-8") as f:
        digests = build_digests(json.load(f))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(digests, f, ensure_ascii=False, indent=2)
    os.replace(tmp, out_path)
    return len(digests)


def load_digests(path: str) -> List[SessionDigest]:
    """Replacement for upstream harvesters: read the pinned digests only."""
    if not path or not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    known = set(SessionDigest.__dataclass_fields__)
    return [SessionDigest(**{k: v for k, v in d.items() if k in known}) for d in raw]
