# Deployment architecture — Hostinger host, GitHub Actions CI

Scope: how a commit reaches production for `marktone-platform-control`, which
files verify it, and where the cycle is still manual. Supabase schema and Edge
function deployment are described separately because they do not happen in this
cycle.

## Topology

| Layer | Owner | Configured in |
|---|---|---|
| Source of truth | `Marktonesa/marktone-platform-control`, branch `main` | GitHub |
| CI | GitHub Actions, Node 24 | `.github/workflows/*.yml` (in git) |
| Web host | Hostinger Node.js app | hPanel only (not in git) |
| Database / Auth / Storage / Edge | Supabase project `gswpbwdactcstkasddta` | Supabase dashboard + CLI |
| Vercel | **disabled** — `git.deploymentEnabled` is `false` for `main` | `vercel.json` |

Vercel is intentionally inert. `vercel.json` only constrains Vercel; it has no
effect on the Hostinger binding.

## Runtime contract expected from the host

| Setting | Value | Source |
|---|---|---|
| Application type | Next.js with a Node server (SSR, cookies, API routes) | `app/`, `app/api/` |
| Node | 24.x | every workflow pins `node-version: 24` |
| Install | `npm ci` against the committed `package-lock.json` | no lockfile edits, no upgrades |
| Build | `npm run build` → `next build` | `package.json` |
| Output | `.next` — there is **no** `output: 'standalone'` and no custom `server.js` | `next.config.mjs` |
| Start | `npm start` → `next start`, honoring `PORT` | `package.json` |
| Root | repository root | — |

Because there is no standalone output, the host must keep full `node_modules`
(`next start` loads the app from the build tree). Disk headroom on the plan is
a real constraint.

## The deploy cycle

```
1. work on a branch (agent/*, fix/*, feat/*)
2. push -> pull request
3. GitHub Actions on the PR
   3a. quality.yml ......... npm ci && npm run check        (always)
   3b. path-filtered suites ................................ (only when paths match)
4. merge into main
5. quality.yml re-runs on the push (informational)
6. Hostinger Git integration builds main automatically
       npm ci -> npm run build -> npm start
7. manual verification in hPanel -> Deployments
```

Steps 3 and 6 are independent. See "Known gaps" G1.

### Step 6 — what the Hostinger build actually does

Configured entirely inside hPanel and therefore invisible to review:

1. Hostinger's GitHub integration pulls `main`.
2. `npm ci`, then `npm run build`, then `npm start` behind the site's proxy.
3. The build fails or the process restart-loops, the deployment shows red and
   the previous release keeps serving.

Nothing in the repository triggers, gates, or observes this build. There is no
`Dockerfile`, no `Procfile`, no `output: 'standalone'`, and no
`.github/workflows/` file that deploys the Next application.

## What CI runs — the test files

### The main gate: `quality.yml`

Triggered on every `pull_request` and every `push` to `main`.
`permissions: contents: read`, `timeout-minutes: 20`.

```
npm ci
npm run check  ==  npm run lint        (eslint .)
              &&  npm run typecheck   (tsc --noEmit)
              &&  npm test            (node --test tests/**/*.test.mjs)
              &&  npm run migration:verify
              &&  npm run build
```

`npm test` resolves the glob through Node's own test-runner glob support, not
the shell — `sh` does not expand `tests/**/*.test.mjs`, and Node does. It
currently matches **293 files**, all directly under `tests/`:

```
tests/*.test.mjs
```

This depends on Node ≥ 22. On an older runtime the glob stays literal and the
suite does not run the top-level files.

Five suites in `tests/` are skipped unless a disposable URL is exported:

