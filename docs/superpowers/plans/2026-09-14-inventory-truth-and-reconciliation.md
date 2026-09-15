# Inventory Truth and Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a store-level inventory truth workflow that calculates expected product totals, routes employees location-first, expands displays into sellable components, records multi-location actual counts, and requires manager review before discrepancies establish a new baseline.

**Architecture:** Extend the existing site-scoped Product, StoreLocation, InventoryTransaction, ProductPackaging, and StoreCount models. Snapshot expected store totals when a count begins; track suspected product locations separately from expected quantities; track location visits; compute discrepancies only after required locations are verified; publish approved baselines through the existing immutable inventory ledger. The Count UI consumes these APIs without creating a second persistence path.

**Tech Stack:** PostgreSQL, Prisma 7, Fastify, Zod, Next.js 16, React 19, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-inventory-truth-and-reconciliation-design.md`

## Global Constraints

- Expected inventory is a store total. Never claim a POS sale came from a specific shelf or display.
- Counting is location-first: count all assigned products at one location before advancing.
- Suspected locations are evidence, not guaranteed quantities.
- Employees count physical products, never shelf tags or mylars.
- The current location, expected store total, and suspected-location checklist remain visible.
- Scan once and enter full quantity is the default; rapid one-by-one remains opt-in.
- Camera failure cannot block manual UPC, product-list, or hardware-scanner counting.
- Display and case expansion cannot double count a parent package and its sellable components.
- All reads and writes are organization- and site-scoped at the server boundary.
- Quantity-changing requests remain idempotent and retain immutable offline retry payloads.
- Counts can pause, resume, and be reassigned without losing ownership history.
- Managers approve baseline changes; approval never erases prior expectations or evidence.
- Completed count sessions remain immutable through count-entry endpoints.
- Production and PR #21 remain unchanged without explicit approval.

---

## File structure

- Modify `apps/api/prisma/schema.prisma`: location hints, display composition, expectation snapshots, location visits, and discrepancies.
- Create `apps/api/prisma/migrations/20260914190000_inventory_truth_reconciliation/migration.sql`: additive, site-safe migration plus nullable ledger location.
- Create `apps/api/src/lib/inventoryTruth.ts`: pure store-total, route, display, and discrepancy calculations.
- Create `apps/api/src/lib/inventoryTruth.test.ts`: pure invariant tests.
- Create `apps/api/src/routes/inventoryTruth.ts`: site-scoped setup, route, visit, expectation, and review APIs.
- Create `apps/api/src/routes/inventoryTruth.http.test.ts`: authorization, idempotency, lifecycle, and cross-site tests.
- Modify `apps/api/src/index.ts`: register inventory-truth routes.
- Modify `apps/api/src/lib/packagingResolution.ts`: versioned display expansion validation.
- Modify `apps/api/src/lib/packagingResolution.test.ts`: display and anti-double-count tests.
- Modify `apps/api/src/routes/storeCount.ts`: snapshot expectations at session start and block completion until required visits/discrepancies are resolved.
- Modify `apps/api/src/routes/storeCount.test.ts`: count lifecycle regressions.
- Create `apps/web/lib/inventoryTruthPresentation.ts`: plain-language expected, route, and discrepancy instructions.
- Create `apps/web/lib/inventoryTruthPresentation.test.ts`: presentation tests.
- Create `apps/web/components/LocationCountChecklist.tsx`: current-location product checklist and progress.
- Create `apps/web/components/LocationCountChecklist.test.tsx`: employee interaction and accessibility tests.
- Modify `apps/web/app/store-count/page.tsx`: expected totals, suspected locations, location-first progress, visit completion, and pause/resume.
- Modify `apps/web/lib/storeCountPageLifecycle.test.ts`: end-to-end page state regressions.
- Create `apps/web/app/store-count/review/page.tsx`: manager discrepancy review and baseline approval.
- Create `apps/web/lib/inventoryTruthReviewPage.test.ts`: review-screen source and lifecycle tests.
- Create `docs/reviews/2026-09-14-inventory-truth-adversarial-brief.md`: exact-SHA evidence and attack checklist.

### Task 1: Add site-scoped inventory truth records

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260914190000_inventory_truth_reconciliation/migration.sql`
- Create: `apps/api/src/lib/inventoryTruth.ts`
- Create: `apps/api/src/lib/inventoryTruth.test.ts`

