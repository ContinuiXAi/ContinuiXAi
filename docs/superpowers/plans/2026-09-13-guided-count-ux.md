# Guided Count UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make physical store counting fast and understandable by keeping location visible, scanning each product once, entering its full quantity, and providing clear camera guidance.

**Architecture:** Preserve the existing Store Count API and idempotent scan queue. Add a small pending-scan state machine in the web client so a camera read identifies a product but does not post quantity until the employee confirms it. Improve the existing ZXing/Quagga capture loop through focused-region configuration and measurable scan-state guidance without weakening duplicate protection.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, ZXing Browser/Library, Quagga2, existing Fastify Store Count API.

**Spec:** `docs/superpowers/specs/2026-09-13-store-inventory-ledger-design.md`

## Global Constraints

- One clear instruction and one dominant action per step.
- Current store location must remain visible while scanning and confirming quantity.
- The default workflow is scan once, enter the full quantity, then continue scanning.
- Rapid one-by-one scanning remains available but is not the default.
- Existing offline queue, idempotency, tenant/site authorization, and completed-count locking must remain intact.
- No production merge or deployment without physical iPhone acceptance and explicit approval.
- PR #21 exact candidate `b6bd6652415c6f0ec5ba9774215ca789074ff928` remains unchanged.

---

## File structure

- Create `apps/web/lib/countQuantityFlow.ts`: pure pending-scan and quantity validation helpers.
- Create `apps/web/lib/countQuantityFlow.test.ts`: unit tests for quantity confirmation state.
- Create `apps/web/components/CountQuantityCard.tsx`: accessible product identity and quantity confirmation UI.
- Create `apps/web/components/CountQuantityCard.test.tsx`: component behavior tests.
- Modify `apps/web/app/store-count/page.tsx`: sticky location, pending-scan flow, explicit confirm/cancel actions, and plain-language scanner guidance.
- Modify `apps/web/components/RetailScannerAssist.tsx`: focused capture, timing telemetry events, and faster bounded decode cadence.
- Modify `apps/web/lib/scannerEngine.ts`: export testable focused-region and decode-cadence configuration.
- Modify `apps/web/lib/scannerEngine.test.ts`: configuration and focus-region tests.
- Modify `apps/web/lib/storeCountScanReliability.test.ts`: regression coverage for scan-once quantity submission and duplicate protection.
- Create `docs/reviews/2026-09-13-guided-count-adversarial-brief.md`: exact-SHA review evidence and attack checklist.

### Task 1: Pending scan and quantity domain logic

**Files:**
- Create: `apps/web/lib/countQuantityFlow.ts`
- Create: `apps/web/lib/countQuantityFlow.test.ts`

**Interfaces:**
- Produces: `PendingCountItem`, `normalizeCountQuantity(value: string): number | null`, and `buildConfirmedCountScan(item, quantity, locationId): ConfirmedCountScan`.
- Consumes: no UI or network dependencies.

- [ ] **Step 1: Write failing quantity validation tests**

Test exact behavior:

```ts
import { describe, expect, it } from "vitest";
import { normalizeCountQuantity } from "./countQuantityFlow";

describe("normalizeCountQuantity", () => {
  it.each([["1", 1], ["12", 12], ["999", 999]])("accepts %s", (value, expected) => {
    expect(normalizeCountQuantity(value)).toBe(expected);
  });

  it.each(["", "0", "-1", "1.5", "1000", "abc"])("rejects %s", (value) => {
    expect(normalizeCountQuantity(value)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `npm --workspace @continuixai/web test -- countQuantityFlow.test.ts`  
Expected: FAIL because `countQuantityFlow.ts` does not exist.

- [ ] **Step 3: Implement the pure types and validator**

```ts
export type PendingCountItem = {
  barcodeValue: string;
  productId: string | null;
  productName: string | null;
  packageSize: string | null;
  known: boolean;
};

export type ConfirmedCountScan = PendingCountItem & {
  locationId: string;
  quantity: number;
};

export function normalizeCountQuantity(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 999 ? quantity : null;
}

