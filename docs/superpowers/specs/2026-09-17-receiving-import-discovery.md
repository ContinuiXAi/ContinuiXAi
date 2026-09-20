# Receiving Import Discovery Gate

**Status:** Discovery protocol approved; interviews, document collection, benchmarking, prototyping, and product build are not yet authorized

**Date:** 2026-09-17

**Owner:** ContinuiXAi product discovery

**Related benchmark:** `docs/research/receipt-ocr-benchmark.md`

## Decision this document makes

ContinuiXAi may investigate whether invoice or packing-slip extraction can reduce receiving work, but it must not build an OCR-backed receiving feature until both the customer-discovery gate and the non-mutating benchmark gate pass.

This document creates no application code, upload endpoint, provider integration, inventory API, or quantity-changing path. No interviews have been completed, no participant has consented, no documents have been collected, no extractor has been benchmarked, and no build authorization exists as of this document's date.

## Product question

Would a review-first document import save enough receiving time, with sufficiently accurate product matching, that small and growing retailers would pay for it without accepting silent inventory errors or a complicated workflow?

The proposed experience is deliberately narrow:

1. An authorized receiving user selects a supplier invoice or packing slip.
2. An extractor proposes document fields and line-item candidates.
3. ContinuiXAi shows every proposed catalog match, quantity, unit, warning, and unmatched line.
4. The user corrects or rejects proposals and explicitly confirms the final set.
5. Only a later, separately authorized implementation may atomically publish confirmed receiving events through the existing inventory ledger.

OCR output is evidence for a human decision. It is never inventory truth by itself.

## Scope boundaries

### Included in discovery

- Interviews with 5–10 people who personally receive or supervise inventory.
- Measurement of receiving frequency, document size, manual-entry time, correction frequency, document types, privacy restrictions, and willingness to pay.
- A vendor-neutral extraction contract for evaluating interchangeable providers later.
- A benchmark protocol using consented, redacted, single-page JPEG or PNG documents.
- Safety and authorization gates for any later prototype or build.

### Excluded until separately authorized

- Application uploads or permanent document storage.
- OCR provider accounts, API calls, contracts, or spending.
- Inventory, purchase-order, payable, product, vendor, or catalog writes.
- Automatic SKU creation or automatic product matching without review.
- Monetary valuation, invoice payment, bookkeeping, tax, or accounts-payable automation.
- PDF, email-inbox, multipage, handwritten, pharmacy/patient, or customer-receipt ingestion.
- Production deployment, PR #21 changes, or changes to an existing inventory workflow.

## Discovery cohort

Recruit 5–10 participants from at least three independent organizations. A valid cohort must include:

- At least three people who personally receive products.
- At least two people who review, reconcile, or manage receiving work.
- At least two operating profiles among retail store, wholesaler/distributor, repacker, or cooperative.
- At least two organizations receiving three or more deliveries per week.
- No more than three participants from one organization.

Recruiting should favor current manual or partly manual processes. People who never enter or reconcile received quantities may provide context, but they do not count toward the five-participant minimum. A quantitative-gate interview also requires a credible total receiving-record/document denominator and corrected-record numerator for the same four complete weeks. A documented best estimate is allowed and labeled estimated; an interview without either value remains qualitative and does not count toward the five valid interviews.

## Frozen commercial discovery hypothesis

Before the first interview, the paid-pilot floor is fixed at **USD 39 per site per month** for a time-limited pilot. This is a conservative low-cost discovery hypothesis chosen to test meaningful willingness to pay while still requiring the feature to support itself rather than relying on a free-pilot signal. It is not a final product price, and no customer or market evidence validates the amount yet.

The threshold may be changed only by a versioned amendment made before recruiting the next cohort. Lowering it after hearing interview responses invalidates earlier commercial-interest evidence unless those organizations are asked again at the revised price.

Projected monthly contribution per pilot site is:

> pilot revenue - extractor charges - retries - storage and egress - payment fees - incremental support and operations - 25% variable-cost contingency