**Interfaces:**
- Produces: `ProductLocationHint`, `ProductComposition`, `StoreCountExpectation`, `StoreCountLocationVisit`, `StoreCountAssignmentEvent`, and `StoreCountDiscrepancy` persistence models.
- Produces: `expectedStoreTotal(transactions)`, `buildLocationRoute(locations)`, and `computeStoreDifference(expected, actual)`.
- Consumes: existing `Product`, `ProductPackaging`, `StoreLocation`, `StoreCountSession`, `InventoryTransaction`, and `User` models.

- [ ] **Step 1: Write failing pure inventory-truth tests**

Create tests proving POS-like store events affect only the store total, location hints contain no expected quantity, routes sort locations once, and differences use the combined multi-location actual total:

```ts
expect(expectedStoreTotal([{ quantity: 20 }, { quantity: -3 }, { quantity: -2 }])).toBe(15);
expect(computeStoreDifference(15, [{ locationId: "shelf", quantity: 8 }, { locationId: "display", quantity: 5 }])).toEqual({ actualTotal: 13, difference: -2 });
expect(buildLocationRoute([
  { id: "back", sortOrder: 20, code: "BACK" },
  { id: "shelf", sortOrder: 10, code: "A1" },
])).toEqual(["shelf", "back"]);
```

- [ ] **Step 2: Verify the tests fail for the missing module**

Run: `npm --workspace @continuixai/api test -- inventoryTruth.test.ts`
Expected: FAIL because `inventoryTruth.ts` does not exist.

- [ ] **Step 3: Implement pure calculations**

```ts
export function expectedStoreTotal(rows: Array<{ quantity: number }>) {
  return rows.reduce((sum, row) => sum + row.quantity, 0);
}

export function computeStoreDifference(expected: number, actual: Array<{ quantity: number }>) {
  const actualTotal = actual.reduce((sum, row) => sum + row.quantity, 0);
  return { actualTotal, difference: actualTotal - expected };
}

export function buildLocationRoute(rows: Array<{ id: string; sortOrder: number; code: string }>) {
  return [...rows]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code) || a.id.localeCompare(b.id))
    .map((row) => row.id);
}
```

- [ ] **Step 4: Add Prisma models and enums**

Add evidence/status/reason enums and models with these required unique keys:

```prisma
model ProductLocationHint {
  id             String @id @default(cuid())
  organizationId String
  siteId         String
  productId      String
  locationId     String
  evidence       ProductLocationEvidence
  isRequired     Boolean @default(true)
  lastObservedAt DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@unique([siteId, productId, locationId])
  @@index([organizationId, siteId, locationId])
}

model ProductComposition {
  id                   String @id @default(cuid())
  parentPackagingId    String
  componentProductId   String
  quantityPerParent    Int
  version              Int @default(1)
  isActive             Boolean @default(true)
  createdAt            DateTime @default(now())
  @@unique([parentPackagingId, componentProductId, version])
}

model StoreCountExpectation {
  id               String @id @default(cuid())
  sessionId        String
  productId        String
  expectedStoreQty Decimal @db.Decimal(18, 4)
  createdAt        DateTime @default(now())
  @@unique([sessionId, productId])
}

model StoreCountLocationVisit {
  id            String @id @default(cuid())
  sessionId     String
  locationId    String
  status        StoreCountLocationVisitStatus @default(PENDING)
  completedById String?
  completedAt   DateTime?
  @@unique([sessionId, locationId])
}

model StoreCountAssignmentEvent {
  id           String   @id @default(cuid())
  sessionId    String
  fromUserId   String?
  toUserId     String
  assignedById String
  reason       String?
  occurredAt   DateTime @default(now())
  @@index([sessionId, occurredAt])
}

model StoreCountDiscrepancy {
  id               String @id @default(cuid())
  sessionId        String
  productId        String
  expectedStoreQty Decimal @db.Decimal(18, 4)
  actualStoreQty   Decimal @db.Decimal(18, 4)
  difference       Decimal @db.Decimal(18, 4)
  reason           StoreCountDiscrepancyReason?
  note             String?
  status           StoreCountDiscrepancyStatus @default(OPEN)
  reviewedById     String?
  reviewedAt       DateTime?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@unique([sessionId, productId])
}
```