export function buildConfirmedCountScan(
  item: PendingCountItem,
  quantity: number,
  locationId: string,
): ConfirmedCountScan {
  if (!locationId || quantity < 1 || quantity > 999) throw new Error("Invalid confirmed count scan.");
  return { ...item, quantity, locationId };
}
```

- [ ] **Step 4: Add tests for preserving exact product and location identity**

Verify that `buildConfirmedCountScan` preserves UPC, product ID, name, package size, known/unknown state, selected location, and quantity.

- [ ] **Step 5: Run the focused unit tests**

Run: `npm --workspace @continuixai/web test -- countQuantityFlow.test.ts`  
Expected: PASS with zero failed tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/countQuantityFlow.ts apps/web/lib/countQuantityFlow.test.ts
git commit -m "feat: add count quantity confirmation state"
```

### Task 2: Accessible quantity confirmation card

**Files:**
- Create: `apps/web/components/CountQuantityCard.tsx`
- Create: `apps/web/components/CountQuantityCard.test.tsx`
- Modify: `apps/web/lib/countQuantityFlow.ts`

**Interfaces:**
- Consumes: `PendingCountItem` and `normalizeCountQuantity`.
- Produces: `CountQuantityCard({ item, locationLabel, onConfirm, onCancel })`.

- [ ] **Step 1: Write a failing component test**

Render one known product and assert that the card shows:

- “Item found”
- Exact product name and package size
- Exact UPC
- “Counting at” plus location
- Quantity defaulted to 1
- Minus, plus, and numeric entry controls
- One primary “Confirm & Continue” button
- One secondary “Wrong item / Scan again” button

Use Testing Library already configured by the web test environment. If component tests currently use React DOM directly, follow that existing harness rather than adding a dependency.

- [ ] **Step 2: Verify the component test fails**

Run: `npm --workspace @continuixai/web test -- CountQuantityCard.test.tsx`  
Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the card**

The component must:

- Use `inputMode="numeric"`, `min={1}`, `max={999}`, and a visible “Quantity” label.
- Disable minus at 1 and plus at 999.
- Validate typed input with `normalizeCountQuantity`.
- Keep “Confirm & Continue” disabled for invalid input.
- Call `onConfirm(quantity)` exactly once.
- Display unknown UPC as “Product not recognized” while still permitting a counted quantity.
- Never hide the current location.

- [ ] **Step 4: Add keyboard and rapid-tap tests**

Verify:

- Enter submits a valid quantity.
- Repeated primary-button taps do not produce multiple callbacks while `submitting` is true.
- Cancel does not post inventory.
- Plus/minus clamps at 1 and 999.

- [ ] **Step 5: Run component and quantity tests**

