#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then PY=python3; else PY=python; fi
exec "$PY" run_tests.py "$@"
