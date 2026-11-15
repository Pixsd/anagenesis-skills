# Third-party provenance

## Microsoft SkillOpt

Copyright (c) 2026 Microsoft Corporation. Licensed under the MIT License.
The complete license is in [vendor/skillopt/LICENSE](vendor/skillopt/LICENSE)
and ships in the npm tarball.

### Gate

`src/gate.ts` adapts the pure `GateResult`, `select_gate_score` and
`evaluate_gate` implementation from **Microsoft SkillOpt**, file
[`skillopt_sleep/gate.py`](https://github.com/microsoft/SkillOpt/blob/e4ea6a6771e797ef820cdd8bfea64c57e0481065/skillopt_sleep/gate.py),
commit [`e4ea6a6771e797ef820cdd8bfea64c57e0481065`](https://github.com/microsoft/SkillOpt/tree/e4ea6a6771e797ef820cdd8bfea64c57e0481065)
(v0.2.0). The file is byte-identical at commit
[`45f65ca04f5f6713bca7b9797b495696ba812751`](https://github.com/microsoft/SkillOpt/tree/45f65ca04f5f6713bca7b9797b495696ba812751).
The unchanged original is in [vendor/skillopt/skillopt_sleep/gate.py](vendor/skillopt/skillopt_sleep/gate.py).

The original hard/soft/mixed selection, weight clamp, strict comparison,
three actions and all six result fields are preserved. Anagenesis adds its
own finite-number and metric-schema validation wrapper. These extra
restrictions are not attributed to Microsoft.

`fixtures/gate-parity.json` records the original file SHA-256, pinned commit,
108 input/score/result fixtures, and the original unknown-metric error.
`scripts/generate-gate-fixtures.py` executes that original in development;
normal builds and tests consume the committed fixture.

### Sleep

The `anagenesis sleep` command runs the complete, unchanged
`skillopt_sleep` package from commit `45f65ca04f5f6713bca7b9797b495696ba812751`,
vendored under `vendor/skillopt/` with a per-file SHA-256 manifest, through
its handoff backend. Anagenesis replaces only model backends (with handoff)
and per-CLI transcript harvesters (with a generic JSON transcript format).
A separate shim in `python/anagenesis_sleep/` redirects writes into the store,
supplies redacted digests, gives distinct prompt ids to dream rollouts and
returns crontab content instead of installing it; it does not modify the
vendored files. Adoption, scheduling and evalkit execute upstream Python too;
the shim runs upstream adoption recovery before the CLI preflight to resume
interrupted transactions. Upstream prompts are used verbatim from the vendored code.

## SkillForge

Xingyan Liu et al., [SkillForge, arXiv:2604.08618v2](https://arxiv.org/html/2604.08618v2),
sections 2.4, 2.6–2.7 and appendices A, C and E, describe the Failure Analyzer,
Skill Diagnostician, Skill Optimizer and staged Creator that Anagenesis
reimplements. The authors published no code, and the paper is distributed
under the arXiv perpetual non-exclusive license, so no SkillForge code or text
(including the judge prompt) is copied; wording and implementation are ours.

## Anagenesis components

Input validation, artifact verification, provenance, regression checks,
versioning, locking, transaction recovery, the Sleep wrapper and shim, and
the SkillForge reimplementation are Anagenesis components. This package is
not a Microsoft product and implies no endorsement by Microsoft or the
SkillForge authors.

## Package dependencies and project licensing

Runtime dependencies are `fs-ext` (MIT), `yaml` (ISC) and `zod` (MIT).
Their installed packages retain their own license notices. Anagenesis Skills
is licensed under the MIT License ([LICENSE](LICENSE)). This does not modify
the license of the vendored Microsoft code.