Use the cohort's median observed monthly document volume as expected usage. Until a larger dataset exists, use the highest observed site volume as the conservative p95 proxy. The projection must remain greater than zero at both expected usage and the p95 proxy using mean cost per document for expected usage and p95 cost per document for the p95 proxy. Missing volume, cost, payment-fee, or support estimates make the commercial gate inconclusive, not passed.

## Interview protocol

### Before the interview

1. Explain that this is product research, not a sales commitment or software trial.
2. Obtain the consent described in this document before recording audio, retaining notes linked to a person, or viewing any business document.
3. Ask the participant not to show patient, prescription, customer, payment-card, bank, tax-identification, or employee-personnel information.
4. Schedule 25 minutes and use the questions in order so results remain comparable.
5. Record observed facts separately from opinions and product ideas.

### Novice-friendly interview sheet

Read the introductory sentence exactly:

> We are studying how products are received today. We are not testing you. Please describe the last real delivery you handled, including anything slow, confusing, or corrected later.

Ask each question without suggesting an answer:

1. What is your role, and which parts of receiving do you personally perform?
2. In a typical week, how many deliveries and supplier documents do you handle? For the most recent four complete weeks, how many receiving records or documents did the site process in total?
3. Thinking about the most recent normal delivery, about how many product lines were on the document?
4. What kind of document was it: invoice, packing slip, purchase order, delivery ticket, or something else?
5. How did the received quantities get into your inventory system? Walk through every step.
6. About how many minutes did document entry and product matching take, excluding physically unloading the shipment?
7. Which information did you have to type, scan, look up, or correct?
8. Of those four-week receiving records or documents, how many needed correction after entry? What caused the corrections?
9. What happens when a supplier description, unit, case pack, vendor SKU, or UPC does not match your catalog?
10. What is the safest manual fallback when a document cannot be read or matched?
11. Which document information is sensitive or prohibited from leaving your company or country?
12. Would you allow a redacted supplier document to be used for a one-time accuracy test? Why or why not?
13. If a tool prepared a review screen but changed nothing until you confirmed it, what would you need to see before trusting it?
14. Which error would be worse: leaving a line unmatched or matching it to the wrong product? Why?
15. Before discussing our pilot floor, at what monthly price per site would this be an obvious yes, a decision requiring approval, or a no? After answering, would USD 39 per site per month be acceptable if the accuracy and security gates were met?
16. Would an authorized buyer from your organization state in writing that it is willing to run a time-limited paid pilot at USD 39 or more per site per month if the gates are met?

End with:

> Thank you. Nothing you described authorizes us to use your documents or build the feature. Document use requires separate written consent, and any future product decision will be shared separately.

### Interview scorecard

Complete one scorecard per participant. Do not infer missing answers.

| Pain measure | Record | Score |
| --- | --- | ---: |
| Documents per week | 0–1 / 2–4 / 5–9 / 10+ | 0 / 1 / 2 / 3 |
| Typical lines per document | 1–5 / 6–20 / 21–50 / 51+ | 0 / 1 / 2 / 3 |
| Entry and matching minutes per document | Under 5 / 5–14 / 15–29 / 30+ | 0 / 1 / 2 / 3 |
| Four-week correction rate | Under 1% / 1–2.9% / 3–4.9% / 5%+ | 0 / 1 / 2 / 3 |
| Manual product matching | Never / sometimes / often / nearly every document | 0 / 1 / 2 / 3 |

The participant pain score is the sum of the five rows, from 0 to 15. A score of 8 or higher indicates substantial individual pain.

Record privacy and commercial evidence separately:

| Decision measure | Allowed classification |
| --- | --- |
| Document-use constraint | Cannot use documents / redacted use only / approved processor required / no special constraint |
| Four-week operating denominator | Total receiving records/documents, corrected count, and correction rate |
| Stated monthly price per site | Specific amount before prompting and response to the USD 39 floor |
| Paid-pilot response | Written buyer-authorized yes at USD 39 or more / verbal yes / maybe / no |

Privacy and paid-pilot responses never add points to the pain score. `Cannot use documents` stops document collection for that organization but does not erase valid interview evidence.

For every numeric answer, also retain the raw value when the participant can provide one. Calculate each correction rate as `corrected records / total receiving records` for the same four complete weeks. If multiple participants describe the same site and period, reconcile one site denominator instead of double-counting it. A missing or zero denominator makes that participant's correction rate unscorable. The ranges make comparison easier but do not replace the raw numerator and denominator.

