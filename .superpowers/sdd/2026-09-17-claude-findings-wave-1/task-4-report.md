# Task 4: Point-in-time inventory quantities

## Outcome

**DONE_WITH_CONCERNS — ready for independent source review, not fully database-verified or approved.** Recovered the inherited endpoint/tests/registration and completed the UI, safe page CSV, documentation, provisional forward index migration, and real PostgreSQL validation script. The parent explicitly approved a provisional/unmeasured query-shaped index because no local PostgreSQL is available. Task 4 cannot be marked fully verified or approved until the script runs on disposable PostgreSQL 17 and its index-order evidence is reviewed.

No push, merge, deploy, PR change, or change to PR #21. No subagents. Tasks 1–3 remain intact; the only production edit to the existing Products page adds the history link. Unrelated `.superpowers/sdd-tools/` files remain untouched and excluded from the commit.

## Implementation

- Registered `GET /api/inventory-history/sites/:siteId/as-of`. Requires active authenticated user, organization, site, and both organization/site memberships. Global ADMIN does not bypass membership. Denied scope returns 404 before catalog/ledger reads.
- Strict, bounded inputs: timezone-bearing ISO timestamps with at most millisecond precision, maximum 40 timestamp characters, optional nonempty cursor up to 200 characters, integer limit 1–100/default 50, and no unknown query fields. Fixed inherited acceptance of impossible timezone offsets before any database access.
- Half-open `occurredAt < asOfExclusive` and optional `createdAt < recordedBefore`; blank recording cutoff intentionally includes later-recorded backdated entries. Organization/site/product predicates remain on aggregation. Quantities are exact signed Decimal strings, separated by unit. Product-ID keyset pagination excludes lookahead from aggregation and retains archived products.
- Response explicitly says `valuationStatus: "unavailable"`, current catalog metadata, and signed ledger events by unit. No price/cost lookup or calculation. Event count and first/last effective/last recorded timestamps are exposed; no-history rows are distinguished from known zero.
- `/inventory-history` discovers authorized stores independently of catalog loading; displays cutoffs, signed quantities, units, current/archived metadata, provenance, and the exact unavailable-valuation message. It supports pagination, errors/retry, loading/empty states, and guards stale identity/filter responses and duplicate requests.
- `Export this page CSV` is deliberately bounded to the visible page. It quotes CSV correctly and apostrophe-neutralizes formula-like fields, including leading whitespace/control characters and signed quantity strings. It repeats site, cutoffs, basis, valuation status, and provenance. It does not imply a complete multi-page export.
- Added a forward-only `InventoryTransaction_history_idx` on `(organizationId, siteId, productId, occurredAt, createdAt)` and matching Prisma declaration. **Order is provisional/unmeasured.** No old migration or ledger data changed. Ordinary CREATE INDEX can block writers; deployment needs separate planning/approval.
- Added `docs/INVENTORY-HISTORY.md` with API/UI/CSV semantics, snapshot/clock limitations, and database validation instructions.
- Added `inventoryHistoryDbValidation.ts`: guarded local `_ci` database + explicit opt-in + PostgreSQL 17 only; applies/checks migrations and index definition; independently replays scoped raw events against real HTTP/API results with exact decimal sums and hand-derived literal expectations. Fixtures cover normal, backdated, reversal, transfer, negative, known zero, empty, mixed units, archive, cutoff equality, provenance, pagination, wrong tenant/site, and every inactive authority dimension including global ADMIN. Raw timestamps are interpreted explicitly as UTC.
- The script additionally creates 300,000 events across 400 products/three sites/two tenants, analyzes the ledger, and emits 36 EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) plans comparing candidate, existing-index baseline, and effective-time-first order over varying page sizes/time cutoffs. Alternative DDL rolls back. It never disables ledger protections; the disposable database is torn down externally after evidence retention. **This script has not successfully executed against a database here.**

## Actual RED/GREEN evidence

The inherited route and 22 HTTP tests were already present. The first run passed 22/22. No original inherited RED evidence was available and no test-first claim is made for that implementation.

1. New UI/CSV tests were written before the page/helper. `npm run test -w apps/web -- lib/inventoryHistoryPage.test.tsx` failed **10/10**: nine missing-feature assertions and one missing-control TypeError in the rapid-click scenario. After implementation, **10/10 passed**. A later empty-site assertion passed immediately and is additional coverage, not claimed RED evidence. Final file has **11 tests**.
2. New API invalid-offset cases used `2026-09-17T00:00:00+24:00` and `2026-09-17T00:00:00+00:99`. The focused run failed **2**, passed **22**, because the inherited route returned **500 instead of 400**. Root cause: syntactically accepted offset creates an invalid JavaScript Date. Added finite-Date refinement; the focused run passed **24/24**. Tests also assert no database call on rejection.
3. Product-page navigation test failed **1**, passed **13**, because `/inventory-history` was absent. Added the link; file passed **14/14**.

