"""Development only. Execute the pinned, unmodified Microsoft original."""
import dataclasses
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True

root = Path(__file__).resolve().parents[1]
original = root / 'vendor/skillopt/skillopt_sleep/gate.py'
spec = importlib.util.spec_from_file_location('pinned_gate', original)
gate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)
rows = []
for metric in ['hard', 'soft', 'mixed']:
    for weight in [-1.0, 0.0, 0.25, 0.5, 1.0, 2.0]:
        for hard, soft, current, best in [(0.5, 0.5, 0.5, 0.8), (0.2, 0.3, 0.5, 0.8), (0.9, 0.95, 0.5, 0.8), (0.7, 0.7, 0.5, 0.8), (0.8, 0.8, 0.5, 0.8), (0.0, 1.0, 0.2, 0.6)]:
            args = dict(candidate_skill='candidate', cand_hard=hard, cand_soft=soft, current_skill='current', current_score=current, best_skill='best', best_score=best, best_step=7, global_step=12, metric=metric, mixed_weight=weight)
            rows.append(dict(input=args, score=gate.select_gate_score(hard, soft, metric, weight), result=dataclasses.asdict(gate.evaluate_gate(**args))))
try:
    gate.select_gate_score(0.5, 0.5, 'unknown')
except ValueError as error:
    unknown = dict(metric='unknown', errorType=type(error).__name__, message=str(error))
output = dict(source='microsoft/SkillOpt', commit='45f65ca04f5f6713bca7b9797b495696ba812751', sourceSha256=hashlib.sha256(original.read_bytes()).hexdigest(), rows=rows, unknownMetric=unknown)
(root / 'fixtures/gate-parity.json').write_text(json.dumps(output, indent=2) + '\n')
print(f'Generated {len(rows)} parity cases from pinned original')
