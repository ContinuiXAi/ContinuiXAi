# Receipt and Invoice OCR Benchmark Protocol

**Status:** Protocol only; no documents collected and no benchmark executed

**Date:** 2026-09-17

**Decision dependency:** `docs/superpowers/specs/2026-09-17-receiving-import-discovery.md`

## Purpose

This protocol measures whether a document extractor can prepare a trustworthy, reviewable receiving draft. It does not authorize uploads in the ContinuiXAi application, provider spending, product creation, or inventory writes.

The benchmark is non-mutating by construction. It may read an isolated, tenant-scoped catalog snapshot solely to score product-match candidates. It cannot connect to an inventory-write credential, call a quantity-changing API, or create an `InventoryTransaction`.

No interviews, document consents, source images, ground-truth labels, provider results, costs, or latency measurements exist yet. Every result table described below starts empty and may be populated only from a separately authorized benchmark run.

## Questions the benchmark must answer

1. Can an extractor recover document identity and line-level product clues accurately from permitted supplier documents?
2. Can deterministic catalog matching achieve very high precision while leaving uncertainty unmatched?
3. Is the review draft faster than manual entry without hiding corrections from a novice user?
4. Are per-document cost and latency predictable enough for a low-cost product?
5. Can the system fail closed under malformed files, hostile text, timeouts, duplicate documents, and tenant-boundary tests?

## Corpus requirements

A valid benchmark corpus contains 30–50 consented, redacted, single-page documents from at least three independent organizations and at least three suppliers. The set must include:

- Both JPEG and PNG inputs.
- At least three image-quality bands: clear, ordinary phone capture, and difficult but human-readable.
- At least two permitted document types: supplier invoice and packing slip.
- Documents with 1–5, 6–20, and 21 or more line items.
- At least 200 scorable line items across the frozen final-evaluation set so the 99.5% SKU-match precision gate is meaningful.
- Repeated supplier descriptions, vendor SKUs, UPCs, case/pack language, and at least five intentionally unmatched products.
- At least five duplicate-image submissions used only to test tenant-scoped hash deduplication.
- A minimum of five safe hostile-text fixtures created for the benchmark, such as printed URLs, prompt-like instructions, spreadsheet-formula prefixes, and oversized field strings. These fixtures contain no real confidential data.

Documents with handwriting, multiple pages, PDFs, customer receipts, prescriptions, patient data, payment-card data, bank data, tax-identification numbers, authentication secrets, or employee-personnel data are excluded.

One organization may contribute no more than half of the corpus. A source image may not appear in both the tuning and final evaluation sets.

## Consent and handling

Use the consent, redaction, access, retention, and deletion rules in the discovery specification. Before scoring a document, record:

- The organization and site that own it.
- The signed consent reference and permitted purpose.
- The redactor and second-person redaction check.
- SHA-256 of the approved redacted bytes.
- Media type, byte length, and confirmation that it has one page.
- Scheduled deletion date no later than 30 days after benchmark completion.
- The time-to-live for ground-truth text and raw extractor candidates, which cannot exceed the source-image retention period.

The benchmark runner receives only tenant-scoped object references. Provider training and provider retention beyond the minimum processing window must be disabled contractually and technically where supported. Candidate data is schema-validated, length-limited, formula-safe, and stripped of fields outside the benchmark schema before temporary storage.

The unkeyed per-document SHA-256 exists only for active-run integrity and is deleted with the content-bearing benchmark record. Any post-deletion deduplication fingerprint must use the tenant-scoped keyed form, consent, retention limit, and withdrawal rules in the discovery specification. An aggregate run identifier must not permit per-document lookup.

## Ground-truth preparation

Two reviewers independently transcribe each approved document into the same schema used by the vendor-neutral `DocumentExtractor` contract. They reconcile disagreements before any extractor result is scored.

Ground truth includes:

- Supplier name.
- Document number.
- Document date in ISO `YYYY-MM-DD` form when the document is unambiguous.
- Source line order.
- Description exactly as printed and as normalized for comparison.
- Vendor SKU and UPC when present.
- Quantity exactly as printed.
- Unit exactly as printed.
- Whether the quantity can safely normalize to a positive integer `EACH` using an existing versioned packaging definition.
- Correct tenant-scoped catalog product, or `unmatched`.