## Customer-discovery advancement gate

Discovery passes only when every condition below is met:

1. At least five valid interviews are completed across at least three organizations.
2. At least 60% of valid participants have a pain score of 8 or higher.
3. At least 60% spend 15 or more minutes per typical document **or** at least 60 minutes per week on document entry and product matching.
4. At least 40% of participants with a valid denominator have an individual four-week correction rate of 3% or higher, and the de-duplicated cohort records have a pooled correction rate of at least 2%.
5. At least two independent organizations, through an authorized buyer, state in writing that they are willing to run a time-limited paid pilot at **USD 39 or more per site per month** after the accuracy and security gates pass. Free interest, a verbal yes, or willingness below the frozen floor does not satisfy this condition.
6. Projected monthly contribution remains positive at both expected and conservative p95-proxy site usage under the frozen formula; an unknown or negative projection fails the gate.
7. At least one permitted document type can be tested without patient, customer, payment, banking, tax-identification, or employee-personnel data.

If any condition fails, the decision is **do not build**. More interviews may be authorized only to resolve a cohort imbalance or a clearly documented ambiguity, not to discard negative feedback.

## Consent, privacy, and redaction

Interview consent and document consent are separate.

### Interview consent

- Obtain affirmative consent before recording audio or video.
- Plain notes may be retained under a participant code; names, personal contact details, and employer names stay in a separate access-controlled contact list.
- A participant may withdraw identifiable notes until results are aggregated.
- Report only aggregate findings unless written permission authorizes a quotation and attribution.

### Document consent

- Obtain written consent naming the document types, purpose, processors if known, retention period, and deletion method.
- Accept only supplier invoices or packing slips that the organization is authorized to share.
- Reject documents containing patient, prescription, customer, payment-card, bank-account, tax-identification, authentication-secret, or employee-personnel data.
- Redact personal names, email addresses, phone numbers, signatures, delivery addresses, account numbers, order references, and free-text notes unless a field is essential to the approved benchmark.
- Keep an unredacted original out of the benchmark. The participant organization performs or approves redaction before transfer.
- Store each source under its owning organization and site; never use a shared, globally addressable object key.
- Limit access to named benchmark operators, log access, encrypt in transit and at rest, and prohibit use for provider training.
- Delete source images, ground-truth text, raw extractor candidates, provider copies, and working files within 30 days of benchmark completion or sooner on withdrawal. Sanitize structured candidates before temporary storage and apply the same or shorter time-to-live.
- Record a content-free deletion event and, where available, provider deletion attestation with tenant, object category, time, operator or automated job, and outcome. A hash or fingerprint is not proof of deletion.
- If duplicate prevention genuinely requires a post-deletion fingerprint and consent permits it, retain only `HMAC(tenant-scoped secret, SHA-256(redacted bytes))` for at most 90 days after deletion. It cannot be searched across tenants. Delete it on withdrawal unless a documented legal or active security-incident basis requires temporary retention; record that basis and expiry. Otherwise retain no document fingerprint.
- If prohibited data is discovered, stop processing and delete the source and content-bearing derivatives immediately. Retain only content-free incident metadata: tenant-scoped case ID, category of prohibited data, detection time, control outcome, deletion attestations, and incident status. Do not retain the prohibited text, image, raw candidate, or reversible fingerprint.

Consent to an interview does not imply consent to share a document. Consent to benchmark a document does not authorize a product build, production use, model training, or inventory changes.

## Vendor-neutral extraction contract for a later prototype

The contract below is a design boundary, not implemented code. A future adapter may use a local model or external provider without changing downstream review logic.

