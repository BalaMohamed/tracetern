# TraceTern implementation plan

| Milestone | Deliverable and acceptance check |
| --- | --- |
| Deterministic fixture | The orders CLI measures query counts and detects the stale cache on a real PostgreSQL instance. The passing control preserves order and freshness. |
| Revision-backed evidence | Compare two trusted commits implementing the orders service contract. Pin commits and trees, store the executable modules and measurements locally, then reproduce a saved counterexample by ID after HEAD moves. A changed dependency lock yields an inconclusive result. |
| Experiment planner | Express read, rename and read-again operations as validated data. Run the same saved plan through the deterministic worker. Compare local-model choices with a cache-aware rule under the same replay budget. |
| Assistant and browser | Expose run evidence and reruns by ID. Let an engineer follow a finding from the terminal to its source and let their assistant rerun the same experiment after a fix. |
| Measurement and replay | Measure calls through the worker's PostgreSQL client observer. Replay a saved plan after CLI and planner changes, and reject incompatible replay builds. |
| Database-free library adapter | Run and replay the pinned TanStack Query key change through its public cache API. Exercise a controlled failure and keep Orders on its existing execution path. |
| Diff and documentation planner | Cite source changes and base contracts for selected library experiments. Retain selection provenance, replay the subset, and measure coverage on a preselected PR. |
| External validation | Trial the adapter on independently selected trusted repositories. Measure retained counterexamples, false alarms and review time against the same coding assistant alone. Broaden target support where the trials justify it. |

TraceTern supports the standalone Orders contract and the pinned TanStack Query Core layout. The planner accepts validated Orders experiments from a rule or an installed local model. The loopback viewer and stdio MCP adapter read both forms of saved evidence. The assistant can check a committed Orders fix against its saved case. The TanStack comparison is a development case with predetermined checks. External validation is the next milestone.
