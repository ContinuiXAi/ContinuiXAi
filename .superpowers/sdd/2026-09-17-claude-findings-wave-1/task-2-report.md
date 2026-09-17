# Task 2: Tenant-safe Product CSV onboarding

## Outcome

DONE_WITH_CONCERNS: implemented preview, explicit all-or-nothing commit, tenant-scoped export, and the novice review/import UI. No push, merge, deployment, or PR #21 mutation.

## Implementation and audit

- Added authenticated `/api/products/import/preview`, `/api/products/import/commit`, and `/api/products/export.csv` routes. Preview/export require an active OWNER/ADMIN/MANAGER membership, active actor, and active organization. An omitted organization resolves only when exactly one managed organization exists; unauthorized/ambiguous organizations return 404.
- Commit accepts only a server-issued UUID preview and organization ID; rejects extra payload fields. Cached previews bind actor and organization, expire after 15 minutes, and carry whole-preview and per-row SHA-256 digests. Commit rechecks authorization while locking membership/organization/actor rows, rechecks expiry/digests, validates rows, serializes CSV writers per organization, rechecks tenant UPC duplicates, then uses one transactional `createMany`. Commit attempts claim the preview before awaiting the transaction, preventing concurrent replay even for blank UPCs; unsuccessful attempts require another review.
- Category is a global legacy model with no organization field. The compatibility header remains accepted, but every nonblank category generates a row error. Neither preview nor commit queries Category or assigns category IDs, and one category error blocks the entire import. CSV export also never queries or reads Category; its compatibility category column is always blank.
- Accepts strict UTF-8 raw CSV and multipart uploads, up to 5 MiB and 10,000 rows. Explicit route body limit fixes Fastify's default 1 MiB rejection. UPC stays text, including leading zeros. Required/optional headers, inventory-bearing/unknown columns, malformed quotes, field lengths, booleans, within-file duplicates, and existing tenant products are validated.
- Returned/downloadable error CSV and exports use formula escaping. CSV encoding also quotes carriage returns and guards leading line feeds. Template download now uses actual CRLF rather than literal backslash sequences.
- UI selection never sends an import request. Review uploads the file, displays exact counts and row errors, offers the full error report, and Import requires explicit confirmation. Busy controls prevent replacing a file during review/import. Choosing a corrected file clears the previous review.
- Added `lib/**/*.test.tsx` to web Vitest discovery. The originally supplied focused command silently ran only the existing `.test.ts` file; the new UI tests now actually execute.
- Registered the real existing product routes before CSV routes in the HTTP test app, matching production order; static export and import requests reach their intended handlers.
- Shared package already re-exported `schemas/product.ts`; no index edit was necessary.

## Observed RED evidence

This task resumed existing partial implementation; no claim is made that the original routes were developed test-first. The following failures were actually observed during this completion pass before their fixes:

1. Focused API command initially reported **4 failed, 23 passed**: malformed UTF-8 message mismatch; legacy category accepted as valid (2 valid rather than 1); blank category explicitly assigned in write data; upload over 1 MiB incorrectly returned 413.
2. Once TSX test discovery was enabled, focused web reported **1 failed, 5 passed**: downloaded template contained literal `\\r\\n` instead of CRLF.
3. Additional focused API regressions reported **2 failed, 28 passed**: error CSV absent; preview expiring during authorization still committed with 201 rather than 409.
4. Additional focused web regressions reported **2 failed, 6 passed**: file picker stayed enabled during review; Download Errors button absent.
5. CSV encoding regression reported **1 failed, 37 passed**: carriage-return cell not quoted and leading-line-feed cell not formula-guarded.

Additional tests for existing behavior passed immediately and are coverage, not fabricated RED evidence.

## Final verification (2026-09-17 UTC)

```sh
npm run test -w apps/api -- --run src/routes/productCsv.http.test.ts src/lib/csv.test.ts
# 2 files passed; 38 tests passed (24 route tests + 14 CSV tests)

npm run test -w apps/web -- --run lib/productCsvPage.test.tsx lib/storeProductsPage.test.ts
# 2 files passed; 8 tests passed (7 CSV UI tests + 1 existing catalog test)

npm run test -w apps/api
# 42 files passed; 392 tests passed

npm run test -w apps/web
# 27 files passed; 205 tests passed

npm run build -w apps/api
# exit 0
npm run lint -w apps/api
# exit 0, no ESLint findings
npm run build -w apps/web
# exit 0, production build completed
npm run lint -w apps/web
# exit 0, 0 errors and 9 pre-existing warnings

git diff --check
# exit 0
```