Run: `npm --workspace @continuixai/web test -- CountQuantityCard.test.tsx countQuantityFlow.test.ts`  
Expected: PASS with zero failed tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/CountQuantityCard.tsx apps/web/components/CountQuantityCard.test.tsx apps/web/lib/countQuantityFlow.ts
git commit -m "feat: add guided quantity confirmation card"
```

### Task 3: Integrate scan-once quantity confirmation

**Files:**
- Modify: `apps/web/app/store-count/page.tsx`
- Modify: `apps/web/lib/storeCountScanReliability.test.ts`
- Modify: `apps/web/lib/countScanPresentation.ts`
- Modify: `apps/web/lib/countScanPresentation.test.ts`

**Interfaces:**
- Consumes: `CountQuantityCard`, `PendingCountItem`, and existing `handleBarcode(value, quantity)` persistence path.
- Produces: a two-stage camera flow: identify, then confirm quantity.

- [ ] **Step 1: Add failing regression assertions**

Extend the Store Count reliability source-contract test to assert:

- Camera detection sets `pendingItem`.
- Detection does not immediately call the quantity persistence path.
- Confirmation calls the existing idempotent scan API with the chosen quantity and current `locationIdRef.current`.
- Scanner capture pauses while the confirmation card is open.
- Cancel rearms the same barcode for a fresh scan.
- Successful confirmation rearms only after the existing duplicate-protection interval.

- [ ] **Step 2: Run the regression test and verify failure**

Run: `npm --workspace @continuixai/web test -- storeCountScanReliability.test.ts`  
Expected: FAIL on the new pending-item requirements.

- [ ] **Step 3: Refactor the page without changing the API contract**

Add:

```ts
const [pendingItem, setPendingItem] = useState<PendingCountItem | null>(null);
const [quantitySubmitting, setQuantitySubmitting] = useState(false);
```

Change camera detection so it performs product identification and opens `CountQuantityCard`. Move the existing call that posts a count entry into `confirmPendingQuantity(quantity)`. Reuse the existing scan queue and idempotency key creation. Do not create a second persistence implementation.

- [ ] **Step 4: Make location permanently visible**

Convert the location section to a sticky card directly below the page header. It must show:

- “Counting at”
- Location code and name
- Products and units counted at that location
- A clear “Change” control

Disable location changes while a quantity confirmation is open so the confirmed item cannot silently move between locations.

- [ ] **Step 5: Replace the hidden manual row**

Keep manual entry as the fallback, but label it “Barcode won’t scan?” and collapse it behind one secondary button. Manual UPC entry must open the same `CountQuantityCard`; it must not maintain a separate quantity workflow.

- [ ] **Step 6: Add plain-language completion state**

After confirmation, announce through the existing live region:

> Added [quantity] of [product] to [location]. Ready for the next item.

For unknown UPCs:

> Added [quantity] of UPC [value] to [location]. Product details need review.

- [ ] **Step 7: Run Store Count-focused tests**

Run: `npm --workspace @continuixai/web test -- storeCountScanReliability.test.ts countScanPresentation.test.ts CountQuantityCard.test.tsx countQuantityFlow.test.ts`  
Expected: PASS with zero failed tests.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/store-count/page.tsx apps/web/lib/storeCountScanReliability.test.ts apps/web/lib/countScanPresentation.ts apps/web/lib/countScanPresentation.test.ts
git commit -m "feat: guide scan-once quantity counting"
```

### Task 4: Faster capture and actionable scanner guidance

**Files:**
- Modify: `apps/web/components/RetailScannerAssist.tsx`
- Modify: `apps/web/lib/scannerEngine.ts`
- Modify: `apps/web/lib/scannerEngine.test.ts`
- Modify: `apps/web/app/store-count/page.tsx`

**Interfaces:**
- Consumes: existing ZXing primary scanner, Quagga retail assist, `CAMERA_SCAN_EVENT`, and `RETAIL_SCANNER_READY_EVENT`.
- Produces: `SCANNER_FRAME_INTERVAL_MS`, `getRetailScannerFocusRegion`, and non-sensitive scan timing/status events.

- [ ] **Step 1: Write failing configuration tests**

Assert:

- The focused region is centered and excludes unnecessary outer image area.
- Output width never exceeds 720 pixels for the assist decoder.
- Decode cadence is between 140 ms and 220 ms.
- The decoder still supports EAN-13, EAN-8, UPC-A, UPC-E, and Code 128.
- QR remains supported only where the existing application requires it; Store Count product presentation must reject QR as a merchandise UPC.

- [ ] **Step 2: Run scanner tests and verify failure**

Run: `npm --workspace @continuixai/web test -- scannerEngine.test.ts barcodeScanner.test.ts`  
Expected: FAIL on the new retail focus/cadence exports.

- [ ] **Step 3: Export bounded scanner configuration**

In `scannerEngine.ts`, add:

```ts
export const SCANNER_FRAME_INTERVAL_MS = 180;
export const RETAIL_FRAME_MAX_WIDTH = 720;

export function getRetailScannerFocusRegion(width: number, height: number) {
  const sw = Math.max(1, Math.round(width * 0.76));
  const sh = Math.max(1, Math.round(height * 0.42));
  return {
    sx: Math.max(0, Math.round((width - sw) / 2)),
    sy: Math.max(0, Math.round((height - sh) / 2)),
    sw,
    sh,
  };
}
```

