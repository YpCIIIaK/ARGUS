#!/bin/sh
set -eu

export SEARXNG_PORT=8081
/usr/local/searxng/entrypoint.sh &
searx_pid=$!

cleanup() {
  kill "$searx_pid" 2>/dev/null || true
  wait "$searx_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

/usr/local/searxng/.venv/bin/python /opt/argus-search/proxy.py
