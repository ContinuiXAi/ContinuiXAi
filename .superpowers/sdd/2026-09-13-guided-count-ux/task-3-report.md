# Task 3 report: Integrate scan-once quantity confirmation

## Status

Implemented, verified, and self-reviewed. Commit: pending until this report is committed with the task changes.

## Implementation

- Added a two-stage Count flow: camera, handheld wedge, and manual UPC input now identify one product and open the same `CountQuantityCard`; none posts inventory during identification.
- Added organization-scoped product lookup through the existing authenticated `/api/products/by-barcode/:barcode` endpoint, with session-entry reuse for previously identified products and a countable unknown-product fallback when details are unavailable.
- Kept confirmation on the existing `handleBarcode(value, quantity)` path so the original API route, idempotency key, offline queue, failed-scan review, tenant/site authorization, and server completion lock remain authoritative.
- Paused capture with synchronous pending/identifying refs while the confirmation card is open. The active camera video stays mounted but hidden, preventing a broken stream when the employee continues.
- Cancel clears the camera stamp so the same barcode can be scanned afresh. Successful capture resets that stamp at confirmation time so the existing one-second camera duplicate guard must elapse before the same product is accepted again.
- Replaced the always-visible UPC/quantity row with one secondary “Barcode won’t scan?” disclosure. Manual UPC identification uses the same quantity card and no separate quantity workflow.
- Made the location card sticky, displaying location code/name plus products and units counted there. Its Change control and selector are disabled during quantity confirmation, and location ref updates synchronously when changed.
- Added exact plain-language known/unknown confirmation announcements to `CountScanPresentation` and the existing live region.
- Disabled summary, location change, session finish, and session cancellation while an item confirmation is unresolved.

## TDD evidence

Initial RED command:

```text
npm --workspace @continuixai/web test -- storeCountScanReliability.test.ts countScanPresentation.test.ts
```

Result: FAIL — 5 expected failures. Missing behavior was pending-item state/deferred persistence (1), confirmation pause/cancel rearm (1), success rearm ordering (1), and known/unknown completion announcements (2).

Self-review RED command:

```text
npm --workspace @continuixai/web test -- storeCountScanReliability.test.ts
```

Result: FAIL — 1 expected failure proving the camera element was being unmounted during confirmation. The render was corrected to keep the active video mounted and hide only its capture view.

Final GREEN command:

```text
npm --workspace @continuixai/web test -- storeCountScanReliability.test.ts countScanPresentation.test.ts CountQuantityCard.test.tsx countQuantityFlow.test.ts
```

Result: PASS — 4 test files, 38 tests, 0 failures.

## Verification

```text
npm --workspace @continuixai/web test
```

PASS — 20 test files, 105 tests, 0 failures.

```text
npm --workspace @continuixai/web exec -- eslint app/store-count/page.tsx lib/storeCountScanReliability.test.ts lib/countScanPresentation.ts lib/countScanPresentation.test.ts
```

PASS — no ESLint findings.

```text
npm run build:shared && npm --workspace @continuixai/web run build
```

PASS — optimized Next.js production build compiled, passed TypeScript, and generated all 31 static pages. A direct web-only build first failed because this fresh worktree had no generated `@continuixai/shared` package; building the declared workspace prerequisite resolved it without source changes.

```text
git diff --check
```

PASS — no whitespace errors.

## Files changed

- `apps/web/app/store-count/page.tsx`
- `apps/web/lib/storeCountScanReliability.test.ts`
- `apps/web/lib/countScanPresentation.ts`
- `apps/web/lib/countScanPresentation.test.ts`
- `.superpowers/sdd/2026-09-13-guided-count-ux/task-3-report.md`

## Self-review

- Mutation check: removing pending assignment, calling persistence from detection, bypassing the existing API path, permitting location change, failing to reset cancel/success stamps, unmounting the active camera, restoring a second manual quantity input, or dropping known/unknown announcements each fails a focused assertion.
- Confirmation writes exactly once through the pre-existing idempotent function; no second POST implementation was introduced.
- Offline and rejected writes remain retained in the existing queue/review mechanism, and completion remains blocked for unresolved queued items.
- Camera duplicate protection is preserved; quantity confirmation is the intentional boundary for rearming repeated products.
- No scanner-engine configuration, decoder cadence, or focus-region tuning from Task 4 was included.
- No deployment, production merge, or PR #21 change was performed.

## Concerns

- Product identification requires a lightweight authenticated catalog lookup for products not already present in the active session. When that lookup is unavailable, the app deliberately allows an unknown UPC quantity so physical counting can continue offline; the original write queue remains the durable capture boundary.
- Physical iPhone camera timing and touch acceptance remain required after Task 4 and preview deployment, per the global release constraint.

