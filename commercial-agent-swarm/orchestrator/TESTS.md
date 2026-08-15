# Orchestrator Tests

Run T01–T16 from `../tests/TEST-PLAN.md` using `agent-test-matrix.yaml#commercial-orchestrator`. Critical assertions: replay creates no duplicate assignment/action; A3 is not dispatched without exact QA/grant; A4 is rejected; kill switch stops dispatch and preserves evidence. All outputs must validate against the result schema.
