#!/usr/bin/env bash
set -euo pipefail
# Run from the TraceTern root. The evaluator verifies each downloaded digest.
dataset="${1:-pilot}"
case "$dataset" in
  pilot|expanded) ;;
  *) echo 'Usage: bash evaluation/ranking/fetch.sh [pilot|expanded]' >&2; exit 2 ;;
esac
directory=.tracetern/ranking-diffs
mkdir -p "$directory"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const readCases = name => JSON.parse(readFileSync("evaluation/ranking/" + name, "utf8")).cases;
  const pilot = readCases("cases.json");
  const cases = process.argv[1] === "expanded"
    ? [...pilot.filter(item => item.split === "train"), ...readCases("cases-expanded.json")]
    : pilot;
  for (const item of cases) console.log(item.repo, item.pr);
' "$dataset" | while read -r repo number; do
  destination="$directory/${repo//\//-}-$number.diff"
  if [ ! -f "$destination" ]; then
    gh api -H 'Accept: application/vnd.github.diff' "repos/$repo/pulls/$number" > "$destination.download"
    mv "$destination.download" "$destination"
  fi
done
