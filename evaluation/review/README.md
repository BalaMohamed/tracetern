# Paired public PR review

The [case manifest](cases.json) freezes the TraceTern commit, the evidence
seeds, six public changes, the reviewer model, and a 150-second budget per arm.
Cases were labeled from the public changes before running TraceTern or the
reviewer. The direct labels are predictions about a saved check's relevance.
A predicted direct case can still expose a selection or execution gap.

Cursor CLI was signed out at the start of the trial. Both arms use Codex CLI
0.162.1 with the same `gpt-6.1-terra` model and low reasoning effort, in fresh
read-only sessions. For each case, both workspaces receive copies of the
pinned base and candidate trees and the same public diff. The assisted
workspace additionally receives TraceTern's observations or abstention.
Both arms use the [same prompt](prompt.md). The arm that starts first
alternates by case. Review discussions, later upstream outcomes, verdict
labels, and evidence from other cases are outside the review inputs.

A confirmed finding needs a requirement the baseline satisfies and
independent evidence that the candidate violates it. A named issue without
that evidence is unresolved. A false alarm is a definite defect claim
contradicted by the contract, source, or an independent run. A reviewer who
emits no concrete claim abstains. Count shared failures separately as
existing issues, including when TraceTern can reproduce them. Deduplicate
within each arm by behavior. Assess each arm's output before counting it.

The trial measures assistant wall time and TraceTern wall time separately.
It measures no human reviewer time. The small sample describes these pinned
changes, which include cases related to known development experiments.

## Reproduce

Use Python with support for `tarfile.extractall(filter='data')`, Node, Git,
the locked library builder, GitHub CLI, and a read-only Codex CLI session.
Keep this evaluation directory in the current checkout. Create a detached
local worktree at the manifest's `traceTernCommit` to build the exact runner:

```sh
runner=.tracetern/review-runner
commit=$(node -p 'require("./evaluation/review/cases.json").traceTernCommit')
git worktree add --detach "$runner" "$commit"
npm ci --prefix "$runner"
npm ci --prefix "$runner/adapters/tanstack" --ignore-scripts
npm run build --prefix "$runner"
```

Fetch the seed objects into `.tracetern/tanstack-query` and
`.tracetern/zustand`. Fetch the pinned merge base and head for each case
into `.tracetern/paired-review-inputs/<owner>-<repo>`. Save the PR diff at
`.tracetern/paired-review-inputs/<owner>-<repo>-<number>.diff`, using
`gh api -H 'Accept: application/vnd.github.diff' "repos/$repo/pulls/$pr"`.
The preparation step verifies every diff digest before creating the review
workspaces and runs the evidence seeds into a fresh store.

```sh
python3 evaluation/review/run.py prepare .tracetern/paired-review-beta --runner-root "$runner"
python3 evaluation/review/run.py review .tracetern/paired-review-beta
```

The second command leaves transcripts, responses, and timings in the ignored
trial workspace. It skips arms that already have completion status files.
Keep the same inputs and settings when collecting incomplete arms.

## Results

All 12 reviews completed within the 150-second budget. The
[per-case results](results.json) include the saved observations, adjudication,
and measured wall times.

| Outcome | Assistant alone | With TraceTern |
| --- | ---: | ---: |
| Confirmed candidate regressions | 1 | 0 |
| Unresolved claims | 2 | 2 |
| Demonstrated false alarms | 0 | 0 |
| Cases with no regression claim | 4 | 5 |
| Assistant wall time across six cases | 86.0 s | 75.3 s |
| TraceTern wall time across six cases |  | 1.7 s |

The unassisted reviewer identified a missed observer notification on
TanStack Query PR #9954. It occurs when a speculative read for a different
query updates the combined result and the active query then reaches that
same value. An independent probe observed one notification in the base and
zero in the candidate. Both revisions sent a notification in the control
without the speculative read. The result reproduced three times. [TanStack Query PR #9954](https://github.com/TanStack/query/pull/9954)

TraceTern's saved observer check reported a shared failure on #9954 in a
different scenario. The assisted arm correctly declined to treat that
shared failure as a PR regression and missed the notification regression
reported by the other arm. On #11253, the other preselected direct case,
the saved assertion covered the expected default timestamp but selection
abstained. The planned two executable direct matches yielded one
selected comparison. On #12658, the selected observer control passed and
provided no evidence about query retention. [TanStack Query PR #11253](https://github.com/TanStack/query/pull/11253) · [TanStack Query PR #12658](https://github.com/TanStack/query/pull/12658)

The assisted arm took 77.0 seconds including TraceTern. One paired run on
six cases establishes neither a general speed advantage nor a review-quality
improvement. The observed miss shows why reports must state the exact
scenario and why a reviewer should keep inspecting changed behavior after a
saved experiment passes, fails on both revisions, or abstains.

### Reproduce the adjudicated finding

After preparing the pinned workspaces, build the two Query Core bundles and
run the independent public-API probe:

```sh
trial="$PWD/.tracetern/paired-review-beta/TanStack-query-9954"
for side in base candidate; do
  node "$runner/adapters/tanstack/build.mjs" "$trial/baseline/$side/packages/query-core/src" index.ts > "$trial/$side.mjs"
done
node evaluation/review/probe-9954.mjs "$trial/base.mjs" "$trial/candidate.mjs"
```