Add `assignedToId String?` plus an `assignedTo` relation and index to `StoreCountSession`. Add explicit relations for every new foreign key and site/product/session indexes. Make `InventoryTransaction.locationId` nullable so POS and other store-total events do not invent a source location. Preserve location for receiving, transfers, counts, and dispositions. Define the evidence, visit-status, discrepancy-status, and discrepancy-reason enums with exactly the values named in the approved design specification.

- [ ] **Step 5: Write an additive migration**

The SQL must create enums/tables/indexes/foreign keys, change only `InventoryTransaction.locationId` to nullable, and avoid rewriting or deleting existing data. Use `ON DELETE RESTRICT` for historical product, site, and location evidence; use `ON DELETE CASCADE` only for session-owned snapshots, visits, and discrepancies.

- [ ] **Step 6: Validate schema and migration**

Run:

```bash
DATABASE_URL='postgresql://dummy:dummy@localhost:5432/dummy' npm run prisma:generate -w apps/api
npm --workspace @continuixai/api test -- inventoryTruth.test.ts
git diff --check
```

Expected: generation succeeds; focused tests pass; diff check is clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/lib/inventoryTruth.ts apps/api/src/lib/inventoryTruth.test.ts
git commit -m "feat: add inventory truth records"
```

### Task 2: Expand displays and cases into component inventory

**Files:**
- Modify: `apps/api/src/lib/packagingResolution.ts`
- Modify: `apps/api/src/lib/packagingResolution.test.ts`
- Modify: `apps/api/src/routes/products.ts`
- Modify: `apps/api/src/routes/products.http.test.ts`

**Interfaces:**
- Consumes: `ProductComposition` and existing `ProductPackaging`.
- Produces: `expandVersionedComposition(components, parentQuantity)` and organization-scoped composition read/write endpoints.

- [ ] **Step 1: Add failing display invariants**

Test two displays containing A×4, B×6, and C×3 expand to A×8, B×12, C×6; duplicate component rows aggregate; zero/negative component quantities fail; parent and child IDs cannot be identical; inactive historical versions remain readable but cannot be selected for a new receipt.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npm --workspace @continuixai/api test -- packagingResolution.test.ts products.http.test.ts`
Expected: FAIL on the new versioned composition behavior and missing endpoints.

- [ ] **Step 3: Implement validated aggregation**

```ts
export function expandVersionedComposition(
  components: Array<{ componentProductId: string; quantityPerParent: number }>,
  parentProductId: string,
  parentQuantity: number,
) {
  assertPositiveInteger(parentQuantity, "Parent quantity");
  const totals = new Map<string, number>();
  for (const row of components) {
    if (!row.componentProductId.trim() || row.componentProductId === parentProductId) throw new Error("Invalid display component");
    assertPositiveInteger(row.quantityPerParent, "Component quantity");
    totals.set(row.componentProductId, (totals.get(row.componentProductId) ?? 0) + row.quantityPerParent * parentQuantity);
  }
  if (totals.size === 0) throw new Error("Composition must contain at least one component");
  return [...totals].map(([productId, eachQuantity]) => ({ productId, eachQuantity }));
}
```

