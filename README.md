# Marktone Platform Control

Multi-tenant SaaS control plane for Marktone.

## Workspaces

- `/control` — platform administration, tenants, subscriptions, content, and integrations.
- `/tenant/[slug]` — isolated tenant operations, tasks, sales, incentives, settings, and knowledge.

The tenant CRM is a module inside `/tenant/[slug]`. There is no separate Marktone
internal CRM in this product.

## Development

```bash
npm ci
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
```

The repository contains the real Next.js source. Production builds no longer generate the application through bootstrap or patch scripts.

## Database

The application uses the clean v2 schemas documented in
`docs/architecture/clean-foundation-v2.md`. The v2 runtime does not depend on
the failed legacy operational schemas or their historical migrations.
# private
