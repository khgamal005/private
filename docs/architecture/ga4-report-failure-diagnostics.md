# GA4 report failure diagnostics

## Evidence and gate

Marktone's 17 September 2026 setup successfully discovered properties and web streams and saved the selected property/site. The subsequent sync failed with `ga4_request_failed`; the existing adapter discarded the provider status and failure stage. No evidence yet identifies the rejected field combination or a permission problem. Do not claim the underlying report rejection is fixed by this change.

Difficulty 3/10. This patch adds a finite diagnostic vocabulary and corrects misleading interface copy. No schema migration, OAuth scope change, tenant activation, report field change, operational mutation, Meta change or Reef production data operation is included. Existing authorization, leases, snapshot preservation and query boundaries remain intact.

## Diagnostic boundary

Read at most 64 KiB of an unsuccessful provider response. Only an `INVALID_ARGUMENT` message of at most 4,096 characters can contribute a diagnostic classification and a field from the fixed GA4 schema allowlist. Persist only the generated lowercase code (under 100 characters) using the existing failed-run error column. Never persist or return provider messages, IDs, request/response bodies, tokens, URLs or personal data. Codes distinguish transaction versus traffic reports and invalid, incompatible, missing-resource, unavailable and other rejected requests. Authentication, scope, API-disabled and quota handling remain separate.

One shared pure module defines the complete allowlist, adapter classification and Arabic messages. Unknown or forged diagnostic codes fail closed. The setup screen states that configuration is saved, rather than claiming Analytics is already working before a successful sync.

## Verification and continuation

Tests cover bounded malformed/oversized errors, finite field filtering, code spoofing, stage-specific failures, permission/quota regressions and failed-run completion with no partial snapshot. Deploy the complete six-file Edge bundle to staging, verify source/auth rejection, pass full Quality CI, then publish through the existing authorized release path. Preserve all stored settings and observations. Rollback restores the prior Edge and frontend bundle; no data rollback is needed.

A fresh authenticated sync by the manager is needed after publication to observe the provider's current safe diagnostic. Use that evidence to repair the precise request contract; do not weaken site filters, remove fields speculatively or silently report zeroes.