## Fix Round 1

Reviewer findings addressed:

- Bound each asynchronous product lookup to its starting session, location, view, and version. A response is ignored unless all four still match an active Count context.
- Added visible `identifying` state plus synchronous ref guards. Summary, location Change/select, Finish, Cancel, manual fallback, and additional scanner reads are locked during lookup.
- Clear the prior success announcement and last-confirmed card as soon as a new identification begins; the live region says “Looking up item…” instead of presenting stale next-step guidance.
- Disabled the quantity card’s cancel action while a save is running and added a synchronous `quantitySubmittingRef` guard to the parent cancel handler. New camera reads remain blocked by the still-pending item until the save resolves.
- Added identity-safe completion so an older save callback clears only the exact pending item it submitted.
- Retained one `pendingClientScanIdRef` for the full pending-item lifecycle. If an ambiguous server response is followed by local queue-storage failure, confirmation retry sends the same idempotency key; it is cleared only after safe capture or a permitted cancel.
- Kept session refs current when loading, refreshing, counting, completing, starting, or cancelling so asynchronous validation observes the current completion/session state.

Behavioral RED command:

```text
npm --workspace @continuixai/web test -- storeCountPageLifecycle.test.ts CountQuantityCard.test.tsx
```

Result: FAIL — 4 expected failures:

1. Summary remained enabled during a deferred product lookup.
2. The quantity-card cancel action remained enabled during unresolved save.
3. A second camera scan was not protected by a disabled/guarded cancel lifecycle.
4. Ambiguous-response retry posted `scan-id-2` instead of retaining `scan-id-1`.

Focused GREEN command:

```text
npm --workspace @continuixai/web test -- storeCountPageLifecycle.test.ts storeCountScanReliability.test.ts countScanPresentation.test.ts CountQuantityCard.test.tsx countQuantityFlow.test.ts
```

Result: PASS — 5 test files, 42 tests, 0 failures. This includes deferred lookup resolution after attempted transitions and an authenticated session change; cancel and second-scan attempts during unresolved save; stale success-feedback clearing; and same-ID retry after simulated response loss plus queue-storage failure.

Full verification:

```text
npm --workspace @continuixai/web test
```

PASS — 21 test files, 111 tests, 0 failures.

```text
npm --workspace @continuixai/web exec -- eslint app/store-count/page.tsx components/CountQuantityCard.tsx components/CountQuantityCard.test.tsx lib/storeCountPageLifecycle.test.ts lib/storeCountScanReliability.test.ts
```

PASS — no ESLint findings.

```text
npm --workspace @continuixai/web run build
```

PASS — optimized production build compiled, TypeScript passed, and all 31 static pages generated.

Fix-round files:

- `apps/web/app/store-count/page.tsx`
- `apps/web/components/CountQuantityCard.tsx`
- `apps/web/components/CountQuantityCard.test.tsx`
- `apps/web/lib/storeCountPageLifecycle.test.ts`
- `apps/web/lib/storeCountScanReliability.test.ts`
- `.superpowers/sdd/2026-09-13-guided-count-ux/task-3-report.md`

## Fix Round 2

Reviewer findings addressed:

- Added one synchronous transition lock shared by Summary, Finish, Cancel, camera identification, manual identification, and location changes. A Summary request now locks scanning before its first await, then revalidates its transition version, session identity/status, count view, and pending/identifying/submitting state before it can replace the Count view.
- Applied the same transition lock and post-await session/version validation to Finish and Cancel so analogous session transitions cannot race scanner identification.
- Replaced the retry-only client ID ref with one immutable pending-submission snapshot containing session, location, barcode, quantity, and client ID. Every retry for that unresolved confirmation sends the same complete payload through the existing authenticated scan API and offline queue path.
- Made an ambiguous retry visibly immutable: the quantity input and step controls are locked, the card explains the retained quantity, and the action reads “Retry Save.” The success announcement is generated from that same frozen quantity.
- Updated the existing location-binding source contract to assert that the live location ref is captured at confirmation and subsequently read from the immutable submission.

Behavioral RED command:

```text
npm --workspace @continuixai/web test -- storeCountPageLifecycle.test.ts CountQuantityCard.test.tsx
```

Result: FAIL — 3 expected failures:

1. Summary remained enabled while its deferred request was unresolved, allowing an intervening scan lifecycle.
2. After an ambiguous accepted save plus queue-storage failure, the retry card reset to quantity `1` instead of retaining submitted quantity `12`.
3. That retry quantity input remained editable instead of representing the immutable server attempt.

Focused GREEN command:

