"""Entry point: ``python -m anagenesis_sleep ingest IN OUT`` or upstream args."""
from __future__ import annotations

import os
import sys


def install() -> None:
    import skillopt_sleep.__main__ as upstream_main
    import skillopt_sleep.cycle as cycle
    import skillopt_sleep.handoff_backend as handoff
    import skillopt_sleep.harvest_sources as harvest_sources
    import skillopt_sleep.scheduler as scheduler

    from anagenesis_sleep import backend, ingest
    from anagenesis_sleep import scheduler as ours

    def harvest(cfg, *args, **kwargs):
        return ingest.load_digests(os.environ.get("ANAGENESIS_DIGESTS", ""))

    replacements = [
        (upstream_main, "harvest_for_config", harvest),
        (cycle, "harvest_for_config", harvest),
        (harvest_sources, "harvest_for_config", harvest),
        (handoff, "HandoffBackend", backend.DistinctRolloutHandoff),
        (scheduler, "_have_crontab", ours.have_crontab),
        (scheduler, "_read_crontab", ours.read_crontab),
        (scheduler, "_write_crontab", ours.write_crontab),
        (scheduler, "_runner_cmd", ours.runner_cmd),
    ]
    for module, name, value in replacements:
        if not hasattr(module, name):
            raise SystemExit(
                f"anagenesis shim: {module.__name__}.{name} no longer exists; "
                "the vendored pin changed and the shim must be updated"
            )
        setattr(module, name, value)
    for module, name, value in replacements:
        if getattr(module, name) is not value:
            raise SystemExit(f"anagenesis shim: {module.__name__}.{name} not replaced")


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["ingest"]:
        if len(argv) != 3:
            print("usage: anagenesis_sleep ingest TRANSCRIPTS.json DIGESTS.json", file=sys.stderr)
            return 2
        from anagenesis_sleep.ingest import write_digests

        try:
            count = write_digests(argv[1], argv[2])
        except (ValueError, OSError) as exc:
            print(f"anagenesis shim: {exc}", file=sys.stderr)
            return 2
        print(count)
        return 0
    install()
    # The upstream CLI lists proposals before adopt's WAL recovery. Recover
    # first so a killed adoption can reach the unchanged adoption routine.
    if argv[:1] == ["adopt"] and "--staging" in argv:
        from skillopt_sleep.staging import _recover_before_manifest

        _recover_before_manifest(argv[argv.index("--staging") + 1])
    from skillopt_sleep.__main__ import main as upstream

    return upstream(argv)


if __name__ == "__main__":
    sys.exit(main())
