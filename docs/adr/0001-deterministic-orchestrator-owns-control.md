# Deterministic orchestrator owns control

The Software Factory uses a deterministic state machine to own transitions, budgets, Gates, credentials, GitHub mutations, and completion decisions. Agents receive bounded Context Packets and propose plans or code, but they cannot declare completion, mutate GitHub directly, merge, or override Factory policy; this trades some agent flexibility for auditability, idempotency, and a reliable human-controlled Merge Boundary.