- [ ] **Step 4: Add organization-scoped composition endpoints**

Add `GET /api/products/:id/compositions` and manager-authorized `POST /api/products/:id/compositions`. Resolve organization context first; verify parent packaging and every component product belong to it; create a new immutable version in one transaction; never update old versions in place.

- [ ] **Step 5: Add cross-tenant and double-count tests**

Test guessed parent packaging, guessed component product, mixed-organization request, and self-component all fail without writes. Test expansion returns component ledger inputs only, not a simultaneous sellable parent quantity.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm --workspace @continuixai/api test -- packagingResolution.test.ts products.http.test.ts`
Expected: all focused tests pass.

```bash
git add apps/api/src/lib/packagingResolution.ts apps/api/src/lib/packagingResolution.test.ts apps/api/src/routes/products.ts apps/api/src/routes/products.http.test.ts
git commit -m "feat: expand displays into component inventory"
```

### Task 3: Build expected totals, suspected locations, and location routes

**Files:**
- Create: `apps/api/src/routes/inventoryTruth.ts`
- Create: `apps/api/src/routes/inventoryTruth.http.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/storeCount.ts`
- Modify: `apps/api/src/routes/storeCount.test.ts`

**Interfaces:**
- Produces: `GET /api/inventory-truth/counts/:sessionId/route`.
- Produces: `POST /api/inventory-truth/products/:productId/location-hints`.
- Produces: expectation snapshot creation inside `POST /api/store-count/sessions`.
- Consumes: Task 1 models/calculations and the existing authorized pilot site.

- [ ] **Step 1: Write failing HTTP tests**

Test that session creation snapshots the signed sum of site/product ledger events; events with `locationId=null` affect expected store total; route response groups all assigned products under each location; suspected locations include assigned, previously counted, stocked, received, and active-display evidence; no response contains an `expectedLocationQty` field.

- [ ] **Step 2: Add authorization attack tests**

Test cross-tenant product IDs, cross-site location IDs, sessions from another site, inactive locations, and users without site membership return 403/404 and create no hints, expectations, or visits.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm --workspace @continuixai/api test -- inventoryTruth.http.test.ts storeCount.test.ts`
Expected: FAIL because routes and snapshots do not exist.

- [ ] **Step 4: Snapshot expectations transactionally**

Inside Store Count session creation, after locking the user/site active-session identity, aggregate `InventoryTransaction.quantity` by product for the authorized site and create immutable `StoreCountExpectation` rows. Create one `StoreCountLocationVisit` per active required hinted location, ordered by `sortOrder`, code, then ID. Reusing an existing active session must not resnapshot or reset progress.

- [ ] **Step 5: Implement route response**

Return:

```ts
type CountRoute = {
  sessionId: string;
  expectedProducts: number;
  locations: Array<{
    id: string;
    code: string;
    name: string | null;
    status: "PENDING" | "ACTIVE" | "VERIFIED";
    products: Array<{
      productId: string;
      barcodeValue: string | null;
      name: string;
      packageSize: string | null;
      expectedStoreQty: number;
      suspectedLocations: Array<{ locationId: string; code: string; verified: boolean; evidence: string }>;
    }>;
  }>;
};
```

Do not include a per-location expected quantity.

- [ ] **Step 6: Register routes, run tests, and commit**

Run: `npm --workspace @continuixai/api test -- inventoryTruth.http.test.ts storeCount.test.ts`
Expected: all focused tests pass.

```bash
git add apps/api/src/index.ts apps/api/src/routes/inventoryTruth.ts apps/api/src/routes/inventoryTruth.http.test.ts apps/api/src/routes/storeCount.ts apps/api/src/routes/storeCount.test.ts
git commit -m "feat: route store counts by location"
```

### Task 4: Verify locations and calculate discrepancies

**Files:**
- Modify: `apps/api/src/routes/inventoryTruth.ts`
- Modify: `apps/api/src/routes/inventoryTruth.http.test.ts`
- Modify: `apps/api/src/routes/storeCount.ts`
- Modify: `apps/api/src/routes/storeCount.test.ts`

