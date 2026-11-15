# Third-party provenance

## Microsoft SkillOpt

`src/gate.ts` adapts the pure `GateResult`, `select_gate_score` and
`evaluate_gate` implementation from **Microsoft SkillOpt v0.2.0**, commit
[`e4ea6a6771e797ef820cdd8bfea64c57e0481065`](https://github.com/microsoft/SkillOpt/tree/e4ea6a6771e797ef820cdd8bfea64c57e0481065),
file [`skillopt_sleep/gate.py`](https://github.com/microsoft/SkillOpt/blob/e4ea6a6771e797ef820cdd8bfea64c57e0481065/skillopt_sleep/gate.py).

Copyright (c) 2026 Microsoft Corporation. Licensed under the MIT License.
The complete license is in [vendor/skillopt/LICENSE](vendor/skillopt/LICENSE).
The unchanged original is in [vendor/skillopt/gate.py](vendor/skillopt/gate.py).
Both are included in the npm tarball. No Sleep engine, orchestration, model
backend, scheduler or mining code is included.

The original hard/soft/mixed selection, weight clamp, strict comparison,
three actions and all six result fields are preserved. Anagenesis adds its
own finite-number and metric-schema validation wrapper. These extra restrictions
are not attributed to Microsoft.

`fixtures/gate-parity.json` records the original file SHA-256, pinned commit,
108 input/score/result fixtures, and the original unknown-metric error.
`scripts/generate-gate-fixtures.py` executes that original in development;
normal builds and tests consume the committed fixture and need no Python.

## SkillForge

Xingyan Liu et al., [SkillForge, arXiv:2604.08618v2](https://arxiv.org/html/2604.08618v2),
sections 2.4, 2.6–2.7 and appendix E, inform the domain-source grounding,
root-cause diagnosis and narrowly scoped evidence-driven revision workflow.
No SkillForge code is incorporated.

Input validation, artifact verification, provenance, regression checks,
versioning, locking and transaction recovery are Anagenesis components.
This package is not a Microsoft product and implies no endorsement by
Microsoft or the SkillForge authors.

## Package dependencies and project licensing

Runtime dependencies are `fs-ext` (MIT), `yaml` (ISC) and `zod` (MIT).
Their installed packages retain their own license notices. The project is
currently private and `UNLICENSED`; the repository owner must choose its
license and npm scope before public distribution. This does not modify the
license of the vendored Microsoft code.