After GREEN, temporary missing-module fallback imports were replaced with static imports so future import failures cannot be hidden. No database fixture RED/GREEN or performance success is claimed.

## Final executed verification — 2026-09-17 UTC

```sh
npm run test -w apps/api -- --run src/routes/inventoryHistory.http.test.ts
# exit 0: 1 file / 24 tests passed

npm run test -w apps/web -- --run lib/inventoryHistoryPage.test.tsx lib/storeProductsPage.test.ts
# exit 0: 2 files / 25 tests passed (11 history + 14 Products)

npm test
# exit 0: PWA Home regression passed; shared build passed
# API: 44 files / 441 tests passed
# Web: 28 files / 230 tests passed

npm run build
# exit 0: shared and API TypeScript, web production compilation/typecheck
# 33/33 static pages generated, including /inventory-history

npm run lint
# exit 0: API no findings; web 0 errors / 8 existing warnings

# From apps/api:
npx --no-install tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck scripts/inventoryHistoryDbValidation.ts src/types/fastify.d.ts
# exit 0: validation script separately typechecked (normal API build excludes scripts)
npx --no-install eslint scripts/inventoryHistoryDbValidation.ts
# exit 0: no findings

DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/inventory_history_ci npx --no-install prisma generate
# exit 0: Prisma Client 7.10.0 generated
DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/inventory_history_ci npx --no-install prisma validate
# exit 0: schema valid
set -o pipefail
DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/inventory_history_ci npx --no-install prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script | rg 'InventoryTransaction_history_idx'
# exit 0: generated CREATE INDEX matches candidate migration name/order
# This is schema-to-SQL consistency only, NOT live migration execution.

git diff --check
# exit 0
```

Intermediate full build/lint runs exposed test-only issues: unknown mock-instance type and Next's forbidden `module` variable name. Those were corrected; the final runs above succeeded. Initial standalone script typecheck invocations used the wrong TypeScript CLI context or lacked Fastify/JWT type context; the explicit final command above succeeds. Existing npm `http-proxy` environment warnings remain. The eight web warnings are established hooks, unused suppressions, and image-element warnings, not new history warnings.

## Blocked database evidence — actually attempted

- No `psql`, `pg_ctl`, `postgres`, or `docker` executable; `/usr/lib/postgresql` absent; no supplied DATABASE_URL. Previous Task 2/3 reports corroborated the same limitation.
- `INVENTORY_HISTORY_DB_VALIDATE=1 DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/inventory_history_ci npx --no-install tsx scripts/inventoryHistoryDbValidation.ts` failed before script execution with **EPERM creating `/tmp/tsx-0/17.pipe`**. The safe loader alternative was used next.
- `INVENTORY_HISTORY_DB_VALIDATE=1 DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/inventory_history_ci node --import tsx scripts/inventoryHistoryDbValidation.ts` exited **1**, **ECONNREFUSED 127.0.0.1:5432**. It did not apply migrations, create fixtures, or execute EXPLAIN.
- `DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/inventory_history_ci npx --no-install prisma migrate status` exited **1**, with datasource identification followed by `Error: Schema engine error:` and no additional detail. No live migration-status success is claimed.

## Remaining concerns / approval gate

1. **Required PostgreSQL reconciliation, actual migration application, and EXPLAIN index-order validation are BLOCKED.** Run the documented guarded script on disposable PostgreSQL 17, retain/review its results, then confirm or revise the candidate index before approval/deployment. The synthetic script itself may reveal issues only once run; typechecking is not execution evidence. No SQLite/mock substitution was used.
2. HTTP tests exercise real Fastify routing with mocked Prisma boundaries, and UI tests exercise React/jsdom with mocked HTTP. They do not prove database execution, committed concurrency, production identity, or browser usability. No deployed browser smoke test was performed.
3. `recordedBefore` is a creation-time predicate, not a database commit watermark. A late-committing event with an earlier creation timestamp can appear on reread. Application/database clock differences and current catalog metadata also limit strict historical guarantees. Pages are independent reads, not a frozen catalog/ledger snapshot. These limitations are documented.
4. CSV exports only the current page and may apostrophe-prefix negative numeric strings for formula safety; import relevant fields as text to preserve exact identifiers/decimals. Full snapshot export is intentionally not implemented.

## Commit

`feat: add point-in-time inventory quantities` (the commit containing this report). No push/merge/deploy.
