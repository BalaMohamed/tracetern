#!/usr/bin/env bash
set -euo pipefail
# Run from the TraceTern root after installing both lockfiles and building.
root="$PWD"
test -f "$root/dist/src/cli.js"
mkdir -p "$root/.tracetern"
directory=$(mktemp -d "$root/.tracetern/beta-smoke.XXXXXX")
target="$directory/upstream"
follow_up="$directory/follow-up"
seed_base=816a0aab2e904cd5364d3b0f278582eccc660318
seed_head=aab2d96e3a90f8f7515400fe3a86f9da40eb7107
pr_base=f6689e04be493e2e83f9c93d7e478f92c3e5d328
pr_head=944e939d002527cbacdc2bd3231fab90a5e7e4d3

git init -q "$target"
git -C "$target" fetch --quiet --no-tags --depth=1 \
  "${TRACETERN_BETA_UPSTREAM:-https://github.com/TanStack/query.git}" "$seed_base" "$seed_head" "$pr_base" "$pr_head"

cd "$directory"
run() {
  node "$root/dist/src/cli.js" "$@" --json
}
run plan-library "$target" "$seed_base" "$seed_head" > seed.json
status=0
run run-suggested "$target" "$pr_base" "$pr_head" > comparison.json || status=$?
test "$status" -eq 2
run_id=$(node -p 'require("./comparison.json").runId')

status=0
run replay "$run_id" > replay.json || status=$?
test "$status" -eq 2

git init -q "$follow_up"
git -C "$follow_up" fetch --quiet --no-tags --depth=1 "$target" "$pr_head"
git -C "$follow_up" switch --quiet --detach FETCH_HEAD
git -C "$target" diff "$seed_base" "$seed_head" -- packages/query-core/src/queriesObserver.ts |
  git -C "$follow_up" apply --index
git -C "$follow_up" -c user.name='TraceTern Fixture' -c user.email=fixture@example.invalid \
  -c commit.gpgSign=false commit --quiet -m 'Preserve the expanded optimistic result count'
patch=$(git -C "$follow_up" rev-parse HEAD)
run verify-library "$run_id" "$follow_up" "$patch" > verification.json

node --input-type=commonjs <<'JS'
const assert = require('node:assert/strict');
const seed = require('./seed.json');
const comparison = require('./comparison.json');
const replay = require('./replay.json');
const fix = require('./verification.json');
assert.equal(comparison.selection.exampleRunId, seed.runId);
assert.equal(comparison.reasonCode, 'shared-failure');
assert.deepEqual(comparison.plan, ['optimistic-query-count']);
assert.deepEqual(comparison.checks[0].reference, ['1', '1', '2', '1']);
assert.deepEqual(comparison.checks[0].candidate, comparison.checks[0].reference);
assert.equal(replay.reproduced, true);
assert.deepEqual(replay.checks, comparison.checks);
assert.equal(fix.verificationOf, comparison.runId);
assert.equal(fix.verdict, 'pass');
assert.deepEqual(fix.checks[0].reference, comparison.checks[0].reference);
assert.deepEqual(fix.checks[0].candidate, ['1', '1', '2', '2']);
JS
printf 'Beta quickstart passed. Reports are in %s\n' "$directory"
