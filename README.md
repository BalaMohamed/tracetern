# TraceTern

[![TraceTern checks](https://github.com/BalaMohamed/tracetern/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/BalaMohamed/tracetern/actions/workflows/ci.yml)

TraceTern is a local CLI for checking whether a code change preserves an expected behavior. It matches a Git diff to checks that passed in a saved experiment, runs those checks against the base and candidate commits, and reuses the saved baseline to verify a follow-up.

**[Start with the quickstart](docs/QUICKSTART.md)** · [Usage reference](docs/USAGE.md) · [Releases](https://github.com/BalaMohamed/tracetern/releases)

## A shared failure and a verified repair

The quickstart uses TanStack Query PR #12642. TraceTern selected a saved query-observer experiment and measured the number of optimistic results before and after a query resolved.

| Revision | One-query control | Expanded list | Result |
| --- | --- | --- | --- |
| PR base | 1 → 1 | 2 → 1 | Existing failure |
| PR head | 1 → 1 | 2 → 1 | Same failure |
| Local follow-up | 1 → 1 | 2 → 2 | Repair verified |

The PR comparison returned **inconclusive** because the failure was already present in the base. The follow-up passed against the same baseline and expectations. Both results reproduced from their saved bundles. [Pinned revisions and commands](docs/EVALUATION.md#saved-observer-replay-on-tanstack-query-pr-12642)

## Supported workflows

| Target | What TraceTern checks |
| --- | --- |
| TanStack Query Core | Cache-key identity, cache restoration, observer counts, and dehydration timestamps |
| Zustand vanilla | Null updates, shallow merge, listener notification, and unsubscribe |
| Orders fixture | Response order and freshness, with PostgreSQL client calls recorded separately |
| DataFusion release fixture | Returned rows and scan pruning for a pinned Parquet pushdown case |

The library quickstart runs on macOS or Linux with Git and Node.js 24.12 or newer. TraceTern executes trusted target code in local processes. It saves revisions, bundles, and observations in a local SQLite database. Inspect a run in the loopback viewer or through the optional stdio MCP integration. [Command and adapter reference](docs/USAGE.md#replay-commands-and-results)

## Evaluation and development

- [Selection holdout](evaluation/ranking/README.md#beta-selection-holdout) — Recorded coverage found one direct match, missed five related controls, and made no irrelevant first picks on 12 PRs. The direct match was outside the supported adapters.
- [Paired review trial](evaluation/review/README.md#results) — On six PRs, the assistant-only arm found one independently confirmed regression. The assisted arm found none. The trial did not establish an improvement in review quality.
- [Architecture](docs/ARCHITECTURE.md) · [Roadmap](docs/PLAN.md) · [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/BalaMohamed/tracetern/issues/new?template=beta-feedback.yml)

Run `npm test` with PostgreSQL server tools on `PATH` for the core suite. See the [usage reference](docs/USAGE.md) for adapter and MCP tests.
