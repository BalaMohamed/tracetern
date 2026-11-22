# PR experiment ranking

Each dataset uses one row per public PR. Each row pins the reported base and head revisions, the SHA-256 of the downloaded GitHub diff, a repository split, and a manual relevance judgment with its rationale. Unlisted experiment families are irrelevant for that PR.

- **Direct** means a saved experiment checks the changed behavior. A recommendation points to that experiment's scope, so running it against the PR still requires compatible artifacts.
- **Control** means the experiment checks a related behavior worth preserving and omits the primary changed condition.
- **Irrelevant** covers unrelated changes and gaps where a test-only, type-only, or different runtime concern needs its own evidence.

The pilot trains on eight PRs from TanStack Query, DuckDB, and Pinia. Its nine held-out PRs come from Apache DataFusion and Zustand. Fit and test use disjoint repository names. Cases were chosen to cover direct matches, related controls, and hard negatives. This is a small, manually labeled set chosen for coverage, and some training cases were used to develop TraceTern fixtures. The test repositories were held out of model fitting. Their fixture definitions were already part of TraceTern, and public PRs may have appeared in the language model's pretraining data.

Each method gets the same four experiment families and the same bounded excerpts from changed production files. The benchmark excludes PR prose, standalone test paths, outcome labels and run records from those inputs. Inline tests in source files can appear in the excerpts. It uses one public PR per example and rejects duplicate PR IDs, head commits and diff digests. A replay cannot add an example because the dataset never reads the runs database.

The keyword baseline counts matching code terms across the diff and requires two matches. That allows cross-repository recommendations without TraceTern's production path gate. The learned baseline fits class-balanced logistic regression to code-term overlap, path-term overlap, and the production path match and its code-term overlap. It treats direct and control labels as useful during fitting and abstains below 0.5. Ollama ranks or abstains using the same four candidates and their scopes. It receives the full candidate bank in this benchmark, while the product command reranks a keyword shortlist. The benchmark measures selection. Test PR code is never executed.

## Reproduce

From the TraceTern root, download the public diffs once with GitHub CLI and run the benchmark. The evaluator verifies the digest of every diff before using it.

```sh
bash evaluation/ranking/fetch.sh
npm run evaluate:ranking --silent
npm run evaluate:ranking --silent -- --ollama <installed-model-tag>
```

The report includes training weights, per-PR rankings, useful and irrelevant top picks, abstentions, correct abstentions and nDCG averaged over cases with a useful candidate. A correct abstention means there was no useful candidate. A high nDCG indicates the relevant candidates were placed early on the applicable cases. The two measures together expose both recommendation quality and unnecessary alerts.

## Expanded holdout

The [expansion](cases-expanded.json) adds 25 merged PRs from five repositories. It keeps the eight pilot training PRs and adds eight training PRs from Polars and VueUse. The fresh holdout contains 17 PRs from Apache DataFusion Comet, Redux, and SWR. No pilot holdout PR or repository enters the expansion. The evaluator also rejects matching head commits and diff digests across the two datasets.

Six held-out PRs have a relevant experiment. One matches the changed behavior directly, and five have a useful control. The other eleven are hard negatives selected for their similarity to an existing experiment. For example, a Parquet change can contain the words “filter” and “schema” while its actual contract is to preserve a conversion error from a join. A result-row comparison cannot verify that contract. All relevance judgments were recorded before scoring. The selection is deliberately enriched for plausible distractors, so the rate of irrelevant picks describes this holdout.

The expanded run refits the logistic model with the new training cases. It uses the same features, cutoffs, experiment bank, Ollama model, and scoring as the pilot. The path filter also skips Rust test modules such as `tests.rs` and `test_utils.rs`.

```sh
bash evaluation/ranking/fetch.sh expanded
npm run evaluate:ranking --silent -- --dataset expanded
npm run evaluate:ranking --silent -- --dataset expanded --ollama <installed-model-tag>
```

### Expanded results

| Method | Useful first picks | Irrelevant first picks | Correct abstentions | Useful cases missed at rank 1 | Mean nDCG on useful cases |
| --- | ---: | ---: | ---: | ---: | ---: |
| Keyword | 3 | 5 | 7 | 3 | 0.61 |
| Learned | 3 | 5 | 7 | 3 | 0.61 |
| Ollama | 4 | 10 | 1 | 2 | 0.67 |