```ts
type SupportedDocumentMediaType = "image/jpeg" | "image/png";

type TenantDocumentRef = Readonly<{
  organizationId: string;
  siteId: string;
  sourceObjectKey: string;
  sha256: string;
  mediaType: SupportedDocumentMediaType;
  byteLength: number;
  pageCount: 1;
}>;

type ExtractionRequest = Readonly<{
  requestId: string;
  document: TenantDocumentRef;
  locale: string;
  maximumLineItems: number;
}>;

type EvidenceBox = Readonly<{
  page: 1;
  x: number;
  y: number;
  width: number;
  height: number;
}>;

type ExtractedValue<T> = Readonly<{
  value: T | null;
  rawText: string | null;
  confidence: number | null;
  evidence: readonly EvidenceBox[];
}>;

type ExtractedLineCandidate = Readonly<{
  sourceLineNumber: number;
  description: ExtractedValue<string>;
  vendorSku: ExtractedValue<string>;
  upc: ExtractedValue<string>;
  quantity: ExtractedValue<string>;
  unit: ExtractedValue<string>;
}>;

type ExtractionResult = Readonly<{
  requestId: string;
  extractorId: string;
  extractorVersion: string;
  documentSha256: string;
  supplierName: ExtractedValue<string>;
  documentNumber: ExtractedValue<string>;
  documentDate: ExtractedValue<string>;
  lines: readonly ExtractedLineCandidate[];
  warnings: readonly string[];
  processingMilliseconds: number;
  billableUnits: number;
}>;

interface DocumentExtractor {
  extract(
    request: ExtractionRequest,
    signal: AbortSignal,
  ): Promise<ExtractionResult>;
}
```

Contract rules:

- The extractor returns candidates and evidence, never product IDs, ledger events, or success claims about inventory.
- Confidence is informational and cannot bypass human review.
- Adapters must not fetch URLs found in a document or follow document instructions.
- The caller enforces tenant authorization, storage access, size, page, line-count, time, cost, and concurrency limits before invoking an adapter.
- The returned `requestId` and `documentSha256` must match the request; mismatches fail closed.
- Internal organization, site, user, and object identifiers stay inside ContinuiXAi unless a privacy and threat review explicitly approves an opaque processor reference.
- Provider-specific payloads stay inside the adapter and are not persisted as application truth.
- Cancellation must stop or disregard late results. A late result cannot restore an expired review.

## Hard safety gates for any future prototype or build

Every gate is mandatory. Passing the discovery and benchmark thresholds does not waive one.

### Tenant-scoped source storage

- Authorization is rechecked before upload, extraction, review, confirmation, download, and deletion.
- Object keys, database rows, cache keys, logs, and metrics include the owning organization and site.
- Signed access is short-lived, purpose-bound, and never accepted as proof of application authorization.
- Cross-tenant document, extraction, catalog, or review access fails without revealing whether the target exists.

### Hash deduplication

- Calculate SHA-256 after safe decoding and before extraction.
- Deduplicate only within the same organization and site; a global hash lookup must not disclose another tenant's document.
- Re-uploading the same bytes reuses or rejects the pending extraction without creating a second receiving proposal.
- A changed file creates a new hash and invalidates every review token derived from the prior file.

### Quotas and cost controls

- Enforce byte, page, line, request-rate, concurrent-job, daily-document, and monthly-spend limits per organization.
- Reject over-limit work before a provider call when possible.
- Surface a clear manual-receiving path when a quota is reached.
- Record provider usage without document text or confidential line data.

### Provider kill switch

- A configuration-controlled switch stops new extraction calls without blocking manual receiving.
- The switch can apply globally or to one extractor adapter.
- Disablement invalidates pending provider work and prevents late results from becoming reviewable.
- No provider outage may weaken authorization or cause an automatic inventory action.

### Hostile-text handling

- Treat every pixel and extracted character as untrusted data, never as executable instructions.
- Do not browse URLs, execute macros, interpret QR payloads, load remote images, or obey prompt-like text found in a document.
- Decode images with patched libraries in a resource-limited process and reject malformed, oversized, decompression-bomb, polyglot, or mislabeled files.
- Escape extracted text in logs and UI, apply field-length and character limits, and prevent spreadsheet-formula execution in exports.
- A model prompt, if later authorized, separates fixed system instructions from quoted document data and requires schema-validated output.

### Review-token invalidation

