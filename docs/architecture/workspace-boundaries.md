# Workspace boundaries

Marktone is one Next.js application, one Vercel deployment, and one shared
multi-tenant Supabase project.

The application has two product workspaces:

- `/control` for Marktone platform administration.
- `/tenant/[slug]` for each isolated tenant workspace.

CRM is a tenant module. The product does not include a separate Marktone
internal CRM workspace.

Tenant isolation is enforced in server-side authorization and database
policies. Navigation visibility is not an authorization boundary.
