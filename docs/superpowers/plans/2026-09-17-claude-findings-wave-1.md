# Claude Findings Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the newly discovered export isolation gap, shorten catalog onboarding, and expose only inventory facts the current ledger can prove.

**Architecture:** Keep `InventoryTransaction` as the single commercial inventory truth. Add tenant/site-authorized read and import/export surfaces without reusing the unscoped legacy `Item`, `Attachment`, `Setting`, or webhook models. Defer committed, incoming, monetary valuation, OCR writes, CV, BOM fulfillment, and native connectors until their prerequisite domains exist.

**Tech Stack:** Fastify, Prisma, PostgreSQL 17, Next.js/React, TypeScript, Zod, Vitest.

**Spec:** `docs/RETAIL_COUNT_MVP_ACCEPTANCE.md` and `docs/superpowers/specs/2026-09-14-inventory-truth-and-reconciliation-design.md`

## Global Constraints

- Preserve PR #21; do not merge or deploy without Mitchell's explicit approval.
- Every commercial query and mutation must enforce active organization and site membership; global `User.role === "ADMIN"` is not tenant authorization.
- Never reuse the feature-gated legacy Item/Attachment/Setting/webhook data paths for commercial inventory.
- New imports must preview before commit, be all-or-nothing, bounded, deterministic, formula-safe, and unable to mutate inventory quantities.
- Keep Count's `expectedStoreQty` as a frozen session baseline; never relabel it current on-hand.
- Represent unimplemented committed and incoming states as `notTracked`, never numeric zero.
- Use test-driven development and run the complete local and PostgreSQL CI gates after each task.

---

### Task 1: Close Store Count export tenant bypass

**Files:**
- Modify: `apps/api/src/routes/storeCountExport.ts:76-106`
- Create: `apps/api/src/routes/storeCountExport.http.test.ts`

**Interfaces:**
- Consumes: authenticated `request.user.sub`; `StoreCountSession.siteId`; active organization/site memberships.
- Produces: `GET /api/store-count/sessions/:id/export.csv` returning CSV only to an active user authorized for the session's site, otherwise a non-enumerating `404`.

- [ ] **Step 1: Write the failing cross-tenant HTTP test**

```ts
it("hides another tenant's count export from a global admin", async () => {
  mockSessionInOrganization("org-b", "site-b");
  authenticateAs({ id: "admin-a", role: "ADMIN", organizationId: "org-a" });
  const response = await app.inject({ method: "GET", url: "/sessions/session-b/export.csv" });
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ error: "count session not found" });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test -w apps/api -- --run src/routes/storeCountExport.http.test.ts`

Expected: FAIL because the current `role !== "ADMIN"` branch bypasses membership checks.

- [ ] **Step 3: Replace role bypass with site-scoped authorization**

Load the session only when an active `SiteMembership` and active `OrganizationMembership` connect `request.user.sub` to the session site and organization. Keep legacy site-less sessions owner-only. Return the same 404 for missing and unauthorized records.

```ts
where: {
  id,
  site: {
    isActive: true,
    organization: { isActive: true, memberships: { some: { userId, isActive: true } } },
    memberships: { some: { userId, isActive: true } },
  },
}
```

- [ ] **Step 4: Add denial and success coverage**

