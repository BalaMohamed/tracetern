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

[Architecture and milestone gates](docs/ARCHITECTURE.md)
