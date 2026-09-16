# ODEIR training journey — NeLC implementation decisions

Research date: 2026-09-16. Scope: Marktone pilot; proposed code decisions, not a certification assessment. Sources below are primary official sources. No tenant data, credentials, or application state were changed.

## Regulatory routing — critical 2026 change

NeLC announced on 25 March 2026 that private-sector training providers obtain program licenses through TVTC after completing FutureX technical integration, effective May 2026. NeLC retains oversight of digital-learning standards. The engineering workflow must therefore support issuer and licensing route metadata rather than hardcoding a separate NeLC program application for every private training course. Confirm the actual Marktone entity/program route with its licensing records. [Official announcement](https://nelc.gov.sa/en/media-center/news/unified-e-learning-licensing-private-sector-en)

Program licensing and platform/provider accreditation are distinct. Implementing Rules articles 7–9 cover programs delivered remotely or blended, synchronously or asynchronously; articles 18–23 separately govern support-service providers, including platforms. Article 9 requires technical integration/data sharing. Article 11 covers intellectual property, beneficiary remedies, changes and ongoing compliance. Article 6 says the delivery mode should not appear on certificates from covered licensed programs. Public-sector shared-resource requirements in articles 24–29 must not be presented as universal private-center obligations. [Implementing Rules](https://nelc.gov.sa/en/regulations-and-standards/elearning-executive-rules)

## Official standards mapping

The following are published requirements; exact evidence and applicability remain tied to the entity, program and accreditation route. [NeLC eLearning Standards](https://nelc.gov.sa/en/regulations-and-standards/elearning-standards)

| Area | Official requirement / section |
|---|---|
| Attendance | Mode-specific published policy, documented monitoring, excuses and technical interruption procedures (§1.3). |
| Course onboarding | Outcomes, admission criteria, assessment weights and workload available before enrollment (§2.4). |
| Content | Ordered modules, accessibility, review before publication; human validation of AI content (§§2.1–2.3). |
| Assessment | Risk-appropriate impersonation controls, rubrics, grading, appeals; human approval of AI-assisted assessment (§§4.1–4.2). |
| Platform | Accredited learning platform; device compatibility and delivery-mode support (§5.1). |
| Integration | FutureX technical integration and educational-data sharing (§5.5). |
| Identity | Risk-based verification including MFA/equivalent; SSO across systems; least privilege and revocation (§5.6). |
| Audit / resilience | Sensitive-operation/security logging, incident handling, backup/recovery, continuity and capacity planning (§§5.3,5.6). |
| Support | Published support channels, hours, response periods and ticket escalation (§§6.2,7.1). |
| Accessibility | Alternative formats and assistive support responsive to learner needs (§6.4). |
| Quality | Satisfaction, engagement, attendance, achievement and completion measurement; documented improvement (§8). |

## Integration evidence and limits

FutureX publishes a Technical Integration service assessing entity readiness and the learning platform, with a linked official manual. The service page is current to 3 August 2026. [Technical Integration service](https://futurex.sa/en/services/Technical-Integration)

The official integration portal's indexed guide identifies xAPI; indexed text says the first learning-journey event is `registered`, followed by `initialized` when learning begins. Its separate checklist calls for a registration statement for each journey and lifecycle coverage. An indexed provider-entities page describes join/left reporting separately. Full pages returned HTTP 403 in this environment, so the exact payload schema, endpoint, actor identity mapping, required verbs and certification fixtures were **not validated**. Do not build a purported compliant connector from search snippets. Obtain the current official contract and test credentials through the service. [Guide](https://integration.nelc.gov.sa/integration-guide.html), [validation checklist](https://integration.nelc.gov.sa/validation-checklist.html), [provider entities](https://integration.nelc.gov.sa/lms-provider-entities.html)

## Proposed engineering decisions — ODEIR design, not prescribed regulator implementation

1. **Keep admission, payment and academic state separate.** Payment confirmation or approved corporate credit grants eligibility for content access; it never fabricates attendance, assessment success or completion. Corporate invoicing stays on the sponsor account; academic evidence belongs to each named learner.
2. **Version completion policy by course offering.** Store the approved policy version on enrollment, with independent live attendance, asynchronous activity, assessments and required assignments. Do not silently modify enrolled learners' requirements when a course template changes.
3. **Preserve defensible evidence.** Record provider session ID, learner identity binding, actual joined/left intervals and source. Deduplicate overlapping intervals and reconnections. Capture content activity and assessment evidence independently of elapsed open-tab time. Authorized corrections add reason/actor/time rather than replacing historical facts.
4. **Make thresholds explicit, never regulatory guesses.** No universal attendance percentage, synchronous-hours ratio, pass mark, retention duration, learner-teacher ratio, SCORM requirement, Nafath-only requirement or video-recording requirement was established by the cited documents. Configure approved rules and preserve their authority/evidence. Existing sample 70% or 80% values must not be labelled NeLC requirements.
5. **Use the user-approved seven-day installment grace as an ODEIR commercial policy.** Publish and record acceptance before enrollment. Suspend only new learning access after the deadline; keep payment, support, appeals, existing history and progress available. Restoration re-evaluates eligibility without re-enrollment or duplicate finance entries.
6. **Bind all actions to tenant + enrollment + actor.** Learners see their own records; instructors only their assigned offerings; sponsor representatives only authorized sponsored learners. Employee role preview must never act as a real learner or generate learning evidence. Use separately authenticated learner/instructor identities for live operation.
7. **Certificate eligibility must be evaluated server-side.** Combine academic evidence, approved certificate policy, necessary finance clearance and authorization. Save the evidence/policy snapshot and issuer at issuance; provide correction/revocation history. Certificate labels/logos must derive from verified approvals, not a readiness toggle.
8. **Build an integration outbox before a live connector.** Canonical learning events have stable IDs and ordering, isolated by tenant/provider credentials. Use retriable deliveries, acknowledgements, rejection details and reconciliation. An event queued locally is not a successfully reported FutureX event. Keep outbound delivery disabled until the official contract and sandbox pass are available.
9. **Operational exceptions are owned tasks.** Paid-but-unassigned, unpaid-after-grace, attendance dispute, overdue grading, certification pending and connector failure have owner, due time, reason and resolution history. Transfers link old/new enrollment and explicitly approved equivalent learning units; they do not mark a different course complete.
10. **Readiness is evidence-backed.** Track identity setup, program/provider authorization, course review, policy publication, support ownership, accessibility testing, retention/backup approvals and FutureX acceptance independently. Removing verbose prototype warnings must not convert readiness into an accreditation claim.

## Release acceptance evidence to collect

- One isolated Marktone journey per supported delivery mode: self-paced, live and blended; one individual and one corporate-sponsored registration.
- Replay of the same payment confirmation produces one recognized payment and one access transition; credit authorization is attributed and auditable.
- Grace expiry/restoration, transfer, withdrawal and grading appeal preserve the original learning/finance trail.
- Cross-tenant, unrelated instructor, sponsor and preview-role denials; no Reef fixtures or data mutations.
- Keyboard/screen-reader/mobile checks; learner can find requirements, feedback, payment and support without changing context.
- No certificate completion from payment alone, fabricated attendance, admin preview or unreviewed AI output.
- FutureX production delivery remains unclaimed until contracted schema, credentials, validation and accepted journey evidence exist.

Open external inputs: actual Marktone/ODEIR provider accreditation and license records, official current integration contract, tenant-approved retention policy, operational SLA owners, course-specific completion rules. These are implementation inputs to model and record, not grounds to delay useful isolated software work.
