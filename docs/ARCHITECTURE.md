# TraceTern architecture

TraceTern asks whether an optimization preserves a documented behavior under a workload that could expose a regression. The first supported workflow is reviewing database access changes in a trusted local Node service. An observed difference becomes a defect only when a stated requirement rules it out.

## Components and boundaries

| Component | Responsibility | Delivery |
| --- | --- | --- |
| Node/TypeScript CLI | Select a known candidate, compare paired observations, emit a terminal summary or machine-readable report | First milestone |
| Replay worker | Start a fresh instance of the orders endpoint, seed independent session-local PostgreSQL tables, execute a fixed sequence, return observations | First milestone |
| Comparator | Verify the reference response, check ordered rows and current names, count application reads and group PostgreSQL calls made during each request | First milestone |
| Local investigation store | Save paired service snapshots, provenance and results atomically in SQLite; replay by run ID | Orders revision adapter |
| Experiment planner | Choose a bounded read/rename plan from fixture requirements and changed source lines; record the validated proposal and model identity | Rule baseline and local Ollama |
| Assistant integration | Read saved evidence and optionally replay a case or verify a committed fix over MCP stdio | Local adapter |
| Local browser viewer | Switch between observed reads, compare PostgreSQL query groups and inspect the first response difference or recorded source revision | Loopback viewer |

The CLI is the initial application process. Workers execute separately to prevent module and cache state leaking across implementations. The demo starts a disposable PostgreSQL cluster using a private Unix socket. The orders endpoint listens on an ephemeral loopback port for each worker. This execution model assumes trusted fixture code.

## A paired experiment

1. Choose a reference and candidate. The first milestone compares named fixture implementations shipped together. The orders adapter also accepts two Git refs, snapshots the standalone orders service at each commit and strips its types into an isolated executable module. Both use the installed harness and matching dependency lock.
2. Start each side from ordered fixture version 1: 100 orders referencing 100 distinct customers in reverse customer-ID order. Each worker owns one database session and one instance of the service.
3. Issue a cold GET /orders, repeat the GET, rename customer 1 to Avery, then issue the GET again. Preserve process and database state between these steps. The freshness requirement is that the next read sees the committed rename. The order contract is ascending order ID.
4. Check both sides against the fixture contract. A wrong reference or incomplete run makes the experiment inconclusive. A candidate response violating a requirement against a valid baseline yields a regression. A pass covers only the recorded workload. Compare SELECT counts independently of correctness; do not infer latency from counts.
5. Emit a versioned report with fixture and implementation identities, environment, expected/observed mismatches and measured reads. The fixed seed and implementation names make a rerun possible from the same checkout. A machine-readable report can be redirected to a caller-chosen file.

## From replay to AI

The first planner baseline is a rule: when a patch extends a value's lifetime across requests, change that value between reads. Retrieval should begin with changed symbols, test names, traces and requirement text. Introduce embeddings only if retrieval misses relevant evidence on held-out repositories.

The model receives that evidence plus a vocabulary of supported operations. It proposes a hypothesis and an ordered experiment. The runner validates operation types, referenced fixture records, bounds and budget before execution. Model output cannot supply shell commands, SQL, network locations or verdicts. Persist the accepted plan, requirement version, model digest and generation settings. Rerun the saved plan without calling the model.

For Git inputs, record both revision and tree identities, lockfile and build digests. Allocate distinct workers and database namespaces per side/run. Hold timing-sensitive dependencies fixed or return inconclusive. Scope cancellation, retry and cleanup to a single run. Write immutable artifacts before publishing their index entries. Record named query groups and the first differing fixture response; assistant handoffs must show which evidence leaves the local process.

## Interfaces and scaling

The browser and MCP adapter read the same SQLite projection by run ID. It includes the accepted plan, revision references, client call counts and first response difference. The browser serves a loopback HTTP endpoint. The MCP adapter uses stdio and a separate package lock, so its dependencies do not affect target revision compatibility.

The coding assistant writes the patch. TraceTern replays and compares it. The verification command resolves a new candidate commit while reusing the saved baseline and plan. Each execution launches the existing disposable PostgreSQL runner. The result links back to the original investigation.

Parallelize independent investigations within a worker budget. Keep a stateful experiment sequential and use equivalent database settings on both sides. Add repeated latency samples and resource accounting before making performance claims beyond query counts. Bound evidence size and retain failed experiments alongside passes.

## Milestones and release gates

- **Deterministic runner.** Demonstrate the stale cache and passing batch with measured reads, order-sensitive assertions, error handling and a repeatable local command.
- **Repository adapter and evidence.** Accept two trusted revisions and fixture setup, isolate builds, persist provenance and reproduce a finding by run ID.
- **Local planner.** Compare a model with simple rules under the same budget. Separate invalid plans, inconclusive runs and confirmed regressions.
- **Assistant and browser.** An agent submits a candidate, follows a finding back to source and reruns the same saved case. Both interfaces agree on every verdict.
- **Evaluation.** Hold out whole repositories. Measure valid counterexamples, false alarms, replay cost, memory and reviewer time against the same coding assistant without TraceTern.
