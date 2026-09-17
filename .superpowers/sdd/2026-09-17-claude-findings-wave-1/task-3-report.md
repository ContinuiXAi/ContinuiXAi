# Task 3: Truthful site stock state

## Outcome

DONE_WITH_CONCERNS: recovered and audited the inherited uncommitted implementation, corrected the creation-cutoff and stale-site-response defects, and expanded coverage. No push, merge, deployment, PR creation/update, or change to PR #21. No subagents were spawned.

## Implementation and scope

- Added authenticated `GET /api/inventory-truth/sites` and `GET /api/inventory-truth/sites/:siteId/stock-state?cursor=&limit=`. Both require active site, active user, active site membership, active organization, and active organization membership. The global ADMIN role does not bypass these predicates. A denied balance request returns 404 before Product or InventoryTransaction reads.
- Product query selects active products in the authorized site's organization; deterministic name/ID keyset pagination fetches one lookahead row. Only returned product IDs participate in the ledger aggregate. Limit defaults to 50 and is constrained to integers from 1 through 100; malformed cursors/query parameters return 400.
- `On hand` is exclusively the signed `InventoryTransaction.quantity` Decimal sum for organization/site/product, serialized to four fractional digits without Number conversion. Missing balances return `0.0000`; negative and large fractional values are preserved. No legacy Item quantity or Count expectation is queried or modified.
- `committed` and `incoming` remain explicit `{ status: "notTracked" }`, never fictional zero commitments/incoming stock.
- Fixed inherited response-time `asOf`: one application-server `ledgerCreatedThrough` is captured before each page's aggregate query and used in `createdAt <= ledgerCreatedThrough` and every row's `asOf`. The UI labels it “Ledger creation cutoff.” Business `occurredAt` is deliberately not the system cutoff.
- Manager product UI requires a selected site, paginates results, displays signed values and unsupported-state labels, and explains that Count's Expected in store is frozen at count start. The employee counting screen and existing CSV controls were not changed.
- Added request-generation guards so a previous site's success, failure, or finally handler cannot replace the selected site's data or errors. Clearing selection invalidates outstanding requests. Site list loading, empty list, and failure have distinct presentations; site-list failures no longer masquerade as no accessible sites.
- Documentation/type comments explain the cutoff contract and its limitations. Preserved unrelated pre-existing `.superpowers/sdd-tools/` files, excluding them from the commit.

## Actually observed RED evidence

This was recovery of inherited production changes; the original two API/two web tests and implementation were already present. No claim is made that those changes were developed test-first.

1. After expanding the API tests, `npm run test -w apps/api -- --run src/routes/inventoryStockState.http.test.ts` reported **1 failed, 21 passed**. The new cutoff test advanced the clock during the aggregate read: inherited code returned `2026-09-17T12:00:02.000Z`, but the pre-read cutoff must be `2026-09-17T12:00:00.000Z`. After the fix, **22 passed**. The test also asserts the exact `createdAt` predicate, organization/site/product scope, and sum query.
2. After expanding web tests, `npm run test -w apps/web -- --run lib/storeProductsPage.test.ts` reported **3 failed, 6 passed**. Failures demonstrated a previous site's response replacing the new site's rows, a previous site's error appearing after selection was cleared, and a site-list exception being hidden as “No active sites.” After their fixes, **9 passed**.
3. Two later coverage tests (site-list pending state and empty product page) passed immediately; they are coverage, not claimed RED evidence. Final store-products test count is **11**.

## Final verification (2026-09-17 UTC)

```sh
npm run test -w apps/api -- --run src/routes/inventoryStockState.http.test.ts
# 1 file, 22 tests passed

npm run test -w apps/api -- --run src/routes/inventoryStockState.http.test.ts src/routes/productCsv.http.test.ts src/routes/inventoryTruth.http.test.ts src/routes/storeCount.test.ts
# 4 files, 113 tests passed

npm run test -w apps/web -- --run lib/storeProductsPage.test.ts lib/productCsvPage.test.tsx
# 2 files, 19 tests passed (11 stock/catalog + 8 CSV UI)

npm test
# PWA Home regression passed; shared build passed
# API: 43 files, 417 tests passed
# Web: 27 files, 216 tests passed

npm run lint
# exit 0; API no findings; web 0 errors, 9 pre-existing warnings

npm run build
# exit 0; shared/API TypeScript and web production build succeeded

git diff --check
# exit 0
```