| Variable | Suite | Workflow that exports it |
|---|---|---|
| `ACADEMY_TEST_DATABASE_URL` | `tests/academy-concurrency.test.mjs` | `academy-concurrency.yml` |
| `ACADEMY_STORAGE_TEST_DATABASE_URL` | `tests/academy-storage-runtime.test.mjs` | `academy-storage.yml` |
| `TRAINING_TEST_DATABASE_URL` | `tests/training-journey-concurrency.test.mjs` | `training-concurrency.yml` |
| `GOVERNANCE_TEST_DATABASE_URL` | `tests/operational-governance-concurrency.test.mjs` | `operational-governance-concurrency.yml` |
| `ZOOM_TEST_DATABASE_URL` | `tests/zoom-concurrency.test.mjs` | `zoom-verification.yml` |

Each asserts the `postgres:` protocol, a loopback host, and a fixed database
name before it connects, so these variables cannot be pointed at a remote
database. `quality.yml` exports none of them, so a green Quality run does **not**
prove these transaction-isolation tests. They get their own jobs.

### Per-workflow verification files

| Workflow | Trigger | Runs | Service |
|---|---|---|---|
| `quality.yml` | any PR; push to `main` | `npm run check` (293 test files + lint + types + migrations + build) | — |
| `zoom-verification.yml` | `**/*zoom*`, `supabase/functions/zoom-connect/**`, `docs/zoom/**`, `components/learner-operations-workspace.js` | `npm run lint`, `typecheck`, `migration:verify`, `npm test`, `build` | `postgres:17` |
| `academy-concurrency.yml` | `supabase/migrations/**`, `tests/academy-*.test.mjs`, fixtures, `package.json` | `node --test tests/academy-concurrency.test.mjs` | `postgres:16` |
| `training-concurrency.yml` | `*training*` migrations, `tests/training-journey-*.test.mjs`, `lib/training-*`, `app/api/training/**` | `node --test tests/training-journey-concurrency.test.mjs` | `postgres:16` |
| `operational-governance-concurrency.yml` | `*governance*` / `*operating_foundation*` migrations, `tests/operational-governance-*.test.mjs` | `node --test tests/operational-governance-concurrency.test.mjs` | `postgres:17` |
| `academy-storage.yml` | `app/api/academy-media/**`, `lib/academy-media*`, `tests/academy-storage*.test.mjs`, `supabase/migrations/**` | `scripts/academy-storage-fixture.mjs` then `node --test tests/academy-storage-runtime.test.mjs` | `postgres:17` + `supabase/storage-api:v1.74.0` + ffmpeg |
| `pricing-ui.yml` | `components/*pricing*`, `lib/commerce/**` | `node scripts/releases/verify-pricing-ui.mjs` (Playwright 1.55.0) | — |
| `core-plan-editor-ui.yml` | `app/control/plans/page.js`, `app/api/platform/plan-editor/**`, `components/core-plan-editor*`, `lib/core-plan-editor.mjs` | `node scripts/releases/verify-plan-editor-ui.mjs` | — |
| `tenant-controls-ui.yml` | `components/platform-tenants.js`, `app/api/platform/tenant-controls/**`, `*tenant_manual_controls*` migrations | `node scripts/releases/verify-tenant-controls-ui.mjs` | — |
| `sales-followup-ui.yml` | `components/sales-followup*`, `lib/sales-followup-details.mjs` | `node scripts/releases/verify-followup-ui.mjs` | — |
| `woocommerce-admissions-ui.yml` | `components/woocommerce-admission*`, `lib/woocommerce-admissions.mjs` | `node scripts/releases/verify-woocommerce-admissions-ui.mjs` | — |
| `woocommerce-beneficiaries-ui.yml` | `components/woocommerce-*`, `app/api/tenant/woocommerce-beneficiaries/**` | `node scripts/releases/verify-woocommerce-beneficiaries-ui.mjs` | — |
| `operational-governance-authenticated-staging.yml` | push to `codex/operational-governance-20260921`; `workflow_dispatch` | `node scripts/releases/verify-operational-governance-staging.mjs` | staging, read-only Supabase tokens |
| `woocommerce-authenticated-staging.yml` | push to `fix/woocommerce-beneficiaries` | `node scripts/releases/verify-woocommerce-authenticated-staging.mjs` | staging, read-only Supabase tokens |

