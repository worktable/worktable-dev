# ADR-002: Token-bucket rate limiting at the edge

## Status
Accepted

## Decision
Rate limit per API key with a token bucket at the edge proxy, not in the application. Tier-1 services get a dedicated bucket.

## Consequences
Protects the Payments API (tier-1) from noisy neighbors; reporting (tier-3) is shed first under load.
