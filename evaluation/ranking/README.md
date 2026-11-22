# PR experiment ranking pilot

The dataset contains one row per public PR. Each row pins the reported base and head revisions, the SHA-256 of the downloaded GitHub diff, a repository split, and a manual relevance judgment with its rationale. Unlisted experiment families are irrelevant for that PR.

- **Direct** means a saved experiment checks the changed behavior. A recommendation points to that experiment's scope, so running it against the PR still requires compatible artifacts.
- **Control** means the experiment checks a related behavior worth preserving and omits the primary changed condition.
- **Irrelevant** covers unrelated changes and gaps where a test-only, type-only, or different runtime concern needs its own evidence.

Training comprises eight PRs from TanStack Query, DuckDB, and Pinia. The nine held-out PRs come from Apache DataFusion and Zustand. Fit and test use disjoint repository names. Cases were chosen to cover direct matches, related controls, and hard negatives. This is a small, manually labeled set chosen for coverage, and some training cases were used to develop TraceTern fixtures. The test repositories were held out of model fitting. Their fixture definitions were already part of TraceTern, and public PRs may have appeared in the language model's pretraining data.

Each method gets the same four experiment families and the same bounded excerpts from changed production files. The benchmark excludes PR prose, test files, outcome labels and run records from those inputs. It uses one public PR per example and rejects duplicate PR IDs, head commits and diff digests. A replay cannot add an example because the dataset never reads the runs database.

The keyword baseline counts matching code terms across the diff and requires two matches. That allows cross-repository recommendations without TraceTern's production path gate. The learned baseline fits class-balanced logistic regression to code-term overlap, path-term overlap, and the production path match and its code-term overlap. It treats direct and control labels as useful during fitting and abstains below 0.5. Ollama ranks or abstains using the same four candidates and their scopes. It receives the full candidate bank in this benchmark, while the product command reranks a keyword shortlist. The benchmark measures selection. Test PR code is never executed.

## Reproduce

From the TraceTern root, download the public diffs once with GitHub CLI and run the benchmark. The evaluator verifies the digest of every diff before using it.

```sh
bash evaluation/ranking/fetch.sh
npm run evaluate:ranking --silent
npm run evaluate:ranking --silent -- --ollama <installed-model-tag>
```

The report includes training weights, per-PR rankings, useful and irrelevant top picks, abstentions, correct abstentions and nDCG averaged over cases with a useful candidate. A correct abstention means there was no useful candidate. A high nDCG indicates the relevant candidates were placed early on the applicable cases. The two measures together expose both recommendation quality and unnecessary alerts.

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