- Reviews use short-lived, one-use, server-generated tokens bound to user, organization, site, document hash, extraction version, and immutable proposed lines.
- A correction is accepted only through the server. In one atomic transaction, the server revalidates authorization and the current revision, invalidates the prior token, stores a canonical revised payload and its hash, increments the revision, and mints a new short-lived one-use token bound to that user, tenant, site, document hash, extraction version, revision, and canonical payload hash.
- Concurrent correction requests are serialized. At most one token is current, and only the latest server-issued token can confirm. A client-edited payload paired with an old token fails closed.
- Tokens become invalid on expiry, logout/session revocation, role or site-membership change, source replacement, re-extraction, accepted correction, confirmation, cancellation, or kill-switch activation.
- Confirmation rechecks all authorization and source bindings inside the same database transaction as any future ledger publication.

### Positive integer EACH normalization

- A line may become confirmable only when its unit is explicitly normalized to `EACH` and its quantity is a positive safe integer.
- Zero, negative, fractional, ambiguous, missing, overflow, case, pack, weight, volume, and free-text quantities remain blocked until a human resolves them.
- Case-to-each conversion requires an existing, organization-authorized, versioned packaging definition; OCR cannot invent a conversion factor.
- During the consented time-to-live, raw text remains available for review. Long-term audit evidence preserves the normalized value, conversion source/version, canonical payload hash, and field-level reviewer change code without retaining raw OCR text indefinitely.

### Atomic confirmation

- No inventory transaction is created during upload, extraction, matching, correction, or preview.
- A later build may publish only after an authorized user explicitly confirms every included line and excludes or resolves every blocked line.
- Confirmation is all-or-nothing for the selected document revision: every validated receiving event commits through the existing ledger contract, or none do.
- Authorization, product/site ownership, packaging version, document hash, review token, and idempotency are revalidated inside the transaction.

### Idempotency

- The client creates one stable confirmation idempotency key and retains it across retries and ambiguous responses.
- The server enforces a database uniqueness constraint scoped to the owning organization and confirmation operation.
- Reusing a key with a different document hash or payload is rejected; a true replay returns the original outcome.
- Provider request IDs do not serve as inventory idempotency keys.

### Reversal and auditability

- Confirmed receiving events are immutable.
- A mistake is corrected by an authorized compensating reversal linked to the original confirmation and followed, when necessary, by a corrected receipt.
- The audit trail retains tenant-scoped source identity, extraction version, canonical payload hashes, field-level change codes, final normalized matches, actor, time, site, idempotency identity, and reversal reason. Raw text and raw candidates follow the consented time-to-live and are not retained indefinitely as audit data.
- Reversal never deletes the original ledger evidence.

### Manual fallback

- Manual receiving remains available when extraction is disabled, slow, over quota, low-confidence, unmatched, malformed, or rejected.
- The fallback does not require re-uploading a document or waiting for a provider timeout.
- Users can type or scan product and quantity through the same authorization, validation, idempotency, and audit controls as any future confirmed import.
- No safety gate may be bypassed by relabeling an OCR proposal as manual input.

## Authorization ladder

Advancement is sequential:

1. **Interview authorization:** permits recruiting and interviews only.
2. **Document-benchmark authorization:** permitted only after written document consent and privacy review; remains non-mutating.
3. **Prototype authorization:** requires the customer-discovery and benchmark gates to pass; remains isolated and non-mutating.
4. **Build authorization:** requires a reviewed design covering the hard safety gates, data retention, cost ceiling, provider terms, threat model, and failure recovery.
5. **Inventory-write authorization:** requires separate adversarial review, real PostgreSQL concurrency/idempotency proof, tenant-isolation tests, novice usability testing, and explicit approval. It is not granted by this document.
6. **Production authorization:** requires explicit deployment approval and is outside this discovery task.

## Current evidence and decision

| Evidence | Current verified status |
| --- | --- |
| Valid interviews completed | 0 |
| Organizations represented | 0 |
| Written paid-pilot interest at USD 39 or more | 0 |
| Projected unit economics | Not calculated |
| Consented benchmark documents | 0 |
| Provider or local extractor runs | 0 |
| Benchmark metrics | Not measured |
| Prototype authorization | Not granted |
| Build authorization | Not granted |
| Inventory-write authorization | Not granted |

**Current decision: remain in discovery. Do not build or integrate invoice OCR.**
