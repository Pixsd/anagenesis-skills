"""Anagenesis shim around the vendored, unmodified Microsoft skillopt_sleep.

It never edits vendored files: it replaces a few upstream module attributes at
runtime so every write stays inside the Anagenesis store and no transcript
harvester or crontab command ever runs.
"""