**Interfaces:**
- Produces: `POST /api/inventory-truth/counts/:sessionId/locations/:locationId/verify`.
- Produces: `POST /api/inventory-truth/counts/:sessionId/reassign`.
- Produces: `GET /api/inventory-truth/counts/:sessionId/discrepancies`.
- Consumes: existing Store Count entries and immutable expectation snapshots.

- [ ] **Step 1: Add failing lifecycle tests**

Test that verification records actor/time once, repeated requests are idempotent, and another site cannot verify. The API must reject verification unless the request explicitly confirms the client has flushed its pending/offline queue; Task 5 also disables the action while that queue is non-empty.

- [ ] **Step 2: Add discrepancy calculation tests**

Test actual quantities aggregate across shelf/display/backstock; no discrepancy is finalized until all required suspected locations are verified; zero differences close automatically; shortages and overages create one open record per session/product; rerunning calculation updates the same open record rather than duplicating it.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm --workspace @continuixai/api test -- inventoryTruth.http.test.ts storeCount.test.ts`
Expected: FAIL on visit verification and discrepancy lifecycle.

- [ ] **Step 4: Implement locked verification and calculation**

Lock the session row, require ACTIVE status and matching site, upsert the visit actor/time, then calculate discrepancies only when every required visit is VERIFIED. Use `StoreCountExpectation` as expected truth and summed `StoreCountEntry.quantity` across locations as actual truth.

- [ ] **Step 5: Harden count completion**

Modify `/api/store-count/sessions/:id/complete` so it rejects with 409 when required location visits are unverified or discrepancies lack an employee explanation. Preserve existing completed-session and concurrent-finish locks.

- [ ] **Step 6: Implement pause/resume ownership and reassignment**

Session creation assigns `assignedToId` to the starting employee and appends the first immutable `StoreCountAssignmentEvent`. Active-session retrieval returns the same route, expectation snapshots, completed visits, entries, and current assignee without resetting anything. Add `POST /api/inventory-truth/counts/:sessionId/reassign` with `{ toUserId, reason? }`; authorize only an active organization `OWNER`, `ADMIN`, or `MANAGER` who also has access to the session site, require the recipient to have active organization and site membership, lock the session, update `assignedToId`, and append an assignment event in one transaction. Reject completed sessions, cross-tenant users, cross-site users, and notes over 500 characters. Test all paths plus two concurrent reassignment requests and preserved count progress.

- [ ] **Step 7: Run focused tests and commit**

Run: `npm --workspace @continuixai/api test -- inventoryTruth.http.test.ts storeCount.test.ts`
Expected: all focused tests pass.

```bash
git add apps/api/src/routes/inventoryTruth.ts apps/api/src/routes/inventoryTruth.http.test.ts apps/api/src/routes/storeCount.ts apps/api/src/routes/storeCount.test.ts
git commit -m "feat: verify locations and calculate discrepancies"
```

### Task 5: Add the novice-friendly location-first Count UI

**Files:**
- Create: `apps/web/lib/inventoryTruthPresentation.ts`
- Create: `apps/web/lib/inventoryTruthPresentation.test.ts`
- Create: `apps/web/components/LocationCountChecklist.tsx`
- Create: `apps/web/components/LocationCountChecklist.test.tsx`
- Modify: `apps/web/app/store-count/page.tsx`
- Modify: `apps/web/lib/storeCountPageLifecycle.test.ts`

**Interfaces:**
- Consumes: `CountRoute` and visit verification API from Tasks 3–4.
- Produces: location-first progress, product checklist, suspected-location status, and plain-language discrepancy guidance.

- [ ] **Step 1: Write failing presentation tests**

Test exact messages:

```ts
expect(countInstruction({ expectedStoreQty: 15 })).toBe("15 expected in the store. Count every actual product at this location—not the shelf tag.");
expect(shortageInstruction(2)).toBe("2 units are still missing after the listed locations were checked. Choose a reason or request manager review.");
expect(overageInstruction(3)).toBe("3 extra units found. Confirm the product and location.");
```

- [ ] **Step 2: Write failing checklist tests**

Render one location with ten products. Assert current location, completed/total progress, expected store total, suspected-location chips, exact product identity, Scan/manual actions, and one dominant “Location complete” action. Test keyboard order, visible focus, disabled completion during pending confirmation/save, and resuming at the first unchecked product.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `npm --workspace @continuixai/web test -- inventoryTruthPresentation.test.ts LocationCountChecklist.test.tsx storeCountPageLifecycle.test.ts`
Expected: FAIL because the presentation helper and checklist do not exist.

- [ ] **Step 4: Implement the checklist component**

The component accepts:

```ts
type LocationCountChecklistProps = {
  location: CountRoute["locations"][number];
  checkedProductIds: ReadonlySet<string>;
  locked: boolean;
  onSelectProduct(productId: string): void;
  onCompleteLocation(): Promise<void>;
};
```

Show all products for the current location before any next-location action. Expected quantities are labeled “Expected in store,” never “Expected here.”

- [ ] **Step 5: Integrate with the approved scanner flow**

Keep `CountQuantityCard`, rapid-mode opt-in, offline queue, scanner pause/rearm handshake, stable idempotency payload, Summary, and Finish locks unchanged. Selecting a listed product or entering its UPC opens the same confirmation path. After location verification, advance to the next route location exactly once.

- [ ] **Step 6: Add pause/resume regressions**

Reload with an active session and partial visits; assert the app restores the first non-verified location, retains prior entries, does not resnapshot expected totals, and never sends the employee back through verified locations unless they explicitly choose Review.

- [ ] **Step 7: Run focused and full web tests, then commit**

Run:

```bash
npm --workspace @continuixai/web test -- inventoryTruthPresentation.test.ts LocationCountChecklist.test.tsx storeCountPageLifecycle.test.ts
npm --workspace @continuixai/web test
```

Expected: all tests pass.

```bash
git add apps/web/lib/inventoryTruthPresentation.ts apps/web/lib/inventoryTruthPresentation.test.ts apps/web/components/LocationCountChecklist.tsx apps/web/components/LocationCountChecklist.test.tsx apps/web/app/store-count/page.tsx apps/web/lib/storeCountPageLifecycle.test.ts
git commit -m "feat: guide counts location by location"
```

### Task 6: Add employee explanations and manager baseline approval

**Files:**
- Modify: `apps/api/src/routes/inventoryTruth.ts`
- Modify: `apps/api/src/routes/inventoryTruth.http.test.ts`
- Create: `apps/web/app/store-count/review/page.tsx`
- Create: `apps/web/lib/inventoryTruthReviewPage.test.ts`

**Interfaces:**
- Produces: `PATCH /api/inventory-truth/counts/:sessionId/discrepancies/:id/explain`.
- Produces: `POST /api/inventory-truth/counts/:sessionId/discrepancies/:id/approve`.
- Produces: manager review screen.
- Consumes: Task 4 discrepancy rows and `InventoryTransaction` for approved baseline events.

- [ ] **Step 1: Write failing reason and permission tests**

Test the exact allowed reasons from the spec, note length 0–500, employee explanation by the current assignee within the authorized site, approval only by an active organization `OWNER`, `ADMIN`, or `MANAGER` who can access that site, cross-site and cross-tenant rejection, and completed/approved immutability.

- [ ] **Step 2: Write failing atomic-baseline tests**

Approval must lock session and discrepancy, create exactly one `COUNT_ADJUSTMENT` InventoryTransaction with a deterministic reference identity, mark the discrepancy APPROVED, and retain expected/actual/difference. Concurrent approvals must produce one ledger event.

- [ ] **Step 3: Run API tests and confirm failure**

Run: `npm --workspace @continuixai/api test -- inventoryTruth.http.test.ts`
Expected: FAIL because explain/approve endpoints do not exist.

- [ ] **Step 4: Implement explain and approve endpoints**

Use one transaction and database row locks. Approval quantity equals the discrepancy difference, uses `referenceType="STORE_COUNT_DISCREPANCY"`, `referenceId=discrepancy.id`, and a nullable location because it establishes store-total truth. Inside the transaction, re-check active organization membership with role `OWNER`, `ADMIN`, or `MANAGER` plus active site access before writing anything.

- [ ] **Step 5: Build the review screen**

For each discrepancy show product identity, expected store total, actual store total, every counted location, difference, employee reason/note, and approval state. Employee copy remains neutral; never accuse an employee of theft. Managers receive one primary “Approve new baseline” action per reviewed discrepancy.

- [ ] **Step 6: Add review-screen tests**

Test shortage/overage text, required reason, manager-only control visibility, rapid approval taps, API failure retry, completed approval display, and accessible names/focus order.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npm --workspace @continuixai/api test -- inventoryTruth.http.test.ts
npm --workspace @continuixai/web test -- inventoryTruthReviewPage.test.ts
```

