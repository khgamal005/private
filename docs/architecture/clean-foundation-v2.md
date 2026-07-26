# Clean v2 foundation

Marktone remains one Next.js application, one Vercel deployment, and one
Supabase project. The product exposes only two workspaces:

- `/control` for Marktone platform administration.
- `/tenant/[slug]` for each isolated customer workspace.

## Database boundary

The v2 application uses four new schemas:

- `core` for organizations, tenants, domains, modules, integrations, and support.
- `access_control` for subjects, memberships, roles, and permissions.
- `catalog` for plans, features, subscriptions, and tenant overrides.
- `audit_log` for operational audit events.

The legacy `platform`, `identity`, `billing`, `crm`, `operations`,
`engagement`, and related schemas are not dependencies of the v2 entrypoints.
They stay temporarily in the linked development project only until the
workspace cutover is verified. No legacy tenant or CRM data is copied into v2.

## Access model

Application tables are deny-by-default:

- RLS is enabled on every v2 table.
- `anon` and `authenticated` have no direct table grants.
- Read policies document the intended tenant boundary as defense in depth.
- Mutations use authenticated, narrowly granted RPCs.
- Every privileged RPC verifies `auth.uid()` and the required permission.
- Platform mutations write an audit event.

The first platform owner is linked after the migration from the existing
Supabase Auth account. Auth user IDs are not hardcoded into migrations.

## Current cutover scope

The v2 entrypoints currently cover:

- sign-in context and password-change state;
- platform dashboard snapshots;
- tenant shell snapshots;
- tenant provisioning and status;
- plans, subscriptions, and feature overrides;
- integrations;
- support requests;
- audit history.

CRM, unified work/tasks, incentives, content targeting, and Market Mirror will
be rebuilt as subsequent v2 modules instead of importing their legacy schemas.
