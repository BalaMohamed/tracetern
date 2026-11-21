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
