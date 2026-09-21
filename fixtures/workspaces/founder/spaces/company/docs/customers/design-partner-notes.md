# Enterprise design partner notes

## Northstar Logistics

- **Team:** 180 people across operations, finance, and product
- **Primary need:** A durable record of agent-made changes for compliance review
- **Current workaround:** Weekly exports from three separate tools

They do not need a broad admin console yet. They need to answer who changed a document, what changed, and whether a person reviewed it.

## Cascade Health

- **Team:** 95 people, with a six-person security group
- **Primary need:** Audit evidence and predictable access removal
- **Current workaround:** Screenshots attached to quarterly access reviews

Their strongest reaction was to provenance in the document header. They asked whether the same history could be exported for an auditor.

## Fieldcraft Studio

- **Team:** 42 people using agents heavily in client delivery
- **Primary need:** Separate client spaces without duplicating operating templates
- **Current workaround:** One folder tree per client and a manual setup checklist

They are a better design partner for reusable structures than for identity work. Keep their requests out of the Q3 enterprise-readiness scope.

## Shared signal

Northstar and Cascade can use the same first audit-log export if it includes actor, source, timestamp, artifact, and review status. That is the next decision to validate.