The learned ranker and keyword baseline had identical first picks. Both recommended the Parquet experiment for [Comet's conversion-error fix](https://github.com/apache/datafusion-comet/pull/6067) and ranked the state-store experiment ahead of the cache-key experiment on [SWR's stable hash change](https://github.com/vercel/swr/pull/1429).

The same local Huihui Gemma 4 12B variant ranked the cache-key experiment first on SWR's stable hash change. It made five more irrelevant first picks than either lightweight method across the holdout. The [expanded report](results-expanded.json) records the weights, model digest, and complete orders. The corrected standalone-test filter reproduces the pilot's original keyword and learned results.

## Pilot results

All three methods were scored on the same nine PRs. Four had a useful match in the candidate bank and five had no match.

| Method | Useful first picks | Irrelevant first picks | Correct abstentions | Missed useful cases | Mean nDCG on useful cases |
| --- | ---: | ---: | ---: | ---: | ---: |
| Keyword | 4 | 3 | 2 | 0 | 1.00 |
| Learned | 4 | 2 | 3 | 0 | 1.00 |
| Ollama | 2 | 3 | 2 | 2 | 0.50 |

The learned ranker skipped the [SQL unparser change](https://github.com/apache/datafusion/pull/27531) that keyword search matched to Parquet filtering. Both still recommended a filter test for [reverse sort pushdown](https://github.com/apache/datafusion/pull/27079) and a runtime state test for [Zustand's type-only replacement restriction](https://github.com/pmndrs/zustand/pull/2580).

Ollama used the installed Huihui Gemma 4 12B variant with digest `31f91ca54365`. It abstained on the direct [struct filter pushdown change](https://github.com/apache/datafusion/pull/20822) and the [struct schema pruning control](https://github.com/apache/datafusion/pull/22960). It returned all four families for a [test-only PR](https://github.com/pmndrs/zustand/pull/3442). The [complete run](results.json) includes the exact tag, digest, weights and per-PR outputs.

The learned ranker made one fewer irrelevant recommendation on these examples. The learned model is available through the benchmark command.

## Saved coverage holdout

The [coverage dataset](cases-coverage.json) adds nine PRs from Arrow Rust, Reselect, and stable-hash. All three repositories are new to the earlier benchmarks. The logistic model uses the same 16 training PRs and settings as the expanded run. The Comet and SWR examples below guided rule development and contribute no holdout observations.

For the three-way comparison, benchmark each ranker on the same four experiment families and apply the same coverage filter to each result. The filter can remove a ranked candidate. The benchmark keeps the original order and measures what changes after filtering. It uses the fixed catalog of known experiment assertions, independent of the locally available runs. The product command also checks that the specific saved run contains passing assertions, and can retrieve a supported run across repositories even when a keyword ranker missed it.

| Ranker | Useful first picks, before → after | Irrelevant first picks, before → after | Correct abstentions, before → after |
| --- | ---: | ---: | ---: |
| Keyword | 1 → 1 | 3 → 0 | 4 → 7 |
| Learned | 1 → 1 | 3 → 0 | 4 → 7 |
| Ollama | 1 → 1 | 4 → 0 | 3 → 7 |

Each method retained the Arrow Parquet case as a control and missed the direct stable-hash case. Coverage filtering can rule out unsupported candidates but cannot restore an experiment absent from the input order. The product command did recover the saved Query Core experiment for the fresh stable-hash PR using its recorded checks. The [full report](results-coverage.json) includes the raw and filtered outputs and the Ollama model digest. The sample measures selection on a hard-negative-heavy holdout.

For [Comet #6067](https://github.com/apache/datafusion-comet/pull/6067), the product reported a join conversion-error requirement and abstained. The saved DataFusion run measures filtered IDs and rows pruned during a Parquet scan. It has no join or expected conversion-error check. For [SWR #1429](https://github.com/vercel/swr/pull/1429), the product retrieved a saved Query Core run that passed both reordered-object equivalence and distinct-array-order checks. That offers an experiment for the same hashing behavior. Evaluating the SWR change itself would require running the check with SWR.

```sh
bash evaluation/ranking/fetch.sh coverage
npm run evaluate:ranking --silent -- --dataset coverage --ollama <installed-model-tag>
```

## Saved coverage as the shortlist

The [shortlist holdout](cases-shortlist.json) pins ten public PRs from json-stable-stringify, Parquet Java, and fast-json-stable-stringify. Each repository is outside the training set and all earlier holdouts. Two PRs have a useful match and eight have none. The model fit uses the same 16 training PRs and the same weights as the previous coverage trial.

Both the terminal and the benchmark build the shortlist from records of passing assertions. The benchmark reads a [fixed snapshot](saved-coverage.json) of original saved runs so that anyone can reproduce the shortlist without a local evidence database. Replays, repeat observations, and follow-up verifications contribute no examples. A single saved run must contain every required check for a behavior. The implementation then lets keyword search, logistic regression, or Ollama order the eligible candidates. The keyword and learned scores still affect order when several experiments qualify, and a low score can no longer remove a candidate that has recorded coverage. Ollama can abstain and is called only for a nonempty shortlist.

| Ranker | Useful first picks, baseline → shortlist | Irrelevant first picks, baseline → shortlist | Correct abstentions, baseline → shortlist |
| --- | ---: | ---: | ---: |
| Keyword | 1 → 1 | 1 → 0 | 7 → 8 |
| Learned | 1 → 1 | 0 → 0 | 8 → 8 |
| Ollama | 1 → 1 | 3 → 0 | 5 → 8 |

All three surfaced the cache-key experiment for [json-stable-stringify #13](https://github.com/ljharb/json-stable-stringify/pull/13). The keyword and learned baselines omitted it. Both had previously suggested a useful control for [Parquet Java #856](https://github.com/apache/parquet-java/pull/856). The shortlist missed that case because the recognizer did not identify the null-filter behavior from the changed code. This is a selection evaluation with a small, deliberately hard holdout. The [complete report](results-shortlist.json) records per-PR ranks and the Ollama model digest.

```sh
bash evaluation/ranking/fetch.sh shortlist
npm run evaluate:ranking --silent -- --dataset shortlist --ollama <installed-model-tag>
npm run tracetern -- suggest change.patch --learned evaluation/ranking/results-shortlist.json
```

## Beta selection holdout

The [frozen manifest](cases-beta.json) contains 12 merged PRs from five
repositories absent from all previous splits. One case directly changes an
asserted behavior, five have a related control, and six have no useful saved
experiment. Case selection targeted serializer ordering, Parquet pruning and
store notifications, with adjacent changes included to test abstention.
Labels and rationales were recorded from the public diffs before scoring.
The manifest pins the GitHub base and head object IDs and the SHA-256 of each
downloaded PR diff.

The learned model uses the original 16 training PRs. On the holdout, all
methods use the same changed production source excerpts, capped at 1,200
characters per file and 10,000 characters overall. Standalone test files,
documentation, changesets, and config files are excluded. Tests embedded in
production files can still appear. Recorded coverage uses the same saved
assertion snapshot as the previous shortlist evaluation. The pure coverage
baseline orders eligible experiments by matched behavior count, with fixture
ID breaking ties. Keyword, learned, and optional Ollama methods also run on
the common candidate bank and on the coverage shortlist.

```sh
bash evaluation/ranking/fetch.sh beta
npm run evaluate:ranking --silent -- --dataset beta
npm run evaluate:ranking --silent -- --dataset beta --ollama <installed-model-tag>
```

The deterministic score comparisons omit timings and resource measurements.
The report records per-case selection wall time in milliseconds, the number
of model-generation requests, and the evaluator process's peak RSS in KiB.
The evaluator RSS excludes the separate Ollama server. Selection timings
exclude diff fetching and builds, while model request times include local
provider overhead.

| Method | Direct first | Control first | Irrelevant first | Correct abstentions | Useful cases missed at rank 1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Keyword | 0 | 2 | 2 | 4 | 4 |
| Learned | 0 | 1 | 1 | 5 | 5 |
| Recorded coverage | 1 | 0 | 0 | 6 | 5 |
| Keyword on shortlist | 1 | 0 | 0 | 6 | 5 |
| Learned on shortlist | 1 | 0 | 0 | 6 | 5 |
| Ollama | 0 | 2 | 8 | 0 | 4 |
| Ollama on shortlist | 0 | 0 | 0 | 6 | 6 |

Recorded coverage found the request key ordering change in urql PR #426.
The local model abstained on it, including when offered the single eligible
experiment. The benchmark measured 19 ms and about 63 MiB peak evaluator RSS
with the deterministic methods. The Ollama run used 13 generation requests
and took 112 s overall, with about 68 MiB peak evaluator RSS. The
[complete report](results-beta.json) records the model tag and digest as well
as every ranking. [urql PR #426](https://github.com/urql-graphql/urql/pull/426)

**Executable coverage.** None of the five repositories has a supported Git
replay adapter. The one direct recommendation describes equivalent behavior
at the experiment level. No held-out PR code was run. The most frequent
misses were serializer controls spread across different APIs, followed by
store notification controls with application-specific lifecycle requirements.
Keep recorded coverage as the default and keep the current adapter set for
beta. The holdout does not establish a recurring executable failure for an
additional adapter.
