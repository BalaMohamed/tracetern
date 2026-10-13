# ADR-004: Gate retrieval, orchestration, and learned ranking on evidence

Status: proposed future direction. Date: 2026-10-11.

Context: the conceptual pipeline risks becoming a collection of technologies before the scientific comparison is defined.

Decision: Phase 1 has none of these components. Later, evaluate lexical requirement retrieval before adding local embeddings/fusion. Reassess LangGraph only when conditional multi-step execution needs explicit workflow state. Compare random and deterministic heuristic ordering on common pools before training logistic regression with grouped validation. Gradient boosting requires additional justification.

Alternatives: build the entire architecture at once; treat the number of experiment rows as sufficient ML sample size; evaluate each ranker on a different generated pool. These impede debugging or confound the comparison.

Consequences: some planned technologies may never be justified. A negative result or insufficient-data finding is acceptable. Common-pool ranking isolates selection but does not alone answer the adaptive sequential-design question; that requires a later end-to-end evaluation.
