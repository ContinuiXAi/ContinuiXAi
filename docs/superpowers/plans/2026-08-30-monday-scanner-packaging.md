# Monday Scanner and Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Monday pilot Count experience show clear scan results and establish safe pack/case/display quantity expansion without disrupting the proven manual Count workflow.

**Architecture:** Keep the existing Store Count route and product catalog as the pilot backbone. Add a small packaging-resolution service that resolves a scanned identifier to either one product/pack or a multi-item composition, normalizes quantity to eaches, and returns display metadata to the existing Count UI. Defer wholesaler transformation economics and retailer transfer workflows to later phases, while preserving their approved design in the spec.

**Tech Stack:** Next.js/React, Fastify, Prisma/PostgreSQL, TypeScript, existing ZXing/Quagga camera path.

**Spec:** `docs/superpowers/specs/2026-08-30-packaging-inventory-design.md`

## Global Constraints
- Existing manual UPC Count flow must remain functional.
- Existing iPhone camera path must remain functional.
- Unknown pack definitions must never guess quantities.
- Manufacturer item UPC remains the downstream merchandise identity for repacked merchandise.
- Pack/display expansion must be auditable and atomic before being used for inventory mutation.
- Monday pilot changes must not require the wholesaler transformation subsystem.

---

### Task 1: Packaging quantity resolver

**Files:**
- Create: `apps/api/src/lib/packagingResolution.ts`
- Create: `apps/api/src/lib/packagingResolution.test.ts`

**Interfaces:**
- Produces: `resolvePackagingQuantity(packaging, requestedQuantity)` returning normalized each quantity for single-product packs.
- Produces: `expandComposition(components, requestedQuantity)` returning component each quantities for displays/assortments.

- [ ] **Step 1: Write failing tests** covering EACH=1, CASE=12, 100 displays with seven components, and rejection of zero/unknown quantities.
- [ ] **Step 2: Run focused test and verify RED.**
- [ ] **Step 3: Implement the pure resolver functions with integer validation and no guessed values.**
- [ ] **Step 4: Run focused test and verify GREEN.**
- [ ] **Step 5: Run API unit tests.**

### Task 2: Monday scan-result contract

**Files:**
- Modify: `apps/api/src/routes/storeCount.ts`
- Test: `apps/api/src/routes/storeCount.test.ts`
- Test: `apps/api/scripts/storeCountRouteValidation.ts`

**Interfaces:**
- Existing `POST /api/store-count/sessions/:id/scan` remains backward compatible.
- Response continues to include the Count entry, product and location; new response metadata may include scanned UPC, packaging level, pack quantity, and each quantity without changing existing entry semantics until pack persistence is introduced.

- [ ] **Step 1: Add tests asserting known scans return product description/name, scanned UPC, and location.**
- [ ] **Step 2: Verify the tests fail for any missing contract fields.**
- [ ] **Step 3: Add the minimal backward-compatible response metadata.**
- [ ] **Step 4: Verify route/unit tests pass.**
- [ ] **Step 5: Run Store Count validation script.**

### Task 3: Count UI scan confirmation

**Files:**
- Modify: `apps/web/app/store-count/page.tsx`
- Create: `apps/web/lib/countScanPresentation.ts`
- Create: `apps/web/lib/countScanPresentation.test.ts`

**Interfaces:**
- Produces: a presentation helper that formats product name, UPC, location, quantity added, and current quantity.
- Consumes existing scan response and current selected location.

- [ ] **Step 1: Add failing presentation tests for known, unknown, and manual-quantity scans.**
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement presentation helper.**
- [ ] **Step 4: Update Count UI to keep the successful scan card visible long enough to confirm product description, UPC, selected location, added quantity and current quantity.**
- [ ] **Step 5: Verify web unit tests/build.**

### Task 4: Camera duplicate guard

**Files:**
- Modify: `apps/web/app/store-count/page.tsx`
- Modify or create focused scanner guard helper/test under `apps/web/lib/`.

**Interfaces:**
- All camera-originated scanner events share one re-arm policy before `handleBarcode` is invoked.
- Manual entry and physical keyboard-wedge scans remain intentional user events and are not incorrectly blocked.

- [ ] **Step 1: Add failing tests showing the same camera barcode cannot increment twice while continuously held in frame.**
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement one camera re-arm gate used by both ZXing and Quagga-assist paths.**
- [ ] **Step 4: Verify GREEN and existing scanner tests.**
- [ ] **Step 5: Build web app.**

### Task 5: Pack/display persistence foundation

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: one migration under `apps/api/prisma/migrations/`
- Modify: `apps/api/scripts/commercialFoundationValidation.ts`

**Interfaces:**
- Add explicit packaging types needed by approved design (`DISPLAY`, `MULTIPACK` or equivalent composition type).
- Add component relation so a parent packaging definition can contain one or many component products with integer quantity-per-parent.
- Do not yet alter Monday Count mutation to expand multi-product displays until seed/admin data exists and atomic count-entry semantics are fully covered.

- [ ] **Step 1: Add validation expectations for display composition and standard case pack.**
- [ ] **Step 2: Verify validation fails.**
- [ ] **Step 3: Add schema/migration with strict positive component quantities and organization-safe relations.**
- [ ] **Step 4: Run Prisma generate/migration validation.**
- [ ] **Step 5: Run commercial foundation and integrity validation.**

### Task 6: Full regression gate and pilot acceptance

**Files:** none unless regressions are found.

- [ ] **Step 1: Run root build/test/lint/security workflow equivalents.**
- [ ] **Step 2: Run fresh database migration/status/diff validation.**
- [ ] **Step 3: Run fresh pilot bootstrap, Store Count route, empty-count completion, atomic/idempotent counting, and commercial/task validations.**
- [ ] **Step 4: Open PR and require green CI on exact head.**
- [ ] **Step 5: Merge only after green CI, then require green post-merge CI on exact merge SHA.**
- [ ] **Step 6: Physical acceptance on deployed iPhone: one Mr. Clean scan increments exactly once and visibly shows description, UPC, location and resulting quantity; holding barcode does not repeatedly increment; remove for >1.5s and rescan increments exactly once more.**
