# Point-in-time inventory quantities

Open **Products → Inventory history** (`/inventory-history`). This report is read-only and quantity-only. Monetary valuation unavailable — cost accounting is not configured. No current price or cost is used.

## API contract

`GET /api/inventory-history/sites/:siteId/as-of?asOfExclusive=<ISO>&recordedBefore=<ISO optional>&limit=50&cursor=<optional product id>`

- Authentication and active user, organization, site, organization membership, and site membership are mandatory. A global ADMIN role does not bypass any membership. Access failures return 404; missing authenticated subject returns 401.
- `asOfExclusive` is required. Only events with `occurredAt < asOfExclusive` contribute. The exact boundary is excluded.
- Without `recordedBefore`, all events currently recorded are considered, including later-recorded backdated entries. With it, `createdAt < recordedBefore` also applies. This distinguishes effective history from what had been recorded by an earlier point.
- Supply ISO timestamps with timezone (`Z` for UTC), at most millisecond precision. Invalid dates/offsets, unknown fields, empty cursors, and limits outside 1–100 return 400. Default page size is 50 products; maximum cursor length is 200 characters.
- Products are organization-scoped, including archived products, in immutable ID order. `nextCursor` is the last product ID, never a unit row. A product may contribute multiple unit rows. Catalog pages are deterministic for an unchanged catalog but are not a frozen cross-request snapshot; changes and later-recorded events can change subsequent results. An explicit recorded cutoff fixes the creation-time predicate, not database visibility: `createdAt` is not a commit timestamp, so a transaction committed later with an earlier creation timestamp may appear on reread. Clock skew and application-supplied timestamps also matter. This is not a commit-complete accounting snapshot.
- Quantity is a signed four-decimal string, grouped by product and unit. Different units are not summed or converted. Physical location is not attributed to sales; this is a site total.
- A zero with `eventCount > 0` is known zero; `eventCount: 0`, `unitOfMeasure: null` means no ledger history before the cutoffs, not evidence of counted zero.
- Provenance includes event count, first/last effective timestamp, and last recorded timestamp. `valuationStatus: "unavailable"`, `catalogMetadata: "current"`, and `quantityBasis: "signedLedgerEventsByUnit"` are explicit. Product labels and archive status are current metadata, not historical snapshots.

## CSV

**Export this page CSV** downloads only the displayed page; it does not silently fetch every page. Each row repeats site/cutoffs, quantity basis, valuation status, product identity, units, and provenance. Quotes, commas, and line breaks are escaped. Formula-like fields (including whitespace/control prefixes) are apostrophe-prefixed before quoting, including negative quantities. Import identifiers and quantities as text to preserve leading zeroes and decimal precision. There is no full-report export or frozen multi-page snapshot in this version.

## Query validation and production deployment gate

The forward migration `20260917130000_inventory_history_index` adds the provisional index `(organizationId, siteId, productId, occurredAt, createdAt)`. Correctness does not depend on it. No historical migration or ledger event is modified. It uses normal `CREATE INDEX`, which can block writes; production deployment requires separate approval and the controlled procedure in [the inventory-history index production runbook](INVENTORY-HISTORY-INDEX-PRODUCTION-RUNBOOK.md).

Before approval/deployment, use a disposable local **PostgreSQL 17** database with a name ending `_ci`, independently verify it is not a production tunnel, and from `apps/api` run:

```bash
INVENTORY_HISTORY_DB_VALIDATE=1 DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/inventory_history_ci node --import tsx scripts/inventoryHistoryDbValidation.ts
```

The script applies all forward migrations, checks migration status/index definition, creates real fixtures, and sends real Fastify requests backed by Prisma/PostgreSQL. It independently replays tenant/site-scoped raw ledger rows with exact decimal arithmetic and compares normal, backdated, reversal, transfer, negative, zero, empty, mixed-unit, archived, cutoff-boundary, provenance, and paginated results. It checks foreign-tenant/site and inactive-user/membership/org/site denial even for a global ADMIN.

CI PostgreSQL 17 query validation ran this workload with 300,000 synthetic events across 400 products, three sites and two tenants. It produced 36 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans for one/50/100-product pages, selective/broad effective cutoffs, and optional recorded cutoffs. Candidate, existing-index baseline, and effective-time-first alternatives were compared; the accepted query average was **7.829 ms**. Alternative DDL is transactional and rolled back; ledger protection is never disabled. Retain the output and review timing/buffer usage before confirming index order.

Fixtures retain immutable history. Destroy the entire disposable database after retaining evidence; the script never deletes protected ledger records. This CI query-validation result does **not** establish production index-build duration, storage/WAL demand, or lock safety. In particular, `docker-compose.prod.yml` declares PostgreSQL 16 while CI/render use PostgreSQL 17; verify the actual production PostgreSQL version during the runbook preflight.
