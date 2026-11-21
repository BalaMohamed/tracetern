#!/usr/bin/env bash
# Own the cluster for exactly one command. Never attach to a developer database.
set -euo pipefail
# MCP hosts may launch with no locale. Use the fixture locale consistently.
export LC_ALL=C
if [[ $# -eq 0 ]]; then echo "Expected a command to run" >&2; exit 2; fi
for tool in initdb pg_ctl; do
  command -v "$tool" >/dev/null || { echo "Missing PostgreSQL server tool: $tool" >&2; exit 2; }
done
cluster=$(mktemp -d /tmp/tracetern.XXXXXXXX)
cleanup() {
  if [[ -f "$cluster/data/postmaster.pid" ]]; then
    pg_ctl -D "$cluster/data" -m immediate -w stop >/dev/null || return 1
  fi
  rm -r -- "$cluster"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
initdb -D "$cluster/data" -U tracetern -A trust --no-locale -E UTF8 >"$cluster/init.log" || { cat "$cluster/init.log" >&2; exit 2; }
pg_ctl -D "$cluster/data" -l "$cluster/server.log" -o "-c listen_addresses='' -k $cluster -p 5432" -w start >/dev/null || { cat "$cluster/server.log" >&2; exit 2; }
export TRACETERN_SOCKET="$cluster"
"$@"