All npm invocations emitted the environment's existing `Unknown env config "http-proxy"` warning. Web lint warnings concern existing hook dependencies, unused disable directives, and image elements, not new CSV logic.

## Non-blocking concerns / limits

- The accepted pilot cache is in-process, capped at 100 previews with a 15-minute TTL. Restart, expiry, or eviction requires another review. **Horizontal scaling requires durable shared preview storage** (including coordinated consumption); do not treat this pilot implementation as distributed-ready.
- HTTP route tests use real Fastify/multipart routing with mocked Prisma boundaries. They verify transaction calls, scopes, no-write branches, and data payloads, but do not prove live PostgreSQL locking, rollback, or maximum-size performance. No live database or deployed browser smoke test was performed.
- Category import intentionally remains unsupported until a tenant-scoped category domain exists. Error-report CSV includes diagnostic `row`/`errors` columns and is a report, not an import template.
- Existing unrelated `.superpowers/sdd-tools/` files were preserved and are excluded from this commit.

## Commit

`feat: add tenant-safe product CSV onboarding` (the commit containing this report).

## Review fix round 1 (2026-09-17 UTC)

### Binding ruling and changes

- Removed Category relation loading and category-name reads from CSV export. Regression checks the exact tenant-only Product query (no category `include`/`select`), no Category lookup, and a blank compatibility column even when the test fixture contains a legacy category.
- The commercial Product schema and normal routes do **not** enforce unique names. The revised parent ruling superseded the request to spread an advisory-lock protocol to every writer: duplicate names within a CSV or the existing catalog are now **warnings**, not errors. Same-name products may be imported, matching existing behavior. UPC/barcode remains the uniqueness gate.
- Commit's duplicate read now checks only tenant UPCs. If a concurrent ordinary writer wins after that read, the existing database `(organizationId, barcodeValue)` unique constraint rejects the batch. A Prisma P2002 is caught **outside** the transaction and returned as the same stale-preview 409, allowing the transaction to roll back rather than returning an unhelpful 500 or skipping individual rows. Other database errors still propagate.
- UI displays name-warning details and explicitly confirms/imports all non-error rows, including an all-warning CSV. Normal POST/PATCH, Store Count enrichment, and pilot migration writers were not changed.
- Removing blocking name checks exposed concurrent replay for blank-UPC rows. Preview consumption now occurs synchronously before awaiting the transaction. A parallel HTTP regression proves one 201, one 404, and one batch write. Any failed commit now requires another review; this is an intentional safety cost.

### Actual RED evidence

- API focused tests: **4 failed, 35 passed** before fixes—blocking duplicate-name errors, legacy category disclosure in export, name-warning import rejection, and UPC race returning 500 instead of 409.
- Web focused tests: **1 failed, 8 passed** before the warning UI fix—no duplicate-name warning detail displayed (the previous Import guard also excluded all-warning rows).
- Concurrent replay regression: **1 failed, 26 passed**, receiving `[201, 201]` rather than `[201, 404]` before the one-use claim.
- An earlier, superseded shared-lock test draft was discarded following the revised ruling. Its failures are not evidence for the final approach.

### Final fix verification

```sh
npm run test -w apps/api -- --run src/routes/productCsv.http.test.ts src/routes/products.http.test.ts src/lib/csv.test.ts
# 3 files, 54 tests passed
npm run test -w apps/web -- --run lib/productCsvPage.test.tsx lib/storeProductsPage.test.ts
# 2 files, 9 tests passed
npm run test -w apps/api
# 42 files, 395 tests passed
npm run test -w apps/web
# 27 files, 206 tests passed
npm run build -w apps/api
npm run lint -w apps/api
npm run build -w apps/web
npm run lint -w apps/web
# All exit 0; web retains the same 9 pre-existing warnings
git diff --check
# exit 0
```

No local `psql`, `postgres`, or `docker` executable was available. The P2002 regression verifies an actual Prisma known-error instance escaping the transaction promise, a single whole-batch `createMany` without `skipDuplicates`, and HTTP 409. It does not claim a live PostgreSQL concurrency/rollback test. The concurrent replay test uses parallel real Fastify requests with the transaction boundary delayed. The accepted single-process preview-cache limitation remains unchanged.

Fix commit: `fix: align CSV validation with product uniqueness`.
