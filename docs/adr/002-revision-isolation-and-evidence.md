# ADR-002: Separate trusted revision workers and persist replay evidence

Status: proposed for Phase 0 review. Date: 2026-10-11.

Context: importing two service revisions in one interpreter risks module-cache contamination; shared databases confound differential observations. A repository without commits has no usable revision identity yet.

Decision: after implementation approval, establish a baseline commit and fixed reviewed mutation patch; record SHA, patch hash, and candidate tree hash. Use one bounded child worker per side with a fresh file-backed SQLite database and identical trusted fixture. Use an ASGI client without a network listener. Save versioned JSON run artifacts before adding relational evidence tables.

Alternatives: two permanent service copies drift; a bug flag blurs revision identity; containers add setup cost to this trusted demo; a same-process runner simplifies plumbing but complicates revision imports. Git worktrees can become useful once both targets are committed revisions.

Consequences: some worker lifecycle code is required. Source snapshots and dependency identity must be retained for replay. In-process HTTP does not test real network/deployment behavior. Worker processes provide no protection from hostile target code. General dependency-changing and untrusted revision execution are unsupported.