Expected: all focused tests pass.

```bash
git add apps/api/src/routes/inventoryTruth.ts apps/api/src/routes/inventoryTruth.http.test.ts apps/web/app/store-count/review/page.tsx apps/web/lib/inventoryTruthReviewPage.test.ts
git commit -m "feat: review and approve count discrepancies"
```

### Task 7: Full verification and adversarial evidence

**Files:**
- Create: `docs/reviews/2026-09-14-inventory-truth-adversarial-brief.md`
- Modify only if failures require it: files changed in Tasks 1–6.

**Interfaces:**
- Consumes: completed Tasks 1–6.
- Produces: exact code SHA, migration evidence, test/build/audit evidence, isolated-preview checklist, physical acceptance script, and Claude attack packet.

- [ ] **Step 1: Run schema and migration verification**

Run Prisma validation/generation and apply all migrations to a disposable PostgreSQL database. Verify existing Store Count rows survive, nullable location events work, new foreign keys reject cross-site mismatches through application authorization, and rollback/recovery instructions are documented.

- [ ] **Step 2: Run complete automated gates**

```bash
npm test
npm --workspace @continuixai/api run build
npm --workspace @continuixai/web run build
npm --workspace @continuixai/web run lint
npm audit --omit=dev --audit-level=high
git diff --check
```

