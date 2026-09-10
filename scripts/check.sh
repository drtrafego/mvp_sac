#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 -m unittest discover -s tests -v
python3 -m unittest discover -s backend -p 'test*.py' -v
python3 validate_migration.py
python3 -m compileall -q adapters.py healthcheck.py multicanal backend