Cover unauthenticated, inactive user, inactive organization membership, inactive site membership, other tenant, same-organization wrong site, authorized counter/manager, and legacy site-less owner/non-owner cases. Preserve CSV escaping and quantity-total assertions.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm run test -w apps/api -- --run src/routes/storeCountExport.http.test.ts src/routes/storeCountExport.test.ts`

Commit: `fix: enforce tenant scope on count exports`

---

### Task 2: Add supported Product CSV preview/import/export

**Files:**
- Create: `apps/api/src/routes/productCsv.ts`
- Create: `apps/api/src/routes/productCsv.http.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/lib/csv.ts`
- Modify: `packages/shared/src/schemas/product.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/web/app/store-products/page.tsx`
- Create: `apps/web/lib/productCsvPage.test.tsx`

**Interfaces:**
- Produces: `POST /api/products/import/preview`, `POST /api/products/import/commit`, and `GET /api/products/export.csv`.
- Preview response: `{ previewId, expiresAt, totals, rows[] }`; each row is `valid`, `warning`, or `error` with normalized fields.
- Commit request: `{ previewId, organizationId }`; no inventory quantity fields are accepted.

- [ ] **Step 1: Write failing API tests for tenant scope and deterministic preview**

```ts
expect(await preview(csvWithDuplicateUpc, orgA)).toMatchObject({
  totals: { rows: 2, valid: 0, errors: 2 },
});
expect((await preview(csvForOrgB, orgAUser)).statusCode).toBe(404);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run test -w apps/api -- --run src/routes/productCsv.http.test.ts`

Expected: FAIL because supported Product CSV routes do not exist.

- [ ] **Step 3: Implement strict schemas and bounded preview**

Accept UTF-8 CSV only, maximum 5 MiB and 10,000 rows. Required headers: `upc,name`; optional: `manufacturer,description,package_size,category,is_active`. Reject unknown inventory-bearing headers including `quantity`, `on_hand`, `committed`, and `incoming`. Normalize UPC as text; never coerce through JavaScript number. Escape spreadsheet formulas in returned error CSV.

- [ ] **Step 4: Implement all-or-nothing commit**

Revalidate actor, organization membership, preview ownership, expiration, row hashes, duplicate UPC/name policy, category scope, and product state inside one Prisma transaction. Commit no rows when any row is invalid or stale.

- [ ] **Step 5: Add novice UI**

Provide Download Template, Choose CSV, Review, Fix Errors, and Import buttons. Show exact row counts and plain-language errors. Require explicit confirmation; never start import on file selection.

- [ ] **Step 6: Verify scale, tenant isolation, and UI**

Run:

```bash
npm run test -w apps/api -- --run src/routes/productCsv.http.test.ts src/lib/csv.test.ts
npm run test -w apps/web -- --run lib/productCsvPage.test.tsx lib/storeProductsPage.test.ts
```

Commit: `feat: add tenant-safe product CSV onboarding`

---

### Task 3: Add truthful site stock-state view

**Files:**
- Modify: `apps/api/src/routes/inventoryTruth.ts`
- Create: `apps/api/src/routes/inventoryStockState.http.test.ts`
- Modify: `apps/web/lib/types.ts`
- Modify: `apps/web/lib/inventoryTruthPresentation.ts`
- Modify: `apps/web/app/store-products/page.tsx`
- Modify: `apps/web/lib/storeProductsPage.test.ts`
- Modify: `docs/continuixai-ops-commercial-architecture.md`

**Interfaces:**
- Produces: `GET /api/inventory-truth/sites/:siteId/stock-state?cursor=&limit=`.
- Response row: `{ product, onHand, asOf, committed: { status: "notTracked" }, incoming: { status: "notTracked" } }`.

- [ ] **Step 1: Write failing signed-balance and isolation tests**

```ts
expect(row).toMatchObject({
  onHand: "-1.5000",
  committed: { status: "notTracked" },
  incoming: { status: "notTracked" },
});
expect(crossTenant.statusCode).toBe(404);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run test -w apps/api -- --run src/routes/inventoryStockState.http.test.ts`

Expected: FAIL because the balance route does not exist.

- [ ] **Step 3: Implement the read-only ledger aggregation**

Authorize active user, organization membership, site membership, active organization, and active site before querying. Sum signed `InventoryTransaction.quantity` by `productId` for the selected organization/site. Return decimal strings, preserve negative balances, paginate products, and include `asOf`.

- [ ] **Step 4: Add manager presentation**

Require site selection. Label values exactly `On hand`, `Committed — not tracked`, and `Incoming — not tracked`. Explain that Count's `Expected in store` is frozen at count start. Do not modify the employee counting screen.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm run test -w apps/api -- --run src/routes/inventoryStockState.http.test.ts
npm run test -w apps/web -- --run lib/storeProductsPage.test.ts
```

Commit: `feat: expose truthful site stock state`

---

### Task 4: Add point-in-time quantity reporting, not monetary valuation

