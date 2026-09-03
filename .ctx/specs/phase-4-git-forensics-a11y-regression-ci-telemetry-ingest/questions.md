---
ctx_schema: 1
spec: phase-4-git-forensics-a11y-regression-ci-telemetry-ingest
---

## Blocking



<!-- Anything whose answer changes what gets built. Unchecked boxes
     here block planning: `- [ ] Q1: …` -->
- [x] Which of Phase 4's six work streams does this engagement commit to building?
- [x] Work Stream 4.5 asks for exactly what ADR 0009 refused. Hold the refusal or supersede the ADR?
- [x] Is Work Stream 4.2's VS Code extension (a fourth published package) in scope?

## Non-blocking



<!-- Worth knowing, but you can proceed without it. -->
- [ ] Does a CI regression run replay recorded responses, or does 4.4 need a live mode against the PR's own backend?
- [ ] Does the a11y walk share recording.renderNodeCap or need its own cap in the settings table?
- [ ] Is a production-observed failure a new property on existing ARKG nodes, or a separate node kind?

## Resolved



- Which of Phase 4's six work streams does this engagement commit to building? → The costed subset, in order: 4.3 Git Forensics, then 4.6 Accessibility Autopilot, then 4.4 Autonomous Regression Watcher, then 4.1a production telemetry webhook ingestion. 4.1b, 4.2 and 4.5 close as argued deferrals. User, 2026-09-03. (2026-09-03)
- Work Stream 4.5 asks for exactly what ADR 0009 refused. Hold the refusal or supersede the ADR? → Hold the refusal. Roadmap 4.5 gets a deferral in its own voice pointing at ADR 0009; the ADR is not superseded. User, 2026-09-03. (2026-09-03)
- Is Work Stream 4.2's VS Code extension (a fourth published package) in scope? → Out of scope, deferred with an ADR. The already-built-and-unreachable getBlastRadius gains an MCP reader instead, so the blast-radius capability ships without the editor. User, 2026-09-03. (2026-09-03)