Ambiguous ground-truth fields are labeled `not scorable`; they are not silently treated as extractor failures or successes. The count and reason for every excluded field remain in the benchmark report.

## Execution design

### Isolation

- Run in a disposable benchmark environment with no production credentials.
- Use read-only, per-tenant catalog snapshots containing only fields required for matching.
- Give the runner no inventory database role and no access to quantity-changing application endpoints.
- Allow outbound traffic only to explicitly approved extractor endpoints.
- Delete source images, provider copies, and working files according to the consent schedule.

### Fair provider comparison

- Evaluate at least two interchangeable extractor adapters or one local baseline plus one provider adapter.
- Freeze adapter configuration, extractor version, prompts if any, timeouts, and retries before the final evaluation set.
- Run each extractor once on identical final-evaluation bytes; retries are measured separately rather than selecting the best result.
- Record provider errors and timeouts as failures, not missing data.
- Use the same deterministic catalog-matching rules for every extractor.
- Label adapters neutrally in the decision table until commercial and privacy review is complete.

### Non-mutating pipeline

The benchmark flow is:

`redacted image -> extractor candidate JSON -> schema validation -> deterministic tenant catalog match -> score -> delete by schedule`

It does not include:

`upload -> application receiving preview -> confirmation -> inventory ledger`

No benchmark component may emit a product, purchase-order, payable, receipt, or inventory mutation.

## Metric definitions

### Field accuracy

Normalize only whitespace, Unicode compatibility characters, case where appropriate, punctuation documented per field, and unambiguous dates. Do not use fuzzy matching to turn an incorrect identifier or quantity into a correct result.

Report separately:

- **Header exact accuracy:** correctly extracted scorable supplier-name, document-number, and document-date fields divided by all scorable header fields.
- **Line-identifier exact accuracy:** correctly extracted scorable vendor SKU and UPC fields divided by all scorable identifier fields.
- **Quantity exact accuracy:** correctly extracted quantity strings divided by all scorable quantity fields.
- **Unit exact accuracy:** correctly extracted unit strings divided by all scorable unit fields.
- **Line detection recall:** ground-truth lines represented by exactly one candidate divided by all ground-truth lines.
- **Document exact rate:** documents for which every scorable required field and line is exact divided by all evaluated documents.

Report micro-averages across fields and macro-averages across documents so large invoices cannot hide poor performance on small ones.

### SKU-match precision

`correct proposed catalog matches / all proposed catalog matches`

A proposed match is correct only when it identifies the ground-truth product inside the owning organization. Returning a product from another tenant is a security failure, not merely an incorrect match.

Also report match recall, but precision is the safety gate. The matcher must prefer `unmatched` over a low-confidence guess.

### Unmatched rate

`lines presented as unmatched / all extracted ground-truth lines`

Separate legitimate unmatched products from avoidable unmatched results:

- **Expected unmatched:** the correct ground truth is `unmatched`.
- **False unmatched:** the catalog contains the correct authorized product, but no match was proposed.

### Cost per document

Report:

- Provider charge per attempted document, including failed attempts.
- Retry and preprocessing cost.
- Estimated storage and egress cost during the permitted retention window.
- Fully loaded automated cost per document, excluding human review labor.

Record currency, pricing date, pricing tier, free credits, taxes, and rounding. Report both mean and p95 cost; do not use free credits to represent steady-state cost.

### Projected unit economics

Use the frozen **USD 39 per site per month** paid-pilot floor and formula in the discovery specification. Calculate monthly contribution at:

- Expected usage: cohort median monthly site volume multiplied by mean automated cost per document.
- Conservative p95 proxy: highest observed monthly site volume multiplied by p95 automated cost per document.

Both calculations include storage, egress, payment fees, incremental support and operations, and the specified 25% variable-cost contingency. Both must be positive. This is a discovery viability check, not proof of demand, a final price, or a forecast of market adoption.

### Latency

Measure from the benchmark runner's accepted request until schema-valid candidate output or terminal failure. Report p50, p95, maximum, timeout rate, and retry rate. Provider queue time is included.

Human review time is measured separately in a later authorized usability test and must not be represented by provider latency.

## Passing thresholds