Browser workflows install Playwright into `/tmp` (`npm install --prefix /tmp/...`)
so `package.json` and the lockfile stay untouched; several of them then assert
`git diff --exit-code -- package.json package-lock.json` to prove it. Evidence is
uploaded as an artifact with a 3-day retention (`if: always()`, so failures keep
their evidence).

The two staging workflows are pinned to a single feature branch each and are
inert on `main`.

### Test support directories

| Path | Contents | Used by |
|---|---|---|
| `tests/fixtures/` | schema SQL (`.sql`), DB harnesses (`.mjs`), JSON fixtures | the `-database` and concurrency suites, loaded into disposable PGlite/Postgres |
| `tests/ui/` | browser entry points, harnesses, JS/CSS/Next stubs | jsdom and Playwright component rendering without a full Next server |
| `tests/helpers/` | shared fixture builders | e.g. `woocommerce-beneficiaries-fixture.mjs` |
| `tests/staging/` | rollback SQL only | reference for the staging workflows; not executed by `npm test` |
| `scripts/releases/` | `verify-*.mjs` browser scripts, `verify-pricing-database.py` | the path-filtered UI workflows |
| `scripts/` | `verify-migrations.mjs`, `verify-zoom-ui.mjs`, `academy-storage-fixture.mjs`, `zoom-*-ledger.mjs` | migration check, storage fixture, zoom verification |

### What only runs on a path match

`tests/staging/*.sql` is reference material and is never executed by `npm test`.

Beyond that, every workflow-gated suite in the table above runs only when its
own `paths` filter matches the diff. A change to a file that no filter names
reaches `main` with `npm run check` as the only suite that executed against it —
the 293 files in `tests/` are broad, but a filter is the only thing that
guarantees a dedicated browser or concurrency check for a given area.

## Environment

Split across build time and run time. `NEXT_PUBLIC_*` values are inlined into the
client bundle at build, so changing them requires a rebuild, not a restart.

| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | build + run | the project's Supabase URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | build + run | anon/publishable; public by design |
| `SUPABASE_SECRET_KEY` (or the legacy `SUPABASE_SERVICE_ROLE_KEY`) | run only | never `NEXT_PUBLIC_`; set exactly one name |
| `ODEIR_PUBLIC_APP_URL` | run | the public origin, `https://odeir.com` |
| `ODEIR_REGISTRATION_*`, `ODEIRY_*`, `OPENAI_API_KEY` | run | platform registration and AI; see `.env.example` |
| `ODEIR_REGISTRATION_RATE_SALT` | Edge only | deliberately absent from the Next/Hostinger host |
| `PORT` | run | assigned by the host; `next start` reads it |

### The Vercel-derived database fallback

`lib/config.js` reads `process.env.VERCEL_GIT_COMMIT_REF` to pick between three
Supabase projects, defaulting to the production project
`gswpbwdactcstkasddta` when the branch matches none of the two preview branches.

`VERCEL_GIT_COMMIT_REF` is a Vercel-injected variable. **On Hostinger it is
never set**, so every build and every run falls through to production. A
Hostinger preview deployment, a temporary domain, or a rebuild against a
different branch is not isolated — it points at the live database. The
anon/publishable key does not change that. The isolation problem is recorded in
`docs/zoom/hostinger.md` as isolation point 1 and is still open.

## Origin allowlist

`lib/support-request-origin.mjs` trusts exactly:

```
odeir.com   www.odeir.com   staging.odeir.com
```

over HTTPS with no explicit port, and requires the request `Host` /
`X-Forwarded-Host` to match the `Origin`. A Hostinger temporary or preview domain
is not in the list: the login page will render and the write paths that depend
on this check — training and Zoom requests in particular — will be rejected. A
temporary domain is not a usable test environment until this list changes under
review, or an approved test domain and isolated environment exist.

