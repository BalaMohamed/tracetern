# FAULTLOOM — Local AI Regression Laboratory

Status: Phase 0 proposal, 2026-10-11; governance updated 2026-10-12. Implementation awaits explicit user approval. Astra is the read-only technical teacher.

## Thesis and target user

Faultloom is a local regression laboratory for a developer reviewing a Python service change. It proposes, prioritizes, and executes reproducible experiments against baseline and candidate revisions. The LLM proposes experiments; deterministic, documented rules determine their outcomes.

The research question is whether a small local model grounded in changes and behavioral documentation can expose seeded regressions with fewer experiments than random ordering or a simple deterministic heuristic, under a fixed budget. A negative result is useful. No superiority or global novelty is claimed.

The project also teaches disciplined Python engineering, relational modeling, structured generation, retrieval, experimental design, and leakage-aware evaluation. Each technology must earn its complexity.

## Constraints and non-goals

- Initially support only a trusted local Python/FastAPI/Pydantic/SQLAlchemy/SQLite demo.
- Prefer Python 3.12; use an isolated, reproducible dependency environment.
- Local inference reduces the need to send proprietary artifacts to an external inference API. It is not a security guarantee.
- Experiments are validated data, never model-generated executable code. No model-supplied SQL, shell, imports, or arbitrary URLs.
- Do not build a universal test framework, pentester, code-writing agent, frontend, cloud service, or multi-agent organization.
- No Ollama, RAG, LangGraph, or ML in Phase 1. No cloud provider without approval.
- The full wishlist is not a credible guaranteed deliverable in two to three non-intensive weeks. A sound deterministic core and measured local proposal pilot are the first deliverables; later milestones depend on evidence and available time.

## Success criteria and gates

1. Phase 1: one fixed experiment repeatedly exposes one seeded boundary defect, with independently reset state, deterministic oracle evidence, and replayable provenance. Negative controls must prevent false confirmation.
2. Phase 2: local structured proposals can be validated and executed. Report invalid outputs, failures, latency, and attempts; valid JSON alone is not successful experimental design.
3. Phase 3: retrieve documented behavior with traceable citations and a separately evaluated requirement-query set.
4. Phase 4: a bounded conditional loop stops on confirmation, budget exhaustion, or inadequate evidence. Adopt LangGraph only after an ADR explains its benefit over an ordinary loop.
5. Phases 5–6: construct independent defect scenarios, compare strategies fairly, and report uncertainty on held-out groups. Learned ranking is conditional on adequate data, not a required positive result.

Stop for user review after each milestone. Do not advance automatically. Astra provides technical teaching and has no architecture approval role.

## Distinctiveness and limits

The defensible emphasis is budgeted experiment selection for a small stateful service, with requirement-backed verdicts, replayable evidence, and honest evaluation. That combination is useful for a learning/portfolio project; its scientific contribution must be demonstrated. Local execution is a deployment choice, not proof of novelty.

Related-work checks on 2026-10-11 found substantial overlap:

- [RESTler](https://github.com/microsoft/restler-fuzzer) performs stateful REST API fuzzing; [Microsoft's differential regression testing discussion](https://www.microsoft.com/en-us/research/?p=613197) also overlaps with revision comparison.
- [Schemathesis](https://schemathesis.readthedocs.io/en/stable/) generates schema-based tests and stateful workflows. Faultloom should reuse standard API machinery rather than compete on generic input generation.
- [Mokav](https://arxiv.org/abs/2406.10375) uses iterative LLM execution feedback to generate inputs that expose differences between programs. An LLM feedback loop alone is not a distinctive contribution.

This is a targeted comparison, not an exhaustive literature review. Before a publication-style claim, expand the review to other relevant approaches and state precisely what is being compared.
