# Single Authorized Operator Policy

ODEIR does not require a second human administrator to approve an action already assigned to an authorized role.

## Mandatory controls that remain

- Explicit role and permission checks at the server or database boundary.
- Typed confirmation for high-impact payment operations.
- Immutable audit events identifying the operator and the exact scope.
- Provider evidence, amount, currency, tenant, credential and environment binding.
- Idempotency, transactional locking, replay protection and fail-closed errors.
- Reef Skills exclusion and the bounded live-canary controls.

## Prohibited pattern

New runtime code must not create a requester-versus-second-approver dependency. Historical migrations remain as an audit record; the policy migration overrides their active constraints and functions. A regression test scans active source and all future migrations so this workflow cannot be reintroduced accidentally.