**Files:**
- Create: `apps/api/src/routes/inventoryHistory.ts`
- Create: `apps/api/src/routes/inventoryHistory.http.test.ts`
- Create: `apps/api/scripts/inventoryHistoryDbValidation.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260917130000_inventory_history_index/migration.sql`
- Create: `apps/web/app/inventory-history/page.tsx`
- Create: `apps/web/lib/inventoryHistoryPage.test.tsx`

**Interfaces:**
- Produces: `GET /api/inventory-history/sites/:siteId/as-of?asOfExclusive=<ISO>&recordedBefore=<ISO?>`.
- Response explicitly includes `valuationStatus: "unavailable"` and quantity provenance.

- [ ] **Step 1: Write failing time-boundary and tenant tests**

Test half-open `occurredAt < asOfExclusive`, optional `createdAt < recordedBefore`, backdated events, negative quantities, wrong tenant/site, inactive membership, and empty history.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run test -w apps/api -- --run src/routes/inventoryHistory.http.test.ts`

- [ ] **Step 3: Implement bounded query and measured index**

Add an index supporting organization/site/product/effective-time aggregation. Confirm it with `EXPLAIN (ANALYZE, BUFFERS)` on a representative disposable PostgreSQL fixture before finalizing column order. Return quantity only; never multiply by current catalog price.

- [ ] **Step 4: Add real PostgreSQL reconciliation validation**

Prove raw ledger replay equals the API for normal, backdated, reversal, transfer, and negative-balance fixtures. Enforce organization/site predicates in every query.

- [ ] **Step 5: Add manager report and CSV export**

Show cutoff, recorded-before semantics, product quantities, and event provenance. Display `Monetary valuation unavailable — cost accounting is not configured.`

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
npm run test -w apps/api -- --run src/routes/inventoryHistory.http.test.ts
npm run test -w apps/web -- --run lib/inventoryHistoryPage.test.tsx
```

Commit: `feat: add point-in-time inventory quantities`

---

### Task 5: Gate invoice OCR behind non-mutating discovery

**Files:**
- Create: `docs/superpowers/specs/2026-09-17-receiving-import-discovery.md`
- Create: `docs/research/receipt-ocr-benchmark.md`

**Interfaces:**
- Produces no inventory API or write path.
- Defines a vendor-neutral `DocumentExtractor` contract for a later prototype.

- [ ] **Step 1: Define the discovery cohort and measurable pain threshold**

Interview 5–10 target users. Record receiving frequency, lines per document, minutes spent, error rate, document types, willingness to pay, and privacy constraints. Advance only if repeated pain and a paid use case are demonstrated.

- [ ] **Step 2: Define a non-mutating extractor benchmark**

Use consented, redacted single-page JPEG/PNG documents. Measure field accuracy, SKU-match precision, unmatched rate, cost/document, and latency. The prototype cannot write `InventoryTransaction`.

- [ ] **Step 3: Lock future safety requirements**

Future implementation must provide tenant-scoped source storage, hash deduplication, quotas, provider kill switch, hostile-text handling, review-token invalidation, positive integer EACH normalization, atomic confirmation, idempotency, reversal, and manual fallback.

- [ ] **Step 4: Review evidence before authorizing build**

Commit: `docs: define invoice OCR discovery gate`

---

## Explicitly Deferred

- Numeric committed/incoming inventory until reservation and inbound-order lifecycles exist.
- Monetary valuation until immutable unit-cost/currency facts and a selected costing policy exist.
- Direct OCR-to-inventory writes, new-product creation from OCR, and AP automation.
- Shelf-photo CV until secure tenant-scoped media evidence, privacy policy, labeled benchmarks, and physical pilot proof exist.
- BOM fulfillment until receiving/shipping/POS truth, packaging administration, reservations, and concurrency-safe allocation exist.
- Shopify, QuickBooks, POS, ERP, or broad connector development until CSV succeeds and measured customer demand selects one narrow adapter.

## Final Verification Gate

Run:

```bash
npm test
npm run build
npm run lint
git diff --check
```

Then publish the exact Git tree to the isolated CI branch and require all CI jobs, including PostgreSQL 17 database validation, to pass. Reconfirm PR #21 is open, unmerged, and unchanged. Nothing in this plan authorizes production deployment.
