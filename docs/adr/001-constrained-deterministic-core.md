# ADR-001: Constrain the first slice to a deterministic FastAPI target

Status: proposed for Phase 0 review. Date: 2026-10-11.

Context: multi-language support and six business invariants would obscure whether revision execution and evidence are correct.

Decision: one trusted Python 3.12 FastAPI/Pydantic/SQLAlchemy/SQLite reservation creation endpoint, one seeded upper-bound defect, one hand-authored experiment, one documented invariant, and deterministic verdicts. The LLM never judges pass/fail. Baseline success is necessary but is not the specification; a documented rule supplies correctness.

Alternatives: build the full demo immediately; classify every response difference as a regression; use an LLM judge. These expand scope or weaken evidential validity.

Consequences: small initial behavior coverage and no inference claims. Confirmation requires a candidate-only invariant violation with adequate equivalent-state evidence. Generalization beyond this stack is untested.
