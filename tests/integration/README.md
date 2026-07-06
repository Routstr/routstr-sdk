# Integration Tests

These tests exercise multiple SDK modules together or hit real network
endpoints. They are kept separate from unit tests so unit tests can run
fast and in isolation.

Run only integration tests:

```bash
npx vitest run tests/integration
```
