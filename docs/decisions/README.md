# Decision log

Confirmed product decisions D01–D13 and issues Q01–Q12 are recorded in ../PROJECT_PLAN.md.

ADR index:

| ADR | Title | Status |
|---|---|---|
| [ADR-001](ADR-001-training-service-boundary.md) | Training service boundary and adapter strategy | Proposed |
| [ADR-002](ADR-002-progress-scope-and-authority.md) | Progress scope and authority | Proposed |
| [ADR-003](ADR-003-scheduler-defaults.md) | Scheduler defaults and policy choices | Proposed |
| [ADR-004](ADR-004-local-storage-and-selection.md) | Local storage and next-due selection | Proposed |
| [ADR-005](ADR-005-architecture-extraction-not-fork.md) | Architecture — extract and reuse, do not fork Lila | **Accepted** |

The architecture question (Q01/G1) is **resolved**: extract/reuse, no Lila fork (ADR-005).
Remaining Proposed ADRs are implementation defaults awaiting confirmation, not architecture blockers.

Future ADRs must include: status/date, context, considered alternatives, decision, consequences, verification evidence, and superseded decisions. Agents may propose ADR content; the integration owner reconciles it with user requirements.
