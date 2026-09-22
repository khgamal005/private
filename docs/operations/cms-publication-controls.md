# CMS publication controls

The reported 404 was caused by a published homepage inside a draft site. The
Marktone site was published through the existing audited CMS action; its public
homepage now returns HTTP 200 and renders the homepage and academy navigation.
No Reef records or subscription settings were changed.

The studio now distinguishes site availability from page publication and saved
draft changes. It offers explicit site publication and publication of the saved
page from the list. It never publishes the site automatically when publishing a
page, and never replaces a saved draft with client-supplied list data.

## Database boundary

Apply `20260922163848_cms_publication_controls.sql` before deploying the UI. The
new RPC uses the existing CMS site resolver, publication ACL, builder publication
action and audit log. Page/document locks and the expected saved-draft timestamp
prevent publishing a concurrently changed draft. Site publication requires an
accessible published builder homepage and preserves all other site settings.
The existing settings action now also requires publication permission when
changing site status. The migration does not publish or activate any records.

Rollback the application to the previous version if needed. The additive RPC
can remain unused; retain the settings permission check. Do not delete content,
versions, audit records or tenant data. Unpublishing the actual site is a separate
explicit content decision.

## Verification

- ESLint on touched code, TypeScript and production build passed locally.
- 44 focused CMS/builder tests passed, including saved-draft conflicts, missing
  homepage, denied editor/anonymous publication, foreign page IDs and preserving
  the site's name/domain. The SQL fixture uses real academy ACLs and stubs the
  pre-existing builder version-recording seam; it is not a live-user login test.
- Public production homepage was inspected in the browser after publication.

The synthetic browser entry is `tests/ui/cms-publication-browser-entry.jsx`.
Bundle it with the same webpack/CSS/Next stubs as the academy browser harness.
Query examples: `?section=pages`, `?section=pages&site=published&changes=1`,
`?section=pages&role=editor`, and `?section=pages&page=draft`. Network requests
are intercepted inside this disposable fixture and rendered in `fixture-result`;
they never reach the live APIs.