Use this exact shared region in `RetailScannerAssist.captureFrame` so the fallback decoder analyzes the barcode target instead of the entire camera frame.

- [ ] **Step 4: Add measured guidance states**

Track elapsed time from camera readiness until detection:

- 0–2 seconds: “Center one barcode inside the box.”
- 2–5 seconds: “Hold steady and fill the box with the barcode.”
- After 5 seconds: “Try more light or tap ‘Barcode won’t scan?’”

Reset the timer after each confirmed or cancelled item. Do not show an error while decoding continues.

- [ ] **Step 5: Preserve concurrency guards**

Keep `decodingRef`, cancellation cleanup, armed-value duplicate protection, and the existing primary/fallback relationship. Do not run overlapping Quagga decodes.

- [ ] **Step 6: Run scanner and Count tests**

Run: `npm --workspace @continuixai/web test -- scannerEngine.test.ts barcodeScanner.test.ts cameraScanGuard.test.ts storeCountScanReliability.test.ts`  
Expected: PASS with zero failed tests.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/RetailScannerAssist.tsx apps/web/lib/scannerEngine.ts apps/web/lib/scannerEngine.test.ts apps/web/app/store-count/page.tsx
git commit -m "perf: accelerate guided retail barcode capture"
```

### Task 5: Full verification and isolated preview

**Files:**
- Modify: `docs/reviews/2026-09-13-guided-count-adversarial-brief.md`
- Modify only if failures demand it: files changed in Tasks 1–4.

**Interfaces:**
- Consumes: completed Tasks 1–4.
- Produces: exact commit SHA, CI evidence, preview build identity, physical test evidence, and adversarial-review packet.

- [ ] **Step 1: Run the complete web test suite**

Run: `npm --workspace @continuixai/web test`  
Expected: all test files and tests pass with zero failures.

- [ ] **Step 2: Run API regressions**

Run: `npm --workspace @continuixai/api test`  
Expected: all API tests pass, including tenant isolation, Store Count idempotency, session revocation, and MFA replay protection.

- [ ] **Step 3: Run production builds**

Run:

```bash
npm --workspace @continuixai/api run build
npm --workspace @continuixai/web run build
```

Expected: both commands exit 0.

- [ ] **Step 4: Run lint and production dependency audit**

Run:

```bash
npm --workspace @continuixai/web run lint
npm audit --omit=dev --audit-level=high
```

Expected: zero lint errors and zero high/critical production vulnerabilities.

- [ ] **Step 5: Push a separate implementation branch and open a draft PR**

Use a new branch based on `design/store-inventory-ledger`. Do not modify or merge PR #21. Confirm Railway creates an isolated PR environment and both web/API services report Online.

- [ ] **Step 6: Verify build identity**

Open the preview’s build-info endpoint and confirm it reports the exact implementation SHA. Record the SHA and Railway environment in the review brief.

- [ ] **Step 7: Perform physical iPhone acceptance**

Use at least:

- Two easy flat barcodes.
- Two difficult curved or reflective packages.
- One known product and one unknown UPC.
- Quantity 1 and a quantity greater than 1.
- One location change.
- Pause/resume.
- Summary and Finish/lock.

Record time-to-detection, quantity accuracy, duplicate behavior, instructions shown, and any manual fallback.

- [ ] **Step 8: Write the adversarial brief**

The brief must request attempts to break:

- Double submission from rapid taps.
- Duplicate scans during quantity confirmation.
- Location changes between scan and confirmation.
- Offline queue replay.
- Count completion with pending work.
- Unknown UPC quantity handling.
- Cross-tenant and cross-site location access.
- Completed-count immutability.
- Scanner cleanup and camera resource release.
- Regression into QR-based MFA setup.

- [ ] **Step 9: Commit the evidence**

```bash
git add docs/reviews/2026-09-13-guided-count-adversarial-brief.md
git commit -m "docs: prepare guided count adversarial review"
```
