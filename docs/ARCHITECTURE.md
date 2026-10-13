# Architecture

## Current state

Only Phase 0 documentation exists. There is no application, runner, dependency manifest, model integration, or executable benchmark. Everything below is proposed for review.

## Smallest Phase 1 vertical slice

Use one endpoint, `POST /reservations`, one inventory row initially containing 12 seats, and SQLite reservation persistence. The request has `party_size` and an optional `dietary_note`, defaulting to null. Defer cancellation, ownership, idempotency, and other stateful workflows until later approved increments.

Document one scoped invariant, I5: **given available inventory and otherwise valid input, every integer party size from 1 through 6 inclusive is accepted with HTTP 201**. Omitting the dietary note is valid fixture context; optional-field compatibility is not yet a separately evaluated oracle.

Baseline allows party size 6. A reviewed patch changes only the upper bound from 6 to 5. The hand-authored fault-revealing experiment sends `{"party_size": 6}` with the note omitted. Expected evidence is baseline 201 versus candidate 422. The invariant, not the mere difference, justifies confirmation.

## Proposed data flow and boundaries

Trusted baseline snapshot + fixed benchmark patch → two revision snapshots → fresh SQLite database per side and experiment → same validated request → raw response and state summaries → one deterministic I5 oracle → evidence artifact and verdict.

Minimal responsibilities, created only during implementation:

- `examples/reservation_service/`: application factory accepting an explicit database location; models and endpoint; no shared mutable app/database singleton.
- `benchmark/`: reviewed mutation patch and metadata identifying family, affected invariant, baseline, and revealing input characteristics. Ground-truth metadata stays outside proposer/ranker context later.
- `src/faultloom/experiments.py`: strict Pydantic data schema and semantic allowlist validation.
- `src/faultloom/execution.py`: trusted worker orchestration, isolated state, fixed requests, response capture, and timeout/error handling.
- `src/faultloom/oracles.py`: pure I5 evaluation from supplied observations and documented fixture preconditions.
- `src/faultloom/reporting.py`: versioned JSON evidence persistence and small human-readable summary.
- `tests/`: service contract, runner repeatability/reset, validation rejection, and oracle negative controls.

These are proposed responsibilities, not a commitment to create empty packages or a framework.

## Experiment contract

Phase 1 needs a version, ID, target enum (`reservation_service`), hypothesis, rationale, evidence references, trusted fixture ID, one request step, oracle ID, experiment family, and estimated cost. Evidence references identify the invariant source and hash. No generic setup language or capture-expression language yet.

The request is fixed to method POST and literal path `/reservations`; its typed body contains a bounded integer and optional bounded note. Reject unknown fields, URL/path variants, unsupported fixture/oracle IDs, and excess steps before execution. Later phases can widen the schema deliberately. The executor owns transport and setup; proposal fields cannot select modules, database paths, revision paths, or arbitrary headers.

## Revision and execution design

Prefer a baseline Git commit plus one reviewed mutation patch over permanent duplicate applications or a production bug switch. Record baseline commit SHA, patch SHA-256, and candidate source-tree hash; do not invent a candidate Git SHA when the candidate is a derived snapshot. If an actual candidate commit exists, record that SHA too. Exact source and environment identity matter more than a misleading field name.

Run each side in a separate child process using a fixed trusted worker entry point and an in-process ASGI client. This avoids importing both revisions under the same Python module name and avoids opening a listening HTTP port. The parent imposes a wall-clock deadline, terminates and reaps timed-out workers, and retains explicit failure evidence. Each worker gets its own temporary file-backed SQLite database and the identical trusted fixture. A matching initial logical state hash verifies equivalence. Dependency versions are shared and locked; dependency-changing patches are initially unsupported.

This is process isolation for reproducibility, **not a sandbox for hostile application code**. Only the reviewed local demo is executable. Model text and retrieved documents have no execution authority. Testing arbitrary untrusted repositories requires a separate threat model and stronger isolation.

## Oracle and verdict policy

One initial oracle, I5, has PASS, FAIL, and UNKNOWN outcomes per side. It checks HTTP 201 only when the request and available-inventory preconditions hold. An invalid request is outside this invariant's domain, not an automatic violation.

| Evidence | Verdict |
| --- | --- |
| Equivalent state, baseline PASS, candidate FAIL | CONFIRMED_REGRESSION |
| Adequate comparable evidence differs, without proven candidate-only violation | BEHAVIOR_CHANGE_NEEDS_REVIEW |
| Adequate equivalent evidence, relevant checks pass, no selected difference | NO_REGRESSION_DETECTED |
| Worker failure, timeout, missing evidence, baseline violation, or unmet/unknown required precondition | INCONCLUSIVE |

Infrastructure failure is not a regression. A captured API rejection with established preconditions can be one. Preserve raw responses; compare only declared fields and status, never normalize away the defect. A no-detection verdict is scoped to the executed experiment, not a safety claim.

## Evidence and acceptance

Persist a versioned JSON artifact atomically per run: experiment; request; baseline and candidate identities; patch and source hashes; invariant source/hash; fixture and initial-state hashes; dependency lock hash and Python version; seed; model/prompt fields explicitly null for hand-authored proposals; retrieval evidence empty; raw responses; database summaries; timings; per-side oracle result and reason; verdict; UTC timestamp. Keep database summaries diagnostic for Phase 1 rather than silently adding another oracle. Persistence failures must fail the run visibly.

Acceptance checks: party size 6 confirms the defect; size 5 yields no detection; baseline-versus-baseline yields no detection; out-of-domain input cannot confirm I5; unexplained differences require review; baseline failure or worker timeout is inconclusive. Repeated runs after state mutation must retain equivalent initial state and the same semantic verdict; timestamps and durations need not match.

## Deferred architecture

After review: a local reasoning protocol, structured Ollama proposals, then retrieval with source hashes/line ranges, then bounded selection. Retrieval supplies undocumented-in-diff behavioral context; deterministic tooling identifies changed operations. Start lexical retrieval before adding embedding fusion and measure its incremental value. LangGraph and learned ranking remain gated. SQLite evidence tables can replace JSON when cross-run analysis needs them; create no speculative schema now.
