# Changelog

## Unreleased

- Select an experiment using assertions that passed in a saved run, compare pinned library revisions, and verify a committed follow-up against the saved baseline.
- Distinguish shared failures from candidate regressions and report replay incompatibilities, invalid artifacts, timeouts, and cancellations.
- Inspect the same saved evidence in the viewer and via stdio MCP. Execution-enabled MCP sessions can verify library fixes in a configured trusted repository.
- Publish repository-disjoint selection results and a paired assistant trial. The trials establish coverage limits and do not establish improved review quality.
- Add a source-based quickstart, deterministic macOS and Linux CI, and a public feedback form.

The evidence store remains version 1. Older records remain readable. Replay can require the original runner and Node version when a saved harness fingerprint is incompatible. Back up the local evidence database before moving an installation and keep the recorded runner and dependency lock available for experiments you need to reproduce.