Every threshold must pass on the frozen final-evaluation set:

| Measure | Required result |
| --- | ---: |
| Header exact accuracy | At least 95.0% |
| Line-identifier exact accuracy | At least 99.0% |
| Quantity exact accuracy | At least 99.0% |
| Unit exact accuracy | At least 98.0% |
| Line detection recall | At least 98.0% |
| SKU-match precision | At least 99.5% |
| Cross-tenant matches or disclosures | Exactly 0 |
| False unmatched rate | At most 15.0% |
| p50 extraction latency | At most 5 seconds |
| p95 extraction latency | At most 15 seconds |
| Terminal error and timeout rate | At most 2.0% |
| Mean automated cost | At most USD 0.10 per document |
| p95 automated cost | At most USD 0.25 per document |
| Monthly contribution at expected usage | Greater than USD 0 at the frozen pilot floor |
| Monthly contribution at conservative p95-proxy usage | Greater than USD 0 at the frozen pilot floor |
| Unauthorized inventory/product/vendor writes | Exactly 0 |
| Hostile-text instructions followed | Exactly 0 |

A provider can have excellent average OCR and still fail because of one cross-tenant disclosure, one unauthorized write, one hostile-text action, or SKU-match precision below the threshold.

## Positive integer EACH scoring

Normalization is scored independently from OCR accuracy:

1. Accept only a positive safe integer already expressed as `EACH`, or a positive safe integer produced by an existing, authorized, versioned case-pack definition.
2. Reject zero, negative, fractional, missing, overflow, weight, volume, ambiguous pack, or invented case-conversion values.
3. Count an unsafe accepted normalization as a false acceptance.
4. Count a safe value unnecessarily blocked as a false rejection.

The required result is zero false acceptances. False rejections are reported and become manual-review workload; they do not justify weakening the safety rule.

## Runnable benchmark-harness control matrix

Every row below is executable without a ContinuiXAi application upload or write path and must pass for the benchmark to pass.

| Test | Expected result |
| --- | --- |
| Runner attempts application, catalog, or inventory write | No write credentials or network route; attempt is denied and state remains unchanged |
| Same bytes submitted twice to one benchmark tenant | One extraction identity; no duplicate proposal |
| Same synthetic bytes assigned to two benchmark tenants | Independent tenant-scoped records; neither tenant can discover the other |
| Tenant A result is matched against catalog snapshots | Only Tenant A's explicitly selected read-only snapshot is accessible |
| Benchmark request or spend quota is exhausted | New provider work is rejected before charge when possible |
| Kill switch activates during provider work | Late result is discarded and cannot be scored as a successful response |
| Printed URL or QR payload | Never fetched or executed |
| Prompt-like document text | Treated only as quoted data |
| Formula-prefixed extracted value | Escaped in any CSV or spreadsheet export |
| Malformed or decompression-bomb image | Rejected within resource limits |
| Case quantity without packaging definition | Blocked for human resolution |
| Prohibited data fixture is detected | Content processing stops; content-bearing copies are deleted; only content-free incident metadata remains |
| Source, ground truth, and raw-candidate TTL expires | Content is deleted and a deletion event or provider attestation is recorded |

## Separately authorized future-control matrix

The rows below are mandatory design requirements but are **not** benchmark-pass criteria because the required application or write path does not exist and is not authorized. A future non-mutating prototype must execute its rows before prototype completion. A later write-path build must execute its rows with real PostgreSQL and API evidence before inventory-write authorization.

| Authorization stage | Future test | Required result |
| --- | --- | --- |
| Non-mutating prototype | Guessed object or review identifier | Generic denial without existence disclosure |
| Non-mutating prototype | User loses site membership during extraction | Late result cannot be reviewed |
| Non-mutating prototype | Source bytes change after extraction | Prior review token is invalid |
| Non-mutating prototype | Extraction reruns with a new version | Prior review token is invalid |
| Non-mutating prototype | Server accepts a corrected proposal | Old token is atomically invalidated; exactly one new token is bound to the canonical revised payload |
| Non-mutating prototype | Two corrections race | Requests serialize; only the latest server-issued token remains current |
| Non-mutating prototype | Extractor unavailable, killed, or over quota | Immediate novice-friendly manual fallback remains available |
| Write-path build | Confirmation contains a stale token or altered payload | Rejected without any write |
| Write-path build | Two confirmations race | At most one atomic ledger publication |
| Write-path build | Retry follows an ambiguous confirmation response | Same idempotency key returns the original outcome; no duplicate event |
| Write-path build | One selected line fails validation | Entire document confirmation rolls back |
| Write-path build | Confirmed receipt is reversed | Compensating immutable event; original evidence remains |

