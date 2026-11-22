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

I also ran the same diff through the optional Ollama reranker using the installed Huihui Gemma 4 12B variant (local digest `31f91ca54365`). It retained the Parquet pushdown control, the sole suggestion in the lexical shortlist. This verifies the local inference path. A one-candidate trial can't measure ranking improvement.

## Saved observer replay on TanStack Query PR #12642

TraceTern selected the saved `optimistic-query-count` experiment from the PR
#12633 development run `43ec9c70-e678-46bf-8fc3-37ea96a7b0d7` using the
`queriesObserver.ts` diff in PR #12642. The trial covers the count of
optimistic results when the query list expands. The PR addresses placeholder
render loops. [TanStack Query PR #12642](https://github.com/TanStack/query/pull/12642)

| Revision | One-query control, before → after | Expanded list, before → after | Result |
|---|---|---|---|
| PR base `f6689e04be493` | 1 → 1 | 2 → 1 | Existing failure |
| PR head `944e939d0025` | 1 → 1 | 2 → 1 | Same failure |
| Local follow-up `14135e16d05e` | 1 → 1 | 2 → 2 | Repair |

The PR comparison `f03e0907-cbb2-46ef-b5cb-39c88fcadf69` was inconclusive and
replayed with identical evidence. Verifying the original PR head again
returned the same observations. The local follow-up applied the observer
change from PR #12633 on top of the PR #12642 head. Verification
`40f48d2e-b2b9-4c77-9e3c-73062bb087b6` reused the saved baseline and plan,
passed, and replayed with identical observations. [TanStack Query PR #12633](https://github.com/TanStack/query/pull/12633)

To reproduce from a clean TraceTern checkout, install the locked dependencies
and fetch the four pinned upstream objects. These commands need Git and the
Node adapter build tools.

```sh
upstream="$PWD/.tracetern/tanstack-query"
seed_base=816a0aab2e904cd5364d3b0f278582eccc660318
seed_head=aab2d96e3a90f8f7515400fe3a86f9da40eb7107
base=f6689e04be493e2e83f9c93d7e478f92c3e5d328
head=944e939d002527cbacdc2bd3231fab90a5e7e4d3
npm ci
npm ci --prefix adapters/tanstack --ignore-scripts
git init "$upstream"
git -C "$upstream" fetch --no-tags --depth=1 https://github.com/TanStack/query.git \
  "$seed_base" "$seed_head" "$base" "$head"
npm run tracetern -- plan-library "$upstream" "$seed_base" "$seed_head" --json
npm run tracetern -- run-suggested "$upstream" "$base" "$head" --json
```

Set `run_id` to the `runId` from the second report. This creates the
follow-up commit in a local fixture repository.

```sh
follow_up=$(mktemp -d "$PWD/.tracetern/verify-12642.XXXXXX")
git init "$follow_up"
git -C "$follow_up" fetch --no-tags --depth=1 "$upstream" "$head"
git -C "$follow_up" read-tree FETCH_HEAD
git -C "$upstream" diff "$seed_base" "$seed_head" -- packages/query-core/src/queriesObserver.ts |
  git -C "$follow_up" apply --cached
patch_tree=$(git -C "$follow_up" write-tree)
patch_commit=$(git -C "$follow_up" -c user.name='TraceTern Fixture' \
  -c user.email=fixture@example.invalid -c commit.gpgSign=false \
  commit-tree "$patch_tree" -p FETCH_HEAD -m 'Preserve the optimistic query count when the requested list expands')
git -C "$follow_up" branch follow-up "$patch_commit"
npm run tracetern -- verify-library "${run_id:?Set run_id from the PR comparison}" "$follow_up" "$patch_commit" --json
```

The comparison exits 2 with `reasonCode: "shared-failure"`. The verification
exits 0. Save the verification's `runId` as `verification_id`. The next
commands move the target repositories out of their original paths and replay
from the bundles in the TraceTern evidence store. The replays need the
compiled CLI and compatible Node, with no Git, builder, model, or PostgreSQL.
Both report `reproduced: true`. The comparison replay still exits 2.

```sh
mv "$upstream" "$upstream.replay-copy"
mv "$follow_up" "$follow_up.replay-copy"
node dist/src/cli.js replay "$run_id" --json
node dist/src/cli.js replay "$verification_id" --json
```
