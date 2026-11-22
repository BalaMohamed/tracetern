# TraceTern

TraceTern investigates whether a software optimization preserves behavior. Its first local experiment compares three implementations of an orders API against a reference using a real PostgreSQL database.

## Run the orders investigation

Use Node.js 24.12 or newer, npm and PostgreSQL server tools (`initdb` and `pg_ctl` on PATH) on macOS or Linux as a non-root user.

```sh
npm ci
npm test
npm run demo -- cache
npm run demo -- batch
npm run demo -- n-plus-one
```

A cache run exits 1 when it reproduces the stale-name regression. A batch run exits 0 for matching all ordered responses. The n-plus-one implementation also preserves the responses, but makes 101 PostgreSQL client calls per request. Exit 2 means the comparison could not be completed or its reference failed. Timing and production speedups are outside this fixture.

For a JSON report, build once and run `bash scripts/with-postgres.sh node dist/src/cli.js cache --json`. The report goes to standard output. The script owns a temporary database cluster for the duration of the command. Each side of the comparison runs a fresh service process, preserving cache state across requests on that side only.

## Compare committed versions and replay a finding

Run from the root of a trusted Git repository that follows the orders fixture contract. After building TraceTern, try the passing self-comparison:

```sh
npm run demo -- compare HEAD HEAD
npm run demo -- record cache
npm run demo -- replay <run-id>
npm run demo -- verify <run-id> <candidate-commit>
```

Replace either `HEAD` with another committed revision containing `src/orders.ts` and the same `package-lock.json` as the runner. Each side's service must export the existing `ordersService` interface and be standalone after TypeScript type stripping. The fixed worker invokes the service with the same batch-mode input on both sides. Only the committed service module varies. Multi-file targets and changing dependencies need a future adapter.

The record command saves a bundled case using the committed orders service at HEAD in the selected fixture mode. Recording the stale cache returns exit 1 and still saves a run ID. Verify uses the saved baseline and experiment with a new committed candidate.

Compare resolves refs to commit and tree IDs, reads Git objects directly, and runs the two stripped modules in separate worker processes. It leaves the checkout untouched. A completed comparison prints a run ID. The ignored local `.tracetern/runs.sqlite` stores the exact service modules, their digests, the harness identity, and the result. Replay loads those saved bytes and writes a new run linked to the original. IDs are local to the repository where the investigation was recorded.

The worker measures calls to the supplied PostgreSQL client during each request. Headline totals sum the query groups, including Other for unrecognized statements. Fixture setup and the between-request rename are outside the measurement. The JSON field `reads` carries these totals with `callMetric: "postgres-client-calls"`. SQL text and bind values stay out of the report.

For new recordings, CLI and planner changes can alter the recorded harness identity while the saved experiment remains replayable. Replay and verification still require matching replay code, fixture, dependency lock, Node version, and the PostgreSQL version recorded by a completed run. Replay reports whether the saved behavior reproduced and whether the measured call counts matched. Older recordings remain readable and require their original runner build for replay.

## Compare TanStack Query without PostgreSQL

The library adapter exercises the public Query Core cache API. It checks that reordered object properties share a cache entry, reordered array elements keep distinct entries, and both revisions can hydrate the same serialized baseline cache. It reports the observed values for each check.

From TraceTern, install the adapter's locked build tools and fetch the two trusted revisions from [TanStack Query PR #11073](https://github.com/TanStack/query/pull/11073):

```sh
npm ci --prefix adapters/tanstack --ignore-scripts
git init .tracetern/tanstack-query
git -C .tracetern/tanstack-query fetch --no-tags --depth=1 https://github.com/TanStack/query.git \
  33fe7c476276cbefa86786bbcc2d445fdf382614 e34066220996e1150535108646b3f24109feece7
```

```sh
npm run tracetern -- compare-library .tracetern/tanstack-query \
  33fe7c476276cbefa86786bbcc2d445fdf382614 e34066220996e1150535108646b3f24109feece7
npm run tracetern -- replay <run-id>
npm run view -- <run-id>
```

