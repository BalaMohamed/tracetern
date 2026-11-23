# TraceTern beta quickstart

Run this walkthrough on macOS or Linux with Git, a POSIX shell, and Node.js
24.12.0 or newer. Use Node 24.12.0 to match CI. This path runs TanStack Query
Core checks and needs no database, model, or assistant account. It builds
and executes trusted committed source in local child processes. Run only
revisions you trust.

| Workflow | Requirements beyond Git and Node |
| --- | --- |
| TanStack Query Core or Zustand | Locked builder for comparisons and verification. Replay uses saved bundles. |
| Orders | PostgreSQL server tools `initdb` and `pg_ctl` on `PATH`, and a non-root account |
| DataFusion | The [pinned Python environments](USAGE.md#compare-apache-datafusion-parquet-pushdown) |
| Ollama ranking | An [installed local model](USAGE.md#browse-and-use-local-ollama-models) |
| MCP | The optional [stdio adapter](USAGE.md#connect-a-coding-assistant) |

## Install and fetch the demo

Clone TraceTern from GitHub and run the commands from that checkout.
If you are testing a release, check out its tag before installing.

```sh
git clone https://github.com/BalaMohamed/tracetern.git
cd tracetern
npm ci
npm ci --prefix adapters/tanstack --ignore-scripts
npm run build

seed_base=816a0aab2e904cd5364d3b0f278582eccc660318
seed_head=aab2d96e3a90f8f7515400fe3a86f9da40eb7107
pr_base=f6689e04be493e2e83f9c93d7e478f92c3e5d328
pr_head=944e939d002527cbacdc2bd3231fab90a5e7e4d3
target="$PWD/.tracetern/beta-upstream"
git init "$target"
git -C "$target" fetch --no-tags --depth=1 https://github.com/TanStack/query.git \
  "$seed_base" "$seed_head" "$pr_base" "$pr_head"
```

## Seed, select, and inspect

Seed the experiment with the known repair in PR #12633. Then let TraceTern
select an experiment for PR #12642 using the saved passing assertions.

```sh
node dist/src/cli.js plan-library "$target" "$seed_base" "$seed_head"

status=0
node dist/src/cli.js run-suggested "$target" "$pr_base" "$pr_head" --json \
  > .tracetern/beta-comparison.json || status=$?
test "$status" -eq 2
cat .tracetern/beta-comparison.json
run_id=$(node -p 'require("./.tracetern/beta-comparison.json").runId')
node dist/src/viewer.js "$run_id"
```

Open the loopback URL printed by the viewer. The selected experiment is
`optimistic-query-count`. The one-query control stays at one result on
both sides. Each side drops from two results to one after the list expands.
This is a shared failure, so the comparison is inconclusive with exit code
2. Stop the viewer with Ctrl+C to return to the shell. [Run evidence and PR context](EVALUATION.md#saved-observer-replay-on-tanstack-query-pr-12642)

## Replay and verify a follow-up

Replay by ID. Expect exit code 2 and `"reproduced": true`.

```sh
node dist/src/cli.js replay "$run_id" --json
```

Create a separate local fixture checkout for the follow-up. Apply the
observer fix from PR #12633 to the PR #12642 head, then pass the committed
revision to the verifier.

```sh
follow_up=$(mktemp -d "$PWD/.tracetern/beta-follow-up.XXXXXX")
git init "$follow_up"
git -C "$follow_up" fetch --no-tags --depth=1 "$target" "$pr_head"
git -C "$follow_up" switch --detach FETCH_HEAD
git -C "$target" diff "$seed_base" "$seed_head" -- packages/query-core/src/queriesObserver.ts |
  git -C "$follow_up" apply --index
git -C "$follow_up" -c user.name='TraceTern Fixture' -c user.email=fixture@example.invalid \
  -c commit.gpgSign=false commit -m 'Preserve the expanded optimistic result count'
patch=$(git -C "$follow_up" rev-parse HEAD)
node dist/src/cli.js verify-library "$run_id" "$follow_up" "$patch" --json
```

A successful verification exits 0. It links to the original run, reproduces
its baseline observations, and shows the follow-up maintaining two results.
You can open or replay the verification using its own run ID.

Maintainers can run the command-line walkthrough with
`bash scripts/check-beta-quickstart.sh` after building. It uses a fresh
evidence store each time. In GitHub Actions, run **TraceTern checks** on
`main` with **Fetch public revisions and verify the beta quickstart**
enabled to exercise the same path on Linux and macOS.

## Local data and feedback

The ignored `.tracetern/runs.sqlite` contains observations, source bundles,
and revision identities. The viewer binds to loopback and displays the
evidence. A configured MCP host can read the same evidence and optionally
request executions. An assistant host may send its input to a provider.
TraceTern itself adds no automatic telemetry.

For public feedback, report your TraceTern commit, platform, Node version,
the expected and observed result, and public revisions when applicable.
Replace local paths and omit credentials, private code, and the SQLite
database. [TraceTern issue form](https://github.com/BalaMohamed/tracetern/issues/new?template=beta-feedback.yml)
