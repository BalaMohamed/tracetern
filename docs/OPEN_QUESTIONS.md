# Open questions and design review

Phase 0, 2026-10-11; governance updated 2026-10-12. Decisions below await user approval. Astra is exclusively the read-only technical teacher, not an architecture reviewer.

## Five biggest risks

| Risk | Why it matters | Recommended response and tradeoff |
| --- | --- | --- |
| Scope | Full service semantics, revision execution, retrieval, agents, and credible ML exceed a dependable two-to-three-week part-time commitment. | Approve only the one-endpoint slice first. Defer remaining business workflows and later phases; smaller initial coverage buys a trustworthy foundation. |
| Research validity | Comparing different candidate pools confounds generation quality with ranking. Hand-designed mutations can favor the authored heuristic/model prompts; a behavioral difference does not itself establish a bug. | Evaluate ordering over the same frozen pool first, then generation and adaptive selection separately. Freeze oracle rules and holdouts before tuning. Include nonrevealing/equivalent controls and never expose defect labels to the proposer. This restricts claims but makes them interpretable. |
| ML data sufficiency | Thousands of near-duplicate inputs over a handful of mutations are still only a handful of independent scenarios. Logistic regression can memorize them; family success rates can leak held-out labels. | Report independent groups and positive/negative coverage before training. Use grouped learning curves and out-of-group evaluation; derive historical rates within training folds only. Defer ML if support is inadequate. No universal row-count threshold or promised uplift. |
| Local generation reliability | Structured JSON can still be invalid, repetitive, irrelevant, or impossible to execute. Small-model performance and hardware latency have not been measured here. | Phase 2 pilot with bounded outputs, validation, explicit timeouts and limited retries. Count failed attempts and all generation time against reported cost. Preserve raw outputs and replay validated proposals. Exact model availability, memory use, and throughput remain unverified. |
| Overlap with existing work | API fuzzing, differential testing, and LLM feedback-guided generation already exist. A new name or local model does not establish novelty. | Position as a constrained experiment-selection study with deterministic requirement-backed evidence. Compare against simple baselines first and document limits; broaden related work before stronger claims. See charter sources. |

## Evaluation decisions to settle before benchmark work

- Separate three questions: proposal quality, ordering a common pool, and adaptive next-experiment selection. Frozen-pool ranking is an initial diagnostic, not proof of sequential-agent effectiveness.
- Primary scenario-level metric: detection@k = fraction of eligible defect scenarios with at least one confirmed exposure in the first k executions. Call this detection@k rather than ambiguously labeling it Recall@k. If reporting candidate-level recall, explicitly define its denominator as all revealing candidates in the frozen pool.
- Include scenarios with no revealing pool candidate in end-to-end coverage; optionally report conditional ranking performance separately. Do not silently exclude hard scenarios.
- Define one experiment as a bounded sequence executed on both revisions. For sequences of differing lengths, also report HTTP request counts and wall time, including inference/retries; experiment count alone can be gamed.
- Use paired comparisons on identical scenario pools and budgets; repeat random ordering with recorded seeds. Report undetected cases as censored at the budget, not as missing values in mean first-detection rank.
- Group near-duplicate mutation variants together. Scenario holdout tests new scenarios; family holdout tests new defect types. Choose the claimed generalization target first. Bootstrap independent scenario/family groups, not individual requests. With very few groups, show individual outcomes and avoid overconfident intervals.
- Freeze preprocessing, feature selection, hyperparameters, and train-derived statistics without final holdout access. Label all development results exploratory. PR-AUC and candidate precision are secondary only when the candidate classification question is meaningful.

## Proposed departures requiring review

1. **Reduced Phase 1 domain:** one creation endpoint and I5; defer cancellation, ownership, idempotency, and broader state transitions. This reconciles the eventual demo requirements with the requested smallest vertical slice.
2. **Revision provenance:** commit plus reviewed patch/source hash initially, rather than fabricating two commit SHAs or duplicating the application. General arbitrary-revision execution is deferred.
3. **Evidence storage:** JSON artifacts first; SQLite for service persistence. Relational evidence storage earns its place when querying many runs becomes necessary.
4. **Security scope:** approved local target code only. A child process is not a security sandbox; untrusted target execution materially changes scope.
5. **Agent framework:** revisit LangGraph at Phase 4; use it only if explicit state/resumption/control requirements justify the dependency.
6. **Model:** qwen3.5:9b through Ollama is the requested Phase 2 target, not a verified working installation. Verify local availability and resource fit then; seek review before a material model change.

## User approval and teaching relationship

The coding agent is the only agent authorized to modify this repository. Astra may explain concepts and raise questions in the teaching chat, but supplies no required architecture review or approval. Preserve any existing teaching/review notes as existing user work. Material changes to thesis, evaluation validity, security, model design, major dependencies, or scope require user approval. Phase 1 begins only after explicit user approval; publishing Phase 0 does not grant it.

Suggested Astra questions: Does the scoped I5 actually prove incorrect behavior? Which baseline failures force INCONCLUSIVE? How does resetting a database differ from isolating Python imports? Why do many test rows not constitute many independent defects? What can common-pool ranking establish about an adaptive system?
