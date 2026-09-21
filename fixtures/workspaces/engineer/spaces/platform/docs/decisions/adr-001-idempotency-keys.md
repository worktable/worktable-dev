# ADR-001: Idempotency keys for write endpoints

## Status
Accepted

## Context
Payment write endpoints must be safe to retry. Network retries and at-least-once webhook delivery cause duplicate submissions.

## Decision
Every mutating endpoint requires an `Idempotency-Key` header. The key + request fingerprint is stored for 24h; a repeat returns the original response.

## Consequences
- Clients must generate stable keys.
- See incident `inc-004` for a collision edge case.
