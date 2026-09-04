# Paymob Hosted Redirect v2

ODEIR uses one deliberately small Paymob adapter, comparable to the normal
hosted-payment pattern used by mature commerce plugins:

1. The authenticated tenant creates an immutable ODEIR order.
2. The server prepares one idempotent payment attempt from database prices.
3. The Edge adapter creates a Paymob QuickLink using `multipart/form-data`.
4. ODEIR persists the Paymob identifiers and the expiring redirect before the
   checkout URL is returned to the browser.
5. The browser leaves ODEIR and pays on Paymob's hosted page.
6. A signed Paymob webhook is the only source that can settle the order and
   activate the purchased add-on. The redirect page is display-only.

## Configuration

- Environment: Sandbox or Live.
- API Key: server/Vault only.
- HMAC Secret: server/Vault only.
- Merchant Account ID.
- Card/Mada Integration ID.
- Optional Apple Pay Integration ID.
- Region and currency are pinned to KSA and SAR.

Secret Key and Public Key are not part of this adapter. Historical values may
remain encrypted for old Intention records, but they are optional and cannot
block QuickLink checkout.

## Isolation and rollback

The adapter reuses the governed ODEIR order, attempt, webhook, reconciliation,
audit and entitlement ledgers. It does not create a parallel source of truth.
Tenant rollout remains deny-by-default, Reef Skills remains explicitly excluded,
and disabling the tenant or global rollout stops new checkout without deleting
historical orders. The previous Intention code remains unavailable through the
administration contract and can be restored only by a reviewed migration and
deployment.
