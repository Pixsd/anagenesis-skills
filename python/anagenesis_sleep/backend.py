"""Distinct handoff prompts per dream rollout (documented Anagenesis deviation).

Upstream ``HandoffBackend`` keys answers by the prompt hash, so rollouts with
``sample_id > 0`` collapse onto one answer. This subclass appends a rollout
index line to those prompts only; ``sample_id == 0`` keeps upstream ids.
Tool-using attempts (``attempt_with_tools``) carry no sample id upstream and
keep upstream behaviour.
"""
from __future__ import annotations

import threading

from skillopt_sleep.handoff_backend import HandoffBackend as UpstreamHandoff

_local = threading.local()


class DistinctRolloutHandoff(UpstreamHandoff):
    def attempt(self, task, skill, memory, sample_id=0):
        _local.sample_id = sample_id
        try:
            return super().attempt(task, skill, memory, sample_id=sample_id)
        finally:
            _local.sample_id = 0

    def _call(self, prompt, *, max_tokens=1024):
        sample_id = getattr(_local, "sample_id", 0)
        if sample_id:
            prompt = f"{prompt}\n\n(Independent rollout #{sample_id}.)"
        return super()._call(prompt, max_tokens=max_tokens)
