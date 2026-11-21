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

A cache run exits 1 when it reproduces the stale-name regression. A batch run exits 0 for matching all ordered responses. The n-plus-one implementation also preserves the responses, but makes 101 reads per request. Exit 2 means the comparison could not be completed or its reference failed. Timing and production speedups are outside this fixture.

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

Compare resolves refs to commit and tree IDs, reads Git objects directly, and runs the two stripped modules in separate worker processes. It leaves the checkout untouched. A completed comparison prints a run ID. The ignored local `.tracetern/runs.sqlite` stores the exact service modules, their digests, the harness identity, and the result. Replay loads those saved bytes and writes a new run linked to the original. A changed runner, dependency lock, Node version or PostgreSQL version can make the replay inconclusive. IDs are local to the repository where the investigation was recorded. New runs group PostgreSQL client calls by known fixture query shape, including an Other group for unrecognized statements. SQL text and bind values stay out of the report. Use `--json` for a machine-readable result.

## Choose an experiment

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

The viewer reads the local evidence store and needs no database server or model. Older reports remain inspectable with their original totals. Replay and verify require a runner build that matches the saved evidence.

[Implementation plan](docs/PLAN.md) · [Architecture and milestone gates](docs/ARCHITECTURE.md)
