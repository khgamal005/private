# GA4 permission diagnostics and recovery

## Evidence and scope

Google Ads connection and synchronization are working. A read-only check of the affected tenant showed stored Analytics read consent and a failed GA4 `discover` operation. The adapter discarded every HTTP 403 response body and reported `ga4_access_denied`, so the stored event cannot distinguish disabled APIs from missing consent or permissions. A synthetic `SERVICE_DISABLED` response reproduced that incorrect classification before this fix. Disabled Admin API is a likely setup cause, not a confirmed fact about the Cloud project's current enablement.

## Engineering gate

Difficulty: 3/10. Reuse the existing GA4 adapter, user-authorized leased operations, safe error allowlist and Google Kit settings. No schema migration, backfill, credential rotation, tenant-data repair or RLS changes. No Reef data operations. No Meta integration or API changes; global toast translation is limited to same-origin Google Kit API paths.

- For HTTP 403 only, read at most 64 KiB of the response and inspect at most 20 structured `google.rpc.ErrorInfo` details from `googleapis.com`. Classify exact `SERVICE_DISABLED` by the fixed Admin/Data endpoint being called, and exact `ACCESS_TOKEN_SCOPE_INSUFFICIENT` as consent required. Unknown or malformed errors keep a generic access-denied explanation. Provider text, project metadata, activation URLs and tokens are never returned or logged.
- Preserve authentication, transaction claims, lease checks, retries, report pagination, store/hostname checks and atomic storage. Failed discovery still finishes with an empty unsuccessful payload and preserves existing snapshots.
- Show Arabic instructions in both inline feedback and the existing global toast. Do not replace all 403 errors with a request for tenant-role changes. Other API toast behavior stays unchanged.
- If Google reports revoked/missing Analytics consent after earlier consent was saved, show the GA4 reconnect button in settings. The existing OAuth flow and `includeAnalytics` flag remain authoritative.

## Validation and release

Regression tests cover Admin vs Data disabled errors, missing scope, generic permission errors, arbitrary error text, unknown detail types/domains, malformed/oversized response bodies, leased failure completion, consent recovery and global feedback isolation. Existing Ads, Reef, GA4 pagination and report tests are required. Full CI is required before production deployment.

Deploy the complete existing five-file function bundle with only the GA4 adapter and public error allowlist updated. Stage first and check unauthorized calls before production release; publish the UI through the normal main/Hostinger pipeline. Rollback is a commit revert plus redeployment of the inspected production version 10 bundle. There is no data rollback.

The owner must verify that Google Analytics Admin API and Google Analytics Data API are enabled in the OAuth client's Cloud project. Central API enablement is separate from tenant consent. This code change does not grant Google Cloud permissions or enable APIs. Final live GA4 loading requires a fresh authorized discovery attempt.

## Primary references

- https://developers.google.com/analytics/devguides/config/admin/v1/quickstart
- https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart
- https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list
- https://google.aip.dev/193
