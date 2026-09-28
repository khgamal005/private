# Marktone Platform Control - Architecture Overview

## Executive Summary

Marktone Platform Control is a multi-tenant SaaS control plane built on Next.js 16, designed to manage educational and training institutions. The platform provides a unified administrative interface for platform operators and isolated tenant workspaces for individual organizations.

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16.3 (App Router) |
| Frontend | React 19.2, CSS Modules |
| Backend | Next.js API Routes + Supabase RPC |
| Database | PostgreSQL (Supabase) |
| Authentication | Supabase Auth with cookie-based sessions |
| Validation | Zod 4.4 |
| AI Integration | OpenAI Agents SDK |
| Deployment | Vercel |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Vercel Edge Network                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Next.js Application                       │   │
│  │                                                              │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │   │
│  │  │   /control  │  │/tenant/[slug]│  │  Public Routes      │  │   │
│  │  │  Workspace  │  │  Workspace   │  │  /login, /pricing   │  │   │
│  │  └──────┬──────┘  └──────┬──────┘  └─────────────────────┘  │   │
│  │         │                │                                  │   │
│  │  ┌──────┴────────────────┴──────────────────────────────┐   │   │
│  │  │                   /api/* Routes                      │   │   │
│  │  │   Auth, CRM, Commerce, Academy, Zoom, etc.           │   │   │
│  │  └────────────────────────┬─────────────────────────────┘   │   │
│  └───────────────────────────┼─────────────────────────────────┘   │
│                              │                                     │
└──────────────────────────────┼─────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Supabase (PostgreSQL)                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐  ┌───────────────┐  ┌─────────────┐  ┌─────────┐  │
│  │    core     │  │access_control │  │   catalog   │  │audit_log│  │
│  │  (tenants,  │  │  (subjects,   │  │  (plans,    │  │ (audit  │  │
│  │   domains)  │  │ memberships)  │  │subscriptions)│  │ events) │  │
│  └─────────────┘  └───────────────┘  └─────────────┘  └─────────┘  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              RPC Functions (v2_, v3_, v4_ prefixed)         │   │
│  │              Row Level Security (RLS) enabled               │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
marktone-platform-control/
├── app/                      # Next.js App Router pages
│   ├── control/              # Platform admin workspace
│   │   ├── tenants/          # Tenant management
│   │   ├── subscriptions/    # Subscription management
│   │   ├── marketplace/      # Marketplace oversight
│   │   ├── plans/            # Plan configuration
│   │   └── ...
│   ├── tenant/[slug]/        # Isolated tenant workspaces
│   │   ├── sales/            # CRM & sales
│   │   ├── courses/          # Course management
│   │   ├── marketing/        # Marketing tools
│   │   ├── team/             # Team management
│   │   └── ...
│   ├── api/                  # API route handlers
│   │   ├── auth/             # Authentication
│   │   ├── crm/              # CRM operations
│   │   ├── platform/         # Platform admin APIs
│   │   ├── tenant/           # Tenant-specific APIs
│   │   └── ...
│   ├── academy/              # Academy delivery system
│   ├── training/             # Training portal
│   └── site/                 # Public website
│
├── components/               # React components
│   ├── academy-*.js          # Academy components
│   ├── cms-*.js              # CMS components
│   ├── platform-*.js         # Platform admin components
│   └── tenant-*.js           # Tenant workspace components
│
├── lib/                      # Business logic & services
│   ├── server-auth.js        # Authentication & authorization
│   ├── platform-api.js       # Platform admin APIs
│   ├── config.js             # Environment configuration
│   ├── cms.js                # CMS operations
│   ├── commerce-api.js       # Commerce logic
│   ├── academy-*.js          # Academy services
│   └── odeiry-*.js           # AI assistant services
│
├── supabase/                 # Database layer
│   ├── migrations/           # Schema migrations
│   ├── functions/            # Edge functions
│   └── changes/              # Schema change tracking
│
├── docs/                     # Architecture documentation
│   ├── architecture/         # System design docs
│   ├── deployment/           # Deployment guides
│   └── engineering/          # Engineering standards
│
└── tests/                    # Test suites
```

---

## Core Workspaces

### 1. Control Workspace (`/control`)

The platform administration interface for Marktone operators. Provides:

- **Tenant Management**: Provision, configure, and monitor tenant organizations
- **Subscription Oversight**: Manage plans, subscriptions, and billing
- **Marketplace Administration**: Oversee the addon marketplace
- **Team Management**: Platform staff and permissions
- **Integration Hub**: Manage third-party integrations
- **Support Desk**: Platform-wide support requests

**Key Modules:**

| Path | Purpose |
|------|---------|
| `/control/tenants` | Tenant provisioning and status |
| `/control/subscriptions` | Subscription management |
| `/control/plans` | Plan configuration |
| `/control/marketplace` | Addon marketplace |
| `/control/team` | Platform staff management |
| `/control/website` | Platform website CMS |

### 2. Tenant Workspace (`/tenant/[slug]`)

Isolated workspace for each tenant organization. Each tenant has access to:

- **Sales & CRM**: Lead management, customer relationships, sales pipeline
- **Courses & LMS**: Course delivery, learner management
- **Marketing**: Campaign management, Google Ads integration
- **Team**: Staff management and role assignments
- **Knowledge Base**: Internal knowledge management
- **Finance**: Accounting, payments, incentives
- **Website Builder**: CMS for tenant websites
- **Operations**: Task management, calendar

**Key Modules:**

| Path | Purpose |
|------|---------|
| `/tenant/[slug]/sales` | CRM and sales pipeline |
| `/tenant/[slug]/courses` | Course and program management |
| `/tenant/[slug]/marketing` | Marketing campaigns |
| `/tenant/[slug]/team` | Team and user management |
| `/tenant/[slug]/settings` | Tenant configuration |
| `/tenant/[slug]/website` | Website builder |

---

## Authentication & Authorization

### Session Management

- Cookie-based sessions (`mt_access`, `mt_refresh`)
- Supabase Auth for token validation
- Automatic session refresh on expiry

### Authorization Flow

```
Request → server-auth.js
    │
    ├── accessToken() → Extract token from cookie
    │
    ├── authRpc() → Call Supabase RPC with token
    │       │
    │       ├── 401 → Redirect to /login
    │       ├── 403 → Redirect to /login?reason=forbidden
    │       └── Success → Return data
    │
    └── getContext() → Cache user context (React cache)
            │
            ├── platformPermissions
            ├── memberships (tenant access)
            └── subject info
```

### Permission System

```javascript
// Platform-level permissions
hasPlatformPermission(context, 'platform.control.read')
hasPlatformPermission(context, 'platform.support.manage')

// Tenant-level permissions
requireTenantPermission(slug, 'tenant.workspace.read')
requireTenantAddon(slug, 'GOALS_INCENTIVES', { permission: 'tenant.incentives.read' })
```

### Key Authorization Functions

| Function | Purpose |
|----------|---------|
| `accessToken()` | Get session token from cookie |
| `authRpc(name, body)` | Call RPC with auth token |
| `getContext()` | Get cached user context |
| `requirePlatform()` | Require platform access |
| `requirePlatformPermission(perm)` | Require specific platform permission |
| `requireTenant(slug)` | Require tenant membership |
| `requireTenantPermission(slug, perm)` | Require tenant permission |
| `requireTenantAddon(slug, keys)` | Require addon enabled |

---

## Key Modules

### 1. Academy System (`lib/academy-*.js`)

Learning management and course delivery:

- Course authoring and scheduling
- Learner enrollment and progress tracking
- Media upload and management
- Commerce integration for paid courses
- Navigation and public-facing pages

**Key Files:**

| File | Purpose |
|------|---------|
| `academy-server.js` | Server-side academy operations |
| `academy-authoring.js` | Course authoring logic |
| `academy-delivery.js` | Course delivery to learners |
| `academy-commerce.js` | Paid course integration |
| `academy-people.js` | Learner management |

### 2. Commerce & Billing (`lib/commerce-*.js`)

Monetization infrastructure:

- Subscription management
- Payment provider integrations (Paymob, Tamara)
- Order processing
- Invoice generation

**Payment Providers:**

| Provider | Type | Integration |
|----------|------|-------------|
| Paymob | Card payments | `paymob-checkout` Edge Function |
| Tamara | BNPL (Buy Now Pay Later) | `tamara-checkout` Edge Function |

### 3. CMS & Website Builder (`lib/cms*.js`)

Content management for tenant websites:

- Page builder with native templates
- Template import system
- Publication workflow
- Media management

**Key Components:**

| Component | Purpose |
|-----------|---------|
| `page-builder.js` | Visual page editor |
| `cms-studio.js` | CMS administration |
| `native-template-section.js` | Template sections |
| `imported-template-runtime.js` | Imported templates |

### 4. Odeiry AI Assistant (`lib/odeiry-*.js`)

AI-powered assistance:

- Manager panel for configuration
- Knowledge query processing
- Safe operations guard
- Operational guide integration

**Key Files:**

| File | Purpose |
|------|---------|
| `odeiry-manager.js` | Tenant AI management |
| `odeiry-agent.js` | AI agent implementation |
| `odeiry-request-guard.js` | Request validation |
| `odeiry-viewer-context.js` | Context building |

### 5. Zoom Integration (`lib/zoom-*.js`)

Video conferencing:

- Account management
- Lecture scheduling
- Recording retention
- AI meeting assistant

**Key Files:**

| File | Purpose |
|------|---------|
| `zoom-server.js` | Server-side Zoom operations |
| `zoom-snapshot.js` | Meeting snapshots |
| `zoom-ai.js` | AI meeting features |
| `zoom-setup.js` | Integration setup |

---

## API Architecture

### Route Organization

```
/api
├── auth/           # Authentication endpoints
├── platform/       # Platform admin APIs
├── tenant/         # Tenant-specific operations
├── crm/            # Customer relationship management
├── academy-auth/   # Academy authentication
├── academy-commerce/ # Academy payments
├── commerce/       # Commerce operations
├── payments/       # Payment processing
├── cms/            # Content management
├── zoom/           # Zoom integration
├── odeiry/         # AI assistant endpoints
├── paymob-checkout/ # Paymob payment flow
├── tamara-checkout/ # Tamara payment flow
└── woocommerce/    # WooCommerce sync
```

### Request Flow

```
Client Request
    │
    ▼
API Route Handler
    │
    ├── Validate session (server-auth.js)
    ├── Check permissions
    ├── Call Supabase RPC
    └── Return JSON response
```

### API Route Pattern

```javascript
// Example: app/api/tenant/route.js
import { authRpc, requireTenant } from '@/lib/server-auth';

export async function POST(request) {
  const { slug } = await request.json();
  const context = await requireTenant(slug);
  
  const data = await authRpc('v2_tenant_snapshot', {
    p_slug: slug
  });
  
  return Response.json(data);
}
```

---

## Security Headers

Configured in `next.config.mjs`:

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

### Cache Headers

| Route Type | Cache Policy |
|------------|--------------|
| Auth pages (`/login`, `/forgot-password`) | `s-maxage=300` |
| Protected pages (`/control`, `/tenant`) | `no-store` |
| API routes | `no-store` |

---

## Deployment

### Environment Configuration

```javascript
// lib/config.js
SUPABASE_URL          // Database endpoint
SUPABASE_KEY          // Publishable key
ACCESS_COOKIE         // Session cookie name ('mt_access')
REFRESH_COOKIE        // Refresh token cookie ('mt_refresh')
```

### Branch-Based Environments

- Production: Default Supabase project
- Preview branches can target different databases
- Feature flags via Git branch detection

**Example:**

```javascript
const GOALS_PREVIEW_BRANCH = 'agent/goals-incentives-v2';
const GIT_BRANCH = process.env.VERCEL_GIT_COMMIT_REF;
const IS_GOALS_PREVIEW = GIT_BRANCH === GOALS_PREVIEW_BRANCH;
```

---

## Development Workflow

```bash
npm ci              # Install dependencies
npm run dev         # Start development server
npm run lint        # Run ESLint
npm run typecheck   # TypeScript validation
npm test            # Run tests
npm run build       # Production build
npm run check       # Full validation suite
```

### Available Scripts

| Script | Purpose |
|--------|---------|
| `dev` | Start development server |
| `build` | Production build |
| `start` | Start production server |
| `lint` | Run ESLint |
| `typecheck` | TypeScript validation |
| `test` | Run test suite |
| `migration:verify` | Verify database migrations |
| `check` | Full validation (lint + typecheck + test + build) |

---

## Extension Points

### Addon System

Tenants can enable addons:

| Addon Key | Purpose |
|-----------|---------|
| `GOALS_INCENTIVES` | Goals and incentives module |
| `YEASTAR` | VoIP integration |
| `WOOCOMMERCE` | E-commerce sync |
| `ZOOM` | Video conferencing |
| `ZATCA` | Saudi tax compliance |
| `LMS` | Learning management |

### Integration Hub

Supports third-party integrations:

| Integration | Purpose |
|-------------|---------|
| Google Ads | Advertising campaigns |
| Google Analytics (GA4) | Analytics |
| WooCommerce | E-commerce sync |
| Zoom | Video conferencing |
| Yeastar | VoIP telephony |
| Tamara | BNPL payments |
| Paymob | Card payments |
| Meta | Social media |

---

## Design Principles

1. **Multi-tenancy first**: Complete data isolation between tenants
2. **Security by default**: RLS on all tables, deny-by-default access
3. **Minimal client-side logic**: Server components preferred
4. **Audit trail**: All privileged operations logged
5. **Graceful degradation**: Fallbacks for permission-denied states
6. **Incremental enhancement**: Modules loaded as needed

---

## Future Architecture

According to the v2 roadmap:

- CRM will be rebuilt as v2 module
- Unified work/tasks system
- Incentives module redesign
- Content targeting system
- Market Mirror feature

**Legacy Schema Deprecation:**

Legacy schemas (`platform`, `identity`, `billing`, `crm`, `operations`, `engagement`) are deprecated and will be removed after workspace cutover verification.

---

## Related Documentation

- [Supabase Architecture](./SUPABASE_ARCHITECTURE.md) - Database and security details
- [Clean Foundation v2](./architecture/clean-foundation-v2.md) - v2 design principles
- [Deployment Guides](./deployment/) - Deployment documentation
- [Engineering Standards](./engineering/) - Development standards