All npm invocations emitted the existing environment warning about unknown `http-proxy` configuration. Web lint warnings remain the established hook dependency, unused suppression, and image-element warnings. No additional lint findings were introduced.

## Non-blocking concerns / verification limits

- `asOf` is a creation-time filter over rows visible to the aggregate query, **not** a historical commit-complete snapshot. The application clock provides the cutoff; `createdAt` is immutable by append-only application convention, not a DB-enforced commit timestamp. The review writer explicitly supplies application time; database defaults use database time. Clock skew matters, and a transaction begun before the cutoff but committed later can appear in a later read. This limitation is documented rather than hidden behind a stronger freshness claim.
- Pages use independent cutoffs; the full paginated list is not one repeatable-read database snapshot. Product metadata/active state is current at its own query time, and concurrent catalog renames/additions can move keyset positions. A stronger historical/audit guarantee requires a different snapshot/watermark contract.
- HTTP tests exercise real Fastify routes with mocked Prisma boundaries, including exact authorization/query predicates, no-data-on-denial branches, Decimal serialization, zero balances, deterministic cursor construction, and cutoff arguments. They do not prove PostgreSQL query execution/isolation or live concurrent commits. No `psql`, `postgres`, or `docker` executable was available. UI tests use the real React page in jsdom with mocked HTTP, not a deployed-browser smoke test.

## Commit

`feat: expose truthful site stock state` (the commit containing this report).

## Review fix round 1 (2026-09-17 UTC)

### Finding and fix

- Verified reviewer P2 against the Product route: a user with multiple authorized organizations can receive HTTP 400 `select one authorized organization` from the catalog while site discovery succeeds. Previously, `load()` only applied sites after the shared `Promise.all` resolved; catalog rejection discarded valid sites and escaped the effect as an unhandled rejection. A still-pending catalog request also blocked the successful site list.
- Split catalog and site discovery into independent loaders, each applying its own data and handling its own errors. Their requests still run concurrently. Catalog errors now appear in a separate product-catalog alert and suppress the misleading empty-catalog message, while authorized sites remain selectable and their stock balances load normally. No organization selector or catalog authorization behavior was added or changed.
- Added real-page regressions for rejected and pending catalog requests. The rejection test verifies authorized site options, no false no-sites message, the catalog error, successful site balance loading, and an empty captured unhandled-rejection list. CSV behavior and all previous stock-state tests remain intact.

### Observed RED and final evidence

- Before implementation, focused stock/catalog tests reported **2 failed, 11 passed**: both new tests failed because the successful site option was absent. An initial assertion draft attempted `toContain` on the missing option's undefined text; it was corrected to the direct missing-option assertion and the same two failures were reproduced before the fix.
- `npm run test -w apps/web -- --run lib/storeProductsPage.test.ts lib/productCsvPage.test.tsx`: **2 files, 21 passed** (13 stock/catalog, 8 CSV).
- `npm test`: PWA Home regression and shared build passed; **API 43 files / 417 passed**, **web 27 files / 218 passed**.
- `npm run lint`: exit 0, API no findings, web **0 errors / 8 existing warnings**. The existing store-products effect suppression is no longer reported as unused after splitting the loaders; no new lint finding was added.
- `npm run build`: exit 0, shared/API TypeScript and web production build succeeded.
- `git diff --check`: exit 0. Existing npm `http-proxy` environment warnings remain.

The original cutoff/clock, independent-pagination, and mocked-database verification limitations remain unchanged. No push, merge, deployment, PR change, or subagent use. Unrelated `.superpowers/sdd-tools/` files remain untouched.

Fix commit: `fix: decouple stock sites from catalog loading`.