Expected: tests and builds exit 0; lint has zero errors; audit has zero high/critical production vulnerabilities; diff check is clean.

- [ ] **Step 3: Create adversarial attack checklist**

Require attacks against store-total arithmetic, invented location expectations, cross-site hints, display parent/component double counting, composition version changes, route crisscrossing, skipped locations, resume duplication, concurrent visit verification, concurrent baseline approval, ambiguous offline replay, stale scanner results, completed-session writes, and QR/MFA regression.

- [ ] **Step 4: Prepare physical acceptance script**

Count at least ten products across five locations by visiting each location once. Include one product in multiple locations, one active display with at least three components, flat/curved/reflective barcodes, camera denial fallback, quantity greater than one, interruption/resume, shortage explanation, overage explanation, manager approval, Summary, and Finish/lock. Record route visits, detection time, actual totals, expected totals, differences, duplicate behavior, and instructions shown.

- [ ] **Step 5: Preserve release gates**

Open only an isolated draft PR when authenticated publishing becomes available. Verify preview API/web exact code SHA and disposable database migrations. Do not modify PR #21, merge, or deploy production without physical acceptance and explicit approval.

- [ ] **Step 6: Commit evidence**

```bash
git add docs/reviews/2026-09-14-inventory-truth-adversarial-brief.md
git commit -m "docs: prepare inventory truth adversarial review"
```