```text
npm --workspace @continuixai/web test -- storeCountPageLifecycle.test.ts storeCountScanReliability.test.ts countScanPresentation.test.ts CountQuantityCard.test.tsx countQuantityFlow.test.ts
```

Result: PASS — 5 test files, 44 tests, 0 failures. Coverage includes a deferred Summary response with an attempted camera identification and a retry that attempts to change `12` to `7` but posts and announces `12` with the original idempotency ID.

Full verification:

```text
npm --workspace @continuixai/web test
```

The first full run found one stale source-contract assertion expecting the former transient location variable; all behavioral tests passed. After updating that assertion to the immutable submission boundary, the final run passed — 21 test files, 113 tests, 0 failures.

```text
npx eslint app/store-count/page.tsx components/CountQuantityCard.tsx components/CountQuantityCard.test.tsx lib/storeCountPageLifecycle.test.ts lib/storeCountScanReliability.test.ts lib/storeCountLocationBinding.test.ts
```

PASS — no ESLint findings (run from `apps/web`).

```text
npm --workspace @continuixai/web run build
```

PASS — optimized production build compiled, TypeScript passed, and all 31 static pages generated.

```text
git diff --check
```

PASS — no whitespace errors.

Fix-round files:

- `apps/web/app/store-count/page.tsx`
- `apps/web/components/CountQuantityCard.tsx`
- `apps/web/components/CountQuantityCard.test.tsx`
- `apps/web/lib/storeCountLocationBinding.test.ts`
- `apps/web/lib/storeCountPageLifecycle.test.ts`
- `apps/web/lib/storeCountScanReliability.test.ts`
- `.superpowers/sdd/2026-09-13-guided-count-ux/task-3-report.md`

Self-review:

- The transition ref is set synchronously before any transition request, so camera callbacks cannot enter during the React render gap; response validation prevents stale transitions from applying after session/view changes.
- Quantity, location, barcode, session, and client ID are all frozen together before the first POST. Both the API request and fallback queue reuse that snapshot; retry UI cannot imply a different quantity.
- The original organization-scoped lookup, authenticated API client, idempotent endpoint, offline queue, failed-scan review, completion locks, sticky location, and camera duplicate interval remain intact.
- No scanner-engine tuning, deployment, PR change, or unrelated refactor was included.

Concerns:

- Physical device acceptance remains part of the later preview/device gate. This fix round is fully covered by deterministic lifecycle tests plus the production TypeScript build.

## Fix Round 3

Reviewer finding addressed:

- `showSummary` previously required an `ACTIVE` session both before and after its request. That made the read-only summary unreachable after a successful completion whenever the automatic summary request failed, and after navigating from a completed summary back to Count.
- Summary reads now accept either `ACTIVE` or `COMPLETED` sessions and require the same session ID and status to remain current across the asynchronous request. Scanner identification, count persistence, Finish, and Cancel remain active-only, and the synchronous transition lock is unchanged.
- Added behavioral coverage for both completed-session paths: retry after completion succeeds but the first summary load fails, and Summary → Count → Summary navigation after a successful completion.

Behavioral RED command:

```text
npm --workspace @continuixai/web test -- storeCountPageLifecycle.test.ts
```

Result: FAIL — 2 expected failures. In both recovery and navigation cases the summary request count remained `1` instead of reaching `2`, proving the completed-session Summary action was a no-op.

Focused GREEN command:

```text
npm --workspace @continuixai/web test -- storeCountPageLifecycle.test.ts
```

Result: PASS — 1 test file, 6 tests, 0 failures.

Full verification:

```text
npm --workspace @continuixai/web test
```

PASS — 21 test files, 115 tests, 0 failures.

```text
npx eslint app/store-count/page.tsx lib/storeCountPageLifecycle.test.ts
```

PASS — no ESLint findings (run from `apps/web`).

```text
npm --workspace @continuixai/web run build
```

PASS — optimized production build compiled, TypeScript passed, and all 31 static pages generated.

```text
git diff --check
```

PASS — no whitespace errors.

Fix-round files:

- `apps/web/app/store-count/page.tsx`
- `apps/web/lib/storeCountPageLifecycle.test.ts`
- `.superpowers/sdd/2026-09-13-guided-count-ux/task-3-report.md`

Self-review:

- The new permission is read-only and limited to summary retrieval; no completed session can enter camera identification or the count write path.
- Status equality in the post-await guard rejects a response if an active session becomes completed (or otherwise changes) while its summary request is pending.
- Transition locking and session identity validation continue to prevent stale summary responses from hiding active pending work.

Concerns:

- None specific to this regression. Physical-device acceptance remains part of the later preview/device gate.
