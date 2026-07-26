# Database source

`migrations/` contains the clean v2 foundation for Marktone Platform Control.
It creates the new `core`, `access_control`, `catalog`, and `audit_log` schemas.

The legacy schemas are not a dependency of v2 and no legacy tenant or CRM data
is copied into the new foundation. They remain temporarily in the linked
development project only to make the cutover reversible.

All client access goes through authenticated RPCs. Application tables are
deny-by-default, use RLS, and are not exposed directly to `anon` or
`authenticated`.