## Supabase is not part of the Next deploy

Pushing to `main` does not migrate the database and does not publish Edge
functions. Those are separate, individually authorized operations. Concretely:

- Migrations live in `supabase/migrations/` and are checked in CI by
  `npm run migration:verify` (ordering/naming), never applied by a deploy.
- Edge functions live in `supabase/functions/` and are published with
  `supabase functions deploy --project-ref <ref>`.
- Applying them needs a management access token; none of the normal workflows
  carry one.

The three dated payment workflows
(`finalize-payments-production-20260906.yml`,
`export-full-payment-context-20260906.yml`,
`cleanup-payment-release-artifacts-20260906.yml`) are the exception — they hold
`contents: write` and production Supabase tokens and run on push to `main` when
their own file changes. They are dated, self-removing, and the cleanup workflow
that was meant to delete two of them has not run. Treat their presence as
unreviewed surface before changing them.

## Post-deploy verification (manual)

CI green is not a deployment result, and a deployed page is not an accepted
integration. After a `main` build, record:

| Evidence | Where it comes from |
|---|---|
| Source repo, branch `main`, and the deployed SHA | hPanel deployment entry, matched against GitHub |
| Deployment status and completion time | hPanel -> Deployments; GitHub Actions status is not a substitute |
| Build and start health | Node 24, lockfile install, `next build` success, no restart loop |
| Public surface | the public page and `/login` |
| One bounded authorized flow | a synthetic user; no writes against real tenant data |
| Integration layers | report migrations, Edge function, worker and flags each separately |

## Rollback

There is no scripted rollback. Redeploying a known-good SHA through hPanel is
the mechanism, and the host is not assumed to retain previous releases. Keep the
code reference, the environment values and the policy before acting.

Rolling the application back does not undo schema, Edge, or data changes. The
Zoom guidance in `docs/zoom/release.md` applies: feature flags and the tenant
capability gate stop behavior, while existing rows, attendance, payment, and
certificate history stay. No reverse `DROP`, no wholesale restore, no
`reset`/`force push`.

## Known gaps

| Id | Gap | Effect |
|---|---|---|
| G1 | Hostinger builds on the push to `main` without waiting for `quality.yml` | a red CI and a live production build can coexist; nothing in the repo gates the host |
| G2 | `lib/config.js` infers the database from `VERCEL_GIT_COMMIT_REF` | on a non-Vercel host every build targets production, including any preview |
| G3 | build/start command, Node version, `PORT` and env live only in hPanel | a host configuration change is unreviewable in git and invisible to CI |
| G4 | no `output: 'standalone'`, no container definition | the host must retain full `node_modules`; disk and memory headroom is plan-bound |
| G5 | `lib/support-request-origin.mjs` allowlist is production domains only | temporary Hostinger domains fail the write paths that check origin |
| G6 | the three dated payment workflows remain, with `contents: write` and production tokens | unreviewed production-touching automation on the `main` push path |
| G7 | path-filtered suites only run for named paths | a change outside every filter reaches `main` with only `npm run check` behind it |
| G8 | five PostgreSQL concurrency suites are skipped in `quality.yml` | a green Quality run does not prove transaction isolation |
| G9 | no automatic post-deploy smoke test and no rollback workflow | deployment success and rollback are both manual, human-timed steps |
| G10 | `npm test` relies on Node's built-in glob expansion | the suite silently does not match top-level files on Node < 22 |

## Related documents

- `docs/zoom/hostinger.md` — host settings, environment isolation, and the
  pre-deployment verification sequence.
- `docs/zoom/main-publication-2026-09-23.md` — the release authorization and the
  manual Hostinger verification record.
- `docs/zoom/release.md` — release gate, rollback policy, and risk register.
- `docs/deployment/registration-email-auth.md` — the registration activation
  gateway and why the ingress token is absent from the Next/Hostinger host.
- `docs/architecture/supabase-architecture.md` — the database, RPC and RLS model.
