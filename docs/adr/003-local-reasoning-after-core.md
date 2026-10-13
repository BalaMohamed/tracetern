# ADR-003: Add local structured proposals only after deterministic execution

Status: proposed future direction; not implemented or benchmarked. Date: 2026-10-11.

Context: inference failures must not be confused with execution/oracle failures. Proprietary source and documents should not require external inference by default.

Decision: Phase 2 introduces a small reasoning-provider protocol and an Ollama implementation targeting the requested qwen3.5:9b model. Validate structured proposals against strict schemas and semantic allowlists; never execute generated code. Do not implement a cloud provider now. Retrieved content is context, not instruction authority.

Alternatives: start with hosted inference, couple the runner to Ollama, or build providers for hypothetical future integrations. Each either changes privacy assumptions or adds unnecessary scope.

Consequences: local inference reduces external disclosure needs, but does not establish security or reproducibility of generation. Record model identity/digest, generation settings, prompt version, raw output, and validated proposal when introduced. Availability and throughput require a later local pilot. Deterministic replay uses saved proposals rather than relying on regenerated model output.
