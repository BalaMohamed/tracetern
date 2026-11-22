"""Execute the #24109 workload in one isolated DataFusion release."""
import hashlib
import json
import platform
import re
import sys
from pathlib import Path

import datafusion
import datafusion._internal
import pyarrow

CREATE_FILE = """
COPY (SELECT column1 AS id, column2 AS s, column3 AS v
      FROM VALUES (1, {'x': 100, 'y': 'foo'}, 10),
                  (2, {'x': 200, 'y': 'foo'}, 20),
                  (3, {'x': 300, 'y': 'foo'}, 30))
TO 'rows.parquet' STORED AS PARQUET
"""


def run(pushdown, create_file):
    ctx = datafusion.SessionContext()

    def sql(query):
        return [row for batch in ctx.sql(query).collect() for row in batch.to_pylist()]

    if create_file:
        sql(CREATE_FILE)
    sql("CREATE EXTERNAL TABLE declared (id INT, s STRUCT<x INT, y VARCHAR>, v INT) "
        "STORED AS PARQUET LOCATION 'rows.parquet'")
    sql("CREATE EXTERNAL TABLE inferred STORED AS PARQUET LOCATION 'rows.parquet'")

    def ids(query):
        # The workload compares row membership, including duplicates, not row order.
        return sorted(row["id"] for row in sql(query))

    nested = "SELECT id FROM declared WHERE s['x'] = 200"
    sql("SET datafusion.execution.parquet.pushdown_filters = false")
    unoptimized = ids(nested)
    sql(f"SET datafusion.execution.parquet.pushdown_filters = {pushdown}")
    actual = ids(nested)
    plans = sql("EXPLAIN ANALYZE VERBOSE " + nested)
    # The first plan is the executed plan with aggregated metrics. Later plans
    # can repeat them per partition. Require exactly one measured scan.
    counts = re.findall(r"\bpushdown_rows_pruned=(\d+)\b", plans[0]["plan"])
    if len(counts) != 1:
        raise ValueError("Expected one Parquet scan with a pushdown_rows_pruned counter")
    with Path(datafusion._internal.__file__).open("rb") as module:
        native_sha256 = hashlib.file_digest(module, "sha256").hexdigest()
    return {
        "runtime": {
            "engine": sql("SELECT version() AS engine")[0]["engine"],
            "binding": datafusion.__version__, "arrow": pyarrow.__version__,
            "python": platform.python_version(), "nativeSha256": native_sha256,
        },
        "observations": {
            "nested": actual, "pruned": int(counts[0]), "unoptimized": unoptimized,
            "inferred": ids("SELECT id FROM inferred WHERE s['x'] = 200"),
            "scalar": ids("SELECT id FROM declared WHERE v = 20"),
        },
    }


if __name__ == "__main__":
    pushdown, input_mode = sys.argv[1:]
    if pushdown not in ("true", "false") or input_mode not in ("create", "reuse"):
        raise ValueError("Invalid probe configuration")
    print(json.dumps(run(pushdown, input_mode == "create")))
