# Runbook: spike in payment failures

## Detect
Alert: `charge_5xx_rate > 1%` for 5m.

## Triage
1. Check the **Incident Board** widget for open sev1/sev2.
2. Inspect the Payments API dashboards.
3. Confirm the Ledger is keeping up (see `inc-003`).

## Mitigate
- Shed tier-3 traffic (ADR-002).
- Enable idempotent replay (ADR-001).

## Communicate
Post status updates every 15 minutes.
