# TanStack Query review trial

The first trial used [TanStack Query PR #12633](https://github.com/TanStack/query/pull/12633). After freezing the planner, I selected the newest non-draft open PR on the first GitHub API page with a query/cache-key, hash, or hydration term in its title. I excluded the known development PR #11073. The pinned merge base is `816a0aab2e904cd5364d3b0f278582eccc660318` and the candidate is `aab2d96e3a90f8f7515400fe3a86f9da40eb7107`. Review comments and later outcomes were withheld.

## Review protocol

1. Give each Cursor session independent copies of the same pinned base tree, candidate tree, and Git diff. Only the assisted workspace gets TraceTern's JSON result. Give both sessions the same model, prompt, and time budget.
2. Ask for candidate-introduced behavior regressions, each with supporting code or documentation, expected and actual behavior, and reproduction status. Keep suggestions and untested hypotheses out of the confirmed count.
3. Count a confirmed finding only when independent evidence establishes that the candidate violates a requirement the base satisfies. Count a false alarm when a reviewer is presented with a defect claim contradicted by code, documentation, or a follow-up run. Record unresolved claims and abstentions separately. Count no claims when an arm emits no alert.
4. Time each CLI invocation from launch to finished review. Add the planner time to the assisted arm. Measure active reviewer time separately during adjudication before drawing a conclusion about review savings.

## TraceTern result

The planner took 89 ms from a prebuilt CLI, including Node startup and Git reads. It selected zero experiments and exited 2 without building the target. The change touched `queriesObserver.ts`, its test, and a changeset. The available experiments cover cache identity and restoration, and the PR changes observer result handling. TraceTern emitted zero confirmed findings, zero false alerts, and one abstention. This run establishes a coverage gap. The PR's correctness and reviewer-time savings remain unknown.

The same planner selected three documented checks on the earlier development PR #11073. All three passed. A separate controlled test removes key canonicalization and confirms the selected cache lookup fails and replays. These checks validate the implementation, outside the fresh PR trial.

## Independent check of the PR's intended fix

After freezing the planner result, I ran the PR's observer scenario directly against bundles of both revisions. I started with one subscribed pending query, requested an optimistic result for two queries, resolved the first query, then requested the two-query result again before calling `setQueries` for the new list. The baseline's combined count changed from 2 to 1. The candidate's count stayed at 2. This reproduces the behavior the author intended to fix. It is independent adjudication and earns no discovery credit for either review arm.

## Cursor comparison

The pinned review workspaces were prepared. Cursor CLI `2026.11.19-f005e9d` requires account authorization before either review can start. Confirmed findings, false alerts, and review time for both Cursor arms are pending. The 89 ms above measures TraceTern execution only.

```sh
npm run tracetern -- plan-library .tracetern/tanstack-query \
  816a0aab2e904cd5364d3b0f278582eccc660318 aab2d96e3a90f8f7515400fe3a86f9da40eb7107 --json
```

## Observer experiment development

I used PR #12633 as a development case for the observer experiment. A one-query control returned one result before and after the pending query resolved on both revisions. When the requested list grew to two queries, the baseline returned counts of 2 then 1, and the candidate returned 2 then 2. With the revisions reversed, TraceTern reported a regression. Both directions replayed using the saved artifacts. This development result leaves the original frozen comparison pending.

## Separate hydration coverage check

After fixing the observer experiment inputs, I ran the planner on [TanStack Query PR #11395](https://github.com/TanStack/query/pull/11395), which changes dehydration timestamps. The pinned base is `799a33cdadad19d008e57c6a60e716701860a9bd` and the candidate is `a97345fc7fa1d0deb0dec0a234877a59f1ce6750`.

The planner selected `restore-baseline-cache` from the hydration diff and the persistence guide. The expected value was restored on both sides, and the saved run reproduced. That check covers cache restoration with a fixed snapshot timestamp.

The dedicated timestamp experiment now cites the contract added by the candidate. It observes two dehydrated queries with a controlled clock of 900. On PR #11395 the fallback used that clock, the client default yielded 444, and explicit overrides yielded 123 and 0. Each supplied timestamp skipped the clock. The baseline used 900 throughout, which is its behavior before the feature. A controlled mutation in a copy of the candidate replaced nullish coalescing with a truthiness check. TraceTern caught zero falling back to 444 and reproduced the regression by run ID.

## Onboarding a separate TypeScript repository

I selected [Zustand PR #2213](https://github.com/pmndrs/zustand/pull/2213) as a known historical repair. The immutable inputs were parent `f5561dfb05babb89773128d00fabda74ddd145d4` and fix `949b505a4b5414d5b249c413e9847bb0df559a42`. The first attempt stopped at source capture because the existing runner expected TanStack's package layout. Zustand's standalone entry is `src/vanilla.ts` and the pinned revisions use `yarn.lock`.

I moved those capture settings behind the adapter selection and routed the saved fixture through the generic library replay path. The merge, subscriber notification, and unsubscribe controls passed on both revisions. The baseline kept the previous data as an object when set to null, and the candidate returned null for both object and string stores. Reversing the revisions produced a regression. CLI replay and MCP replay both worked with an empty PATH. This measures onboarding and replay for a known contract.

## Apache DataFusion #24109

This is a known upstream development case. I compared released engines 54.0.0 and 55.2.0 using the three-row source from [issue #24109](https://github.com/apache/datafusion/issues/24109). Version 55.2.0 contains the [branch-55 backport](https://github.com/apache/datafusion/commit/045b590c4822fdbd2ce47eac2f7a5a55b28cde45) of [repair #24125](https://github.com/apache/datafusion/pull/24125). These releases also differ in other changes.

All three candidates returned ID 2 on the scalar, inferred-schema and unoptimized controls. With a declared struct schema requiring adaptation, 54.0.0 returned IDs 1, 2 and 3. Turning off pushdown on the same engine returned ID 2, but the executed scan pruned zero rows. Engine 55.2.0 returned ID 2 and pruned two rows in the scan. The probe reads the executed scan counter independently of the configuration flag. This measures engine work on this input, not elapsed time. All three runs replayed from their saved Parquet bytes with the same checks and verdicts.

## Retrieving a saved experiment for DataFusion PR #27259

I gave the lexical retriever only the public unified diff for [PR #27259](https://github.com/apache/datafusion/pull/27259) (base `9f208b63d18d6a782513d8cd32453dc56c67a3fd`, head `7222eb99446e5562de74f5c892f2661da36e5773`). The changed production file `projection_read_plan.rs` matched the terms `struct` and `schema`. The retriever returned the saved Parquet pushdown experiment and counted three distinct original modes, regardless of the replays in the store.

The old experiment is a relevant control for struct-field filtering and scan work. The PR's SQL test exercises a Map key lookup nested inside a struct, which the three-row fixture does not cover. This result establishes related-case retrieval. It gives no coverage or correctness verdict about the PR, and no candidate revision was executed.