Deferral is not a waiver. Every future-control row must pass at its stated authorization stage, and all rows must pass before any inventory-write authorization.

## Run scorecard structure

Complete one row per extractor version after a valid run:

| Result field | Required reporting method |
| --- | --- |
| Extractor identity | Adapter name and immutable version |
| Corpus identity | Run manifest ID and aggregate corpus counts; any per-document keyed fingerprint follows the consented 90-day maximum |
| Attempted / succeeded / failed documents | Integer counts with failure categories |
| Field metrics | Micro and macro values for every defined field metric |
| Matching metrics | Precision, recall, expected unmatched, false unmatched, cross-tenant count |
| Normalization metrics | Accepted, blocked, false accepted, false rejected |
| Latency | p50, p95, maximum, timeout rate, retry rate |
| Cost | Mean, p95, pricing date, tier, and included cost categories |
| Runnable harness matrix | Pass/fail for every runnable row with evidence reference |
| Deferred controls | Marked not authorized/not run; never counted as a benchmark pass |
| Data deletion | Deletion event and provider-attestation references; fingerprints are not accepted as proof |
| Decision | Pass, fail, or inconclusive, with every failed threshold listed |

An inconclusive run is not a pass. Missing cost, privacy, deletion, tenant-isolation, or safety evidence makes the result inconclusive even if accuracy is high.

## Review-time usability measurement

Only after the automated benchmark passes may a separately authorized, non-production usability session measure human review. Use at least five target users and compare the same permitted documents against manual entry.

Report median and p90:

- Time to understand the screen without verbal coaching.
- Time to verify and correct a document.
- Number of wrong catalog matches accepted by the user.
- Number of quantity or unit errors accepted by the user.
- Number of times the user chooses manual fallback.
- User confidence on a 1–5 scale after explaining that no inventory was changed.

The usability gate requires zero accepted wrong-SKU or unsafe-quantity errors and at least a 30% median time reduction versus manual entry. A faster workflow that increases errors fails.

## Stop conditions

Stop the run immediately and preserve only the minimum content-free incident evidence if any of these occur:

- A tenant boundary is crossed or another tenant's existence is disclosed.
- An application, catalog, or inventory write occurs.
- Prohibited or insufficiently redacted data is discovered.
- A provider retains data outside the agreed window or uses it for training.
- Hostile document content changes execution behavior.
- Spend or request volume exceeds the authorized quota.
- Source or derivative deletion cannot be verified by an event or provider attestation.

Restart requires incident review, corrected controls, fresh authorization, and a new frozen evaluation set when the failure could bias results.

## Decision rule

A non-mutating prototype may be proposed only when:

1. The customer-discovery advancement gate passes.
2. One extractor configuration passes every benchmark threshold.
3. Every runnable benchmark-harness control passes, including consent, privacy, time-to-live deletion, provider terms, tenant isolation, quotas, and the kill switch.
4. The full result and cost model receive independent security and product review.

Future-control rows do not need to pass before prototype authorization because that would require the not-yet-authorized prototype and create a circular gate. They must pass before the prototype can be accepted, and every write-path row must pass before inventory-write authorization.

Even then, the next authorization permits only a review-first, non-mutating prototype. It does not authorize production inventory writes, production deployment, or provider purchasing beyond an approved prototype budget.

## Current benchmark record

| Item | Verified status |
| --- | --- |
| Consented documents | 0 |
| Ground-truth documents | 0 |
| Extractor configurations run | 0 |
| Accuracy, matching, cost, and latency results | Not measured |
| Projected unit economics | Not calculated |
| Runnable harness-matrix executions | 0 |
| Future-control executions | 0; not authorized |
| Usability participants | 0 |
| Benchmark authorization | Not granted |
| Prototype authorization | Not granted |

**Current decision: no benchmark conclusion and no build authorization.**