TraceTern reads committed Query Core source from Git, bundles each side with its pinned build tool, and runs each bundle in its own Node process. The adapter supports the Query Core layout and dependency versions used by these revisions. It records both bundles, their digests, and the source lock digest for each revision. Replay uses the stored bundles and a compatible Node runtime and replay build. Initial comparison is the only step that needs the upstream Git objects and the adapter's build tools.

Run `npm run test:library` for the controlled failure and replay test. Set `TRACETERN_TANSTACK_REPO=.tracetern/tanstack-query` to include the pinned upstream pair. Both tests run without PostgreSQL.

Use `npm run tracetern -- plan-library <repository> <base> <candidate>` to choose a subset of the checks. The rule planner reads committed production hunks and checks them against the query-key and persistence guides at the base revision. It records a source hunk and a documentation line for each selection. The CLI prints those citations, and saved citations are available in the viewer and over MCP. Replay uses the stored selection and bundles. If the planner finds no supported case, it exits 2 with an empty plan and skips execution. See the [review trial](docs/EVALUATION.md).

## Run a Zustand vanilla store experiment

The Zustand adapter tests the [null state update fix](https://github.com/pmndrs/zustand/pull/2213), with controls for shallow merge and subscription notifications. Install the shared build tools with `npm ci --prefix adapters/tanstack --ignore-scripts`, then fetch the pinned Git objects:

```sh
git init .tracetern/zustand
git -C .tracetern/zustand fetch --no-tags --depth=1 https://github.com/pmndrs/zustand.git \
  f5561dfb05babb89773128d00fabda74ddd145d4 949b505a4b5414d5b249c413e9847bb0df559a42

npm run tracetern -- compare-library .tracetern/zustand \
  f5561dfb05babb89773128d00fabda74ddd145d4 949b505a4b5414d5b249c413e9847bb0df559a42 \
  --adapter zustand
npm run tracetern -- replay <run-id>
```

This adapter captures the standalone `src/vanilla.ts` and records the committed Yarn lock digest. It runs without installing Zustand dependencies. The browser and MCP expose its saved evidence through the same interfaces as the TanStack runs. Set `TRACETERN_ZUSTAND_REPO` to a local repository containing both commits to include it in the library or MCP tests.

## Compare Apache DataFusion Parquet pushdown

This release-level experiment reproduces [DataFusion #24109](https://github.com/apache/datafusion/issues/24109).
It creates the three-row Parquet file once per recording and gives the exact same bytes to both engines.
Each executes the adapted struct-field query, an unoptimized reference query, a matching-schema control and a scalar control.
A second execution of the adapted query reads the scan's `pushdown_rows_pruned` counter from `EXPLAIN ANALYZE VERBOSE`.

On macOS or Linux with uv, run the setup once from TraceTern. It installs two pinned Python 3.12 environments under the ignored `.tracetern/datafusion/venvs/` directory.
The experiment runs locally without PostgreSQL, Rust, an upstream checkout, or an LLM.

```sh
bash adapters/datafusion/setup.sh
npm run tracetern -- datafusion broken
npm run tracetern -- datafusion disabled
npm run tracetern -- datafusion fixed
npm run tracetern -- replay <run-id> --json
npm run test:datafusion
```

| Candidate | Returned IDs | Rows pruned in the scan | Exit |
| --- | --- | ---: | ---: |
| DataFusion 54.0.0, pushdown enabled | 1, 2, 3 | 0 | 1 |
| DataFusion 54.0.0, pushdown disabled | 2 | 0 | 1 |
| DataFusion 55.2.0, pushdown enabled | 2 | 2 | 0 |

The Python binding 55.0.0 embeds engine 55.2.0, which includes the [branch-55 backport of #24125](https://github.com/apache/datafusion/commit/045b590c4822fdbd2ce47eac2f7a5a55b28cde45).
The counter measures filtering within the scan. This fixture provides no wall-clock speedup estimate.
SQLite saves the Parquet bytes and digest, candidate mode, engine identities including native module digests, checks and harness digest.
Replay uses the saved bytes and requires the compatible local runtimes and harness. Missing evidence or an incompatible environment exits 2.
The browser and MCP can read these checks, and the execution-enabled MCP server can replay them.

## Choose an experiment

For changes to how query observers combine results, the planner can select an experiment that resolves a pending query while the requested query list grows. The report lists counts before and after resolution for a one-query control, followed by counts for the growing list. A passing control and a baseline-only failure can establish a repair. Set `TRACETERN_OBSERVER_REPO` to a local repository containing both revisions from PR #12633 to run the upstream observer test.

For changes to dehydration timestamps, the planner runs the clock fallback, client default, explicit override, and zero against two queries. When the candidate introduces the documented option, the check records the new contract separately from a change to existing behavior. Set `TRACETERN_TIMESTAMP_REPO` to a local repository containing both revisions from PR #11395 to run the upstream check and the controlled broken override.

The rule baseline selects a read–rename–read experiment for cache-like additions, or two reads otherwise. The local Ollama planner receives the orders requirements and bounded excerpts of added and removed lines. Both planners get one proposal with at most four operations on the same 100-customer fixture.

```sh
npm run demo -- plan HEAD~1 HEAD rule
npm run demo -- plan HEAD~1 HEAD ollama <installed-model:tag>
npm run demo -- replay <run-id>
```

Use an exact installed model tag from `ollama list` with Ollama listening at `127.0.0.1:11434`. The model may choose a customer and a sequence of reads and one rename. The runner validates that data before interacting with PostgreSQL. SQLite records the plan, planner version, model digest and result. Replay executes the accepted plan without querying Ollama. A provider error or invalid plan produces an inconclusive result with exit code 2.

The default tests run offline. Set `TRACETERN_TEST_MODEL` to an installed model tag when running `npm test` to also compare the two planners on a seeded cache change and replay the model's result. A single fixture measures integration; comparative model quality requires independent cases.

## Inspect a saved investigation

```sh
npm run demo -- record cache
npm run view -- <run-id>
```

Open the loopback URL printed by the viewer. Omit the run ID to open the most recent investigation. Select a read to compare request paths and grouped database calls. The evidence includes the first differing response field and the exact candidate commit and source path. Open **Replay and source** for the terminal commands. After making a fix, commit it and run `npm run demo -- verify <run-id> HEAD` to check the same experiment against it.

The viewer reads the local evidence store and needs no database server or model. It labels the original totals in older reports as reported reads.

## Connect a coding assistant

Build TraceTern and install the optional MCP adapter.

```sh
npm run build
npm ci --prefix integrations/mcp
```

Configure the host to launch `node integrations/mcp/server.mjs <absolute-repository-path>` over stdio. Use an absolute path to the server entry point if the host starts outside the TraceTern checkout. From the TraceTern root, use this command for Codex.

```sh
codex mcp add tracetern -- node "$PWD/integrations/mcp/server.mjs" "$PWD"
```

| Tool | Result |
| --- | --- |
| `list_runs` | Up to 25 recent runs in the configured repository |
| `get_run` | Saved Orders measurements or library checks, plus the candidate source reference |
| `replay_run` | A fresh result from the saved snapshots and plan |
| `verify_candidate` | An Orders result from running the saved baseline and plan against the full commit ID of a fix |

Include `--enable-execution` after the repository path to register the last two tools. Orders replays and verification launch a disposable PostgreSQL instance. Library replays launch Node workers directly. Each creates a separate run ID. The assistant receives the same evidence projection as the browser. It includes observed fixture values and Git references, while source snapshots, SQL text, and runner diagnostics stay in the local workflow.

Run `npm --prefix integrations/mcp test` after building to exercise the server through a real stdio client.

[Implementation plan](docs/PLAN.md) · [Architecture and milestone gates](docs/ARCHITECTURE.md)
