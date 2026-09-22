# Independent academy workspace

Status: implementation for review; migrations and tenant activation have not been applied to production.

## Decision and scope

Odeir remains the centre's operational system. Website publishing, course commerce and interactive learning gain a separate academy workspace and separate user entry points. A centre can keep its external WordPress/WooCommerce website and existing Odeir order/customer import, or enable the native academy product. Existing WooCommerce connections, admissions, beneficiary handling and financial records are not migrated or replaced.

The implementation reuses canonical tenant contacts, students, courses, cohorts, sessions, invoices, payments, enrollments and learning history. Academy team membership does not create an Odeir staff membership. Interface separation does not require duplicating the database or customer identity.

Difficulty: 8/10. The difficult boundaries are independent identity, existing CMS/LMS authorization, financial admission triggers, and preserving history during student transfers. Implementation is split into platform/identity, commerce, scheduling, UI integration and verification. Production activation is a separate release step.

## Product surfaces

| Surface | Route | Authority |
| --- | --- | --- |
| Platform tenant controls | Existing tenant administration dialog | Tenant administration; billing for trials; access administration for membership |
| Academy management login | `/academy/login?tenant=marktone` | Authenticated academy capability checked before session issuance |
| Academy workspace | `/academy/{slug}` | Tenant and component entitlements plus explicit capabilities |
| Website editor | `/academy/{slug}/website` | Existing canonical CMS with academy-scoped manager/editor authority |
| Native store management | `/academy/{slug}/store` | Offer editing, financial configuration, payment verification and admissions are separate checks |
| Session management | `/academy/{slug}/schedule` | Academy learning management |
| Public website/catalogue | `/site/{slug}` and `/site/{slug}/courses` | Published public data only |
| Learner/instructor login | `/training/login?tenant={slug}&workspace=academy` | Real learner binding or assigned instructor, never a client-supplied role grant |

The tenant toolbar exposes **إدارة المنصة التدريبية** only when the enabled academy and the user's capabilities allow management. Existing licensed LMS/CMS paths redirect eligible pilot users to the new workspace. Other tenants and disabled academy configurations retain their existing paths. Optional navigation reads fail closed and have a bounded timeout.

`connected` mode retains Odeir's admissions, payment and task authority. `standalone` mode uses the academy's own management role and learner request queue; it does not create employee tasks. An independently invited instructor can teach assigned cohorts without receiving tenant operations access.

## Activation and pricing

New settings are disabled by default. Runtime activation is restricted to Marktone's existing UUID and slug together. No Reef record or entitlement is changed, and no subscription is seeded by these migrations.

Component checks use existing `lms` / `cms_pro` catalog and entitlement sources. No new numeric subscription price is invented. Store use requires both learning and website entitlements, or an explicitly authorized trial of at most 30 days. The platform snapshot exposes the authoritative catalog references. Configuration updates use a version, a command ID and audited before/after state. Membership and trial controls expose their separate administrative capabilities.

## Identity and security

- Dedicated `academy.platform_memberships` contains manager, website editor and instructor roles. The global Odeir `has_tenant_permission` and `can_access_tenant` contracts are not broadened.
- New academy tables are tenant scoped, indexed, have RLS enabled and deny direct anonymous/authenticated table access. Privileged RPCs check identity, tenant, entitlement and action permission, use an empty `search_path`, and grant only required execution.
- Team invitation tokens are cryptographically random and stored as hashes. Acceptance requires the confirmed Auth email, target tenant and role stored in the invitation. Suspension and role changes cannot be undone by replaying an old accepted invitation.
- Academy learner invitations require confirmed email and cannot be claimed by the older anonymous invitation activation path. Existing legacy invitations keep their prior flow.
- Confirmation removes provider credentials from the URL. Password recovery uses a trusted origin and safe, context-aware destinations. Management, learner and instructor login authorize the selected workspace before setting HttpOnly session cookies.
- Same-origin API validation, request limits, bounded snapshots and idempotent commands are enforced. Client-provided tenant IDs, actor IDs, prices or role labels do not replace database authority.

## Native course commerce

Initial native checkout supports explicitly classified short courses with full payment by bank transfer. Cohort and self-paced delivery reuse the existing academy model. Diploma contracts, installments, online gateways and actual refund settlement retain their established workflows; the native store does not claim these integrations are active.

Creating a pending order does not create a contact, student, invoice or payment. A bearer token allows its holder to follow only that order. Reporting a bank reference changes the order to payment review, not paid. The server fixes price, currency, tax, course, cohort and content version from the published offer; financial profile setup is explicit and preserves any existing profile.

An authorized reviewer verifies the full received amount, bank reference and identities. The transaction locks the order and cohort, checks capacity and identity conflicts, then creates/reuses canonical contacts and student, and writes the canonical handoff, invoice, verified payment, allocation, enrollment and pinned content version atomically. The payer can differ from the learner. Existing identity/ownership is never silently overwritten. Unique payment evidence and command keys prevent duplicate financial posting. Bank destination configuration requires financial settings authority in connected mode, not merely permission to author courses.

## Learner changes and scheduling

Standalone requests support deferral, resumption, withdrawal and transfer between cohorts of the same course. Requests and decisions retain actor, reason and history. A transfer preserves the original enrollment, creates a linked replacement, reuses the original invoice, records zero new financial amount, and copies only equivalent pinned-version learning progress. Capacity is rechecked under cohort locks. Withdrawal flags financial review and does not automatically refund or fabricate a ledger entry. Issued certificates prevent unreviewed enrollment changes.

Scheduling uses canonical cohort sessions and explicit updates, not a second calendar. Session status and cohort closure remain subject to existing learning and financial guards. Meeting links do not provision Zoom or send messages automatically.

## Compatibility and release evidence

The base reviewed repository was `37808973180022c41bfb9fc4a2d083b6a12fc657`. Relevant production schema and function definitions were inspected read-only, including September admission/finance governance. Tests use synthetic local data and current fixture definitions; no production customer was used for write testing.

Executable coverage includes independent membership without Odeir staff, tenant isolation, entitlement expiry, invitation email proof and replay, CMS permissions, server route boundaries, public order quotas, authoritative pricing, bank authority, identity conflicts, capacity/idempotency, paid admission, learning completion and certificate issuance, and request history. Browser fixtures exercise actual components with synthetic data and do not substitute for database integration tests. See the rollout runbook for the remaining real-environment release checks.
