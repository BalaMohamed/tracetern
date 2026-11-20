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
npm run demo -- replay <run-id>
```

Replace either `HEAD` with another committed revision containing `src/orders.ts` and the same `package-lock.json` as the runner. Each side's service must export the existing `ordersService` interface and be standalone after TypeScript type stripping. The fixed worker invokes the service with the same batch-mode input on both sides. Only the committed service module varies. Multi-file targets and changing dependencies need a future adapter.

Compare resolves refs to commit and tree IDs, reads Git objects directly, and runs the two stripped modules in separate worker processes. It leaves the checkout untouched. A completed comparison prints a run ID. The ignored local `.tracetern/runs.sqlite` stores the exact service modules, their digests, the harness identity, and the result. Replay loads those saved bytes and writes a new run linked to the original. A changed runner, dependency lock, Node version or PostgreSQL version can make the replay inconclusive. IDs are local to the repository where the investigation was recorded. Use `--json` for a machine-readable result.

[Implementation plan](docs/PLAN.md) · [Architecture and milestone gates](docs/ARCHITECTURE.md)
