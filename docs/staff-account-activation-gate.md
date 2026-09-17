# Staff activation and invitation recovery

## Engineering verdict

Fits the existing staff profile → Auth identity → subject → tenant membership model. Difficulty 6/10: distributed account creation, password gate, tenant permissions and capacity races. Changes are global code/RPC paths, with no tenant seed, backfill or plan-capacity modification.

## Confirmed incident evidence (17 September 2026)

Read-only production inspection found the reported Marktone invitation pending, its Auth email confirmed, and its staff profile still invited with no membership. Marktone consumes 7 of 7 contract employee seats. The membership trigger invokes `enforce_tenant_plan_limit` and raises `plan_limit_reached`; the activation endpoint previously translated that to a generic verification error. Four current active/trial tenants were inspected in aggregate; one is at employee capacity. No production records were changed.

The fix checks capacity before Auth creation and preserves the authoritative final membership limit. It explains the real limit rather than changing the subscription. A confirmed account from a partial attempt can finish a pending invitation after capacity is available by proving its existing password. Unknown passwords are never used to reset confirmed accounts. The invitation Auth lookup is now exact and indexed, avoiding the old scan of up to 10,000 users.

## Direct creation

From Team, save a staff profile and choose temporary password or invitation; existing pending profiles also expose the temporary-password action. Direct creation requires people.manage + users.manage + users.reset_password, exact tenant/staff matching, active employment, and lower target role rank (platform permission retains its existing override). Accounts already owned by an existing Auth identity use the invitation/link flow; this path never updates their password.

A private, RLS-enabled operation table records identity, actor and status only. Auth receives a server-owned app_metadata operation marker. Completion revalidates live permissions and profile identity, verifies that marker, links through the existing canonical function, revokes obsolete invitations and audits the action. No password enters a database RPC, employee metadata, audit log, response, or persistent browser state. The SHA-256 fingerprint of the existing Auth password hash is private and used only to ensure the first password has actually changed before clearing the subject gate.

Preparation and completion use short transactions. No network request runs under a database lock. Final membership insertion retains the tenant advisory capacity lock. A failed/ambiguous Auth call leaves a resumable operation; retries never replace its password or duplicate its membership. If the first password was forgotten, the manager can use the existing password-reset flow after activation. A manager cannot reset any identity attached to another tenant or a platform membership.

## Verification

Executable PGlite tests use inspected live permission/link/invitation/capacity functions, synthetic Auth and tenants, and real SQL functions from the new migration. Coverage: first activation, retries, exact-tenant denial, missing permission, role hierarchy, suspended accounts, existing Auth identity, capacity preflight and final-seat competition, identity/permission change before completion, new tenants, invitation recovery, single-use tokens, forced password gate, forged app metadata, shared-account reset denial, RLS/table access. HTTP tests execute both Edge handlers with mocked external Auth, verifying request sequencing and absence of privileged mutations after denial. React/JSDOM verifies password confirmation, error/retry, permissions and password removal after success.

No end-to-end production account is created as a test. Production rollout and authenticated browser verification require release authorization; the code and local SQL/HTTP/UI tests are ready for review independently.

## Release order and operational prerequisite

1. Apply `20260917194438_staff_account_activation_v1.sql` to ODEIR project `gswpbwdactcstkasddta` (never the Marktone CRM directory project).
2. Deploy `tenant-invitation-activation` and new `tenant-staff-account` with the checked-in config (`verify_jwt=false`; invitation token or caller-scoped RPCs authenticate each operation). Preserve the existing password-reset Edge deployment; the additional shared-account protection is in its RPCs.
3. Deploy the app, verify the Team form, a full-capacity invitation message and a synthetic account on isolated staging.
4. To activate the reported Marktone employee, an authorized plan administrator must increase the 7-seat capacity or explicitly deactivate an unused membership. This change does neither automatically. Retry the pending invitation with the employee's original password after capacity is available.

## Rollback

Revert the app change and restore the previous invitation Edge code first. Disable the new account endpoint by revoking EXECUTE on its prepare/complete RPCs and removing its Edge deployment. Keep operation history, password gate and completed accounts: do not delete users, memberships or employee data. Existing accepted invitations continue to work. The additive table can remain unused. Never clear must_change_password as part of rollback.
