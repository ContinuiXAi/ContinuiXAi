import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type {} from "@fastify/jwt";
import { Prisma, type InventoryTransactionType } from "@prisma/client";
import pg from "pg";
import { prisma } from "../src/lib/prisma.js";
import { inventoryHistoryRoutes } from "../src/routes/inventoryHistory.js";

// Real PostgreSQL only. This intentionally retains immutable fixture events.
// Destroy the disposable database afterward; never disable ledger protections.
// Usage (from apps/api): INVENTORY_HISTORY_DB_VALIDATE=1 DATABASE_URL=<local *_ci>
//   node --import tsx scripts/inventoryHistoryDbValidation.ts
type Row = { product: { id: string; isActive: boolean }; quantity: string; unitOfMeasure: string | null; provenance: { eventCount: number; firstOccurredAt: string | null; lastOccurredAt: string | null; lastRecordedAt: string | null } };
type Response = { rows: Row[]; nextCursor: string | null; valuationStatus: string };
const cutoff = "2026-09-17T12:00:00.000Z";

async function main() {
  assert.equal(process.env.INVENTORY_HISTORY_DB_VALIDATE, "1", "Explicit opt-in is required; this writes synthetic data and applies migrations");
  assert(process.env.DATABASE_URL, "DATABASE_URL is required");
  const url = new URL(process.env.DATABASE_URL);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only an independently verified disposable local PostgreSQL server is allowed");
  assert(/\/[a-zA-Z0-9_]+_ci$/.test(url.pathname), "Disposable database name must end in _ci");
  const db = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 3000, application_name: "inventory-history-validator" });
  await db.connect();
  let app: FastifyInstance | undefined;
  let prismaUsed = false;
  try {
    const version = Number((await db.query("SHOW server_version_num")).rows[0].server_version_num);
    assert(version >= 170000 && version < 180000, "Validation requires real PostgreSQL 17");
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], { cwd, stdio: "inherit" });
    execFileSync("npx", ["--no-install", "prisma", "migrate", "status"], { cwd, stdio: "inherit" });
    const index = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'InventoryTransaction' AND indexname = 'InventoryTransaction_history_idx'`);
    assert.equal(index.rowCount, 1, "Forward migration did not install the candidate index");
    assert(index.rows[0].indexdef.includes('("organizationId", "siteId", "productId", "occurredAt", "createdAt")'), "Unexpected candidate index order");
    console.log("Migrations and provisional index definition verified on PostgreSQL", version);

    prismaUsed = true;
    const suffix = randomUUID();
    const org = await prisma.organization.create({ data: { name: "History fixture", slug: `history-${suffix}` } });
    const foreignOrg = await prisma.organization.create({ data: { name: "Foreign history fixture", slug: `history-foreign-${suffix}` } });
    const site = await prisma.site.create({ data: { organizationId: org.id, name: "History A", code: "A" } });
    const otherSite = await prisma.site.create({ data: { organizationId: org.id, name: "History B", code: "B" } });
    const foreignSite = await prisma.site.create({ data: { organizationId: foreignOrg.id, name: "History foreign", code: "C" } });
    const sites = [site, otherSite, foreignSite];
    const locations = await Promise.all(sites.map((s) => prisma.storeLocation.create({ data: { siteId: s.id, code: `history-${suffix}-${s.id}`, name: "Synthetic location" } })));
    const user = await prisma.user.create({ data: { name: "History manager", email: `history-${suffix}@example.test`, passwordHash: "not-a-login", role: "ADMIN" } });
    const orgMembership = await prisma.organizationMembership.create({ data: { organizationId: org.id, userId: user.id, role: "MANAGER" } });
    const siteMembership = await prisma.siteMembership.create({ data: { siteId: site.id, userId: user.id } });
    const otherMembership = await prisma.siteMembership.create({ data: { siteId: otherSite.id, userId: user.id } });
    const names = ["normal", "backdated", "reversal", "transfer", "negative", "empty", "mixed", "recordedBoundary"];
    const products = await Promise.all(names.map((name) => prisma.product.create({ data: { organizationId: org.id, name, barcodeValue: `${suffix}-${name}`, isActive: name !== "normal" } })));
    const [normal, backdated, reversal, transfer, negative, empty, mixed, recordedBoundary] = products;
    const foreignProduct = await prisma.product.create({ data: { organizationId: foreignOrg.id, name: "Foreign", barcodeValue: `${suffix}-foreign` } });
    async function event(productId: string, quantity: string, type: InventoryTransactionType, occurredAt = "2026-09-01T00:00:00Z", createdAt = occurredAt, siteIndex = 0, unitOfMeasure = "EACH", referenceId?: string) {
      return prisma.inventoryTransaction.create({ data: { organizationId: sites[siteIndex].organizationId, siteId: sites[siteIndex].id, locationId: locations[siteIndex].id, productId, quantity, type, occurredAt: new Date(occurredAt), createdAt: new Date(createdAt), unitOfMeasure, referenceType: referenceId ? "fixture-reversal" : undefined, referenceId } });
    }
    await event(normal.id, "10", "RECEIVE"); await event(normal.id, "-3", "SHIP", "2026-09-02T00:00:00Z");
    await event(normal.id, "100", "RECEIVE", cutoff); // excluded exactly at effective cutoff
    await event(backdated.id, "5", "RECEIVE"); await event(backdated.id, "4", "RECEIVE", "2026-09-02T00:00:00Z", "2026-09-20T00:00:00Z");
    const original = await event(reversal.id, "6", "RECEIVE"); await event(reversal.id, "-6", "MANUAL_ADJUSTMENT", "2026-09-02T00:00:00Z", "2026-09-02T00:00:00Z", 0, "EACH", original.id);
    await event(transfer.id, "10", "RECEIVE"); await event(transfer.id, "-4", "TRANSFER_OUT", "2026-09-02T00:00:00Z"); await event(transfer.id, "4", "TRANSFER_IN", "2026-09-02T00:00:00Z", "2026-09-02T00:00:00Z", 1);
    await event(negative.id, "-2.5001", "DAMAGE");
    await event(mixed.id, "2", "RECEIVE"); await event(mixed.id, "0.1250", "RECEIVE", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", 0, "KG");
    await event(recordedBoundary.id, "1", "RECEIVE", "2026-09-01T00:00:00Z", "2026-09-17T11:59:59.999Z"); await event(recordedBoundary.id, "2", "RECEIVE", "2026-09-01T00:00:00Z", cutoff);
    await event(normal.id, "777", "RECEIVE", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", 1);
    await event(foreignProduct.id, "999", "RECEIVE", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", 2);

    app = Fastify();
    app.decorate("authenticate", async (request) => { Object.assign(request, { user: { sub: user.id, role: "ADMIN" } }); });
    await app.register(inventoryHistoryRoutes, { prefix: "/history" });
    const get = (siteId: string, recordedBefore?: string, cursor?: string, limit = 2) => app!.inject(`/history/sites/${siteId}/as-of?${new URLSearchParams({ asOfExclusive: cutoff, limit: String(limit), ...(recordedBefore ? { recordedBefore } : {}), ...(cursor ? { cursor } : {}) })}`);
    async function report(siteId: string, recordedBefore?: string) {
      const rows: Row[] = [], cursors = new Set<string>(); let cursor: string | undefined;
      do {
        const response = await get(siteId, recordedBefore, cursor);
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json<Response>(); assert.equal(body.valuationStatus, "unavailable");
        rows.push(...body.rows); cursor = body.nextCursor ?? undefined;
        if (cursor) { assert(!cursors.has(cursor), "Pagination loop"); cursors.add(cursor); }
      } while (cursor);
      return rows;
    }
    // Independent replay: fetch tenant/site-scoped raw events, filter timestamps
    // and sum exact decimals here, without reusing production aggregation logic.
    async function reconcile(siteId: string, recordedBefore?: string) {
      // Stored timestamp-without-time-zone values represent UTC. Return them
      // as timestamptz so pg parsing is independent of the operator's timezone.
      const raw = await db.query<{ productId: string; quantity: string; unitOfMeasure: string; occurredAt: Date; createdAt: Date }>(`SELECT "productId", quantity::text, "unitOfMeasure", "occurredAt" AT TIME ZONE 'UTC' AS "occurredAt", "createdAt" AT TIME ZONE 'UTC' AS "createdAt" FROM "InventoryTransaction" WHERE "organizationId" = $1 AND "siteId" = $2 AND "productId" = ANY($3::text[]) ORDER BY "id"`, [org.id, siteId, products.map((p) => p.id)]);
      const rows = await report(siteId, recordedBefore);
      for (const product of products) {
        const selected = raw.rows.filter((r) => r.productId === product.id && r.occurredAt.getTime() < Date.parse(cutoff) && (!recordedBefore || r.createdAt.getTime() < Date.parse(recordedBefore)));
        const units = [...new Set(selected.map((r) => r.unitOfMeasure))].sort();
        const actual = rows.filter((r) => r.product.id === product.id);
        assert.equal(actual.length, units.length || 1);
        if (!units.length) { assert.equal(actual[0].quantity, "0.0000"); assert.equal(actual[0].unitOfMeasure, null); assert.equal(actual[0].provenance.eventCount, 0); }
        for (const unit of units) {
          const events = selected.filter((r) => r.unitOfMeasure === unit);
          const row = actual.find((r) => r.unitOfMeasure === unit)!;
          assert.equal(row.quantity, events.reduce((sum, r) => sum.plus(r.quantity), new Prisma.Decimal(0)).toFixed(4));
          assert.equal(row.provenance.eventCount, events.length);
          assert.equal(row.provenance.firstOccurredAt, new Date(Math.min(...events.map((r) => r.occurredAt.getTime()))).toISOString());
          assert.equal(row.provenance.lastOccurredAt, new Date(Math.max(...events.map((r) => r.occurredAt.getTime()))).toISOString());
          assert.equal(row.provenance.lastRecordedAt, new Date(Math.max(...events.map((r) => r.createdAt.getTime()))).toISOString());
        }
      }
      assert.equal(rows.length, products.length + (siteId === site.id ? 1 : 0)); // mixed product has two units only at A
      assert(!rows.some((r) => r.product.id === foreignProduct.id));
      return rows;
    }
    const quantity = (rows: Row[], id: string, unit = "EACH") => rows.find((r) => r.product.id === id && r.unitOfMeasure === unit)?.quantity;
    const latest = await reconcile(site.id); const known = await reconcile(site.id, cutoff); const destination = await reconcile(otherSite.id);
    assert.equal(quantity(latest, normal.id), "7.0000"); assert.equal(quantity(latest, backdated.id), "9.0000"); assert.equal(quantity(known, backdated.id), "5.0000");
    assert.equal(quantity(latest, reversal.id), "0.0000"); assert.equal(quantity(latest, transfer.id), "6.0000"); assert.equal(quantity(destination, transfer.id), "4.0000");
    assert.equal(quantity(latest, negative.id), "-2.5001"); assert.equal(quantity(latest, mixed.id, "KG"), "0.1250"); assert.equal(quantity(latest, recordedBoundary.id), "3.0000"); assert.equal(quantity(known, recordedBoundary.id), "1.0000");
    assert.equal(latest.find((r) => r.product.id === empty.id)!.provenance.eventCount, 0); assert.equal(latest.find((r) => r.product.id === normal.id)!.product.isActive, false);
    assert.equal((await get(foreignSite.id)).statusCode, 404);
    const foreignSiteMembership = await prisma.siteMembership.create({ data: { siteId: foreignSite.id, userId: user.id } });
    assert.equal((await get(foreignSite.id)).statusCode, 404, "Site membership alone must not bypass organization membership");
    await prisma.siteMembership.update({ where: { id: foreignSiteMembership.id }, data: { isActive: false } });
    for (const [label, change] of [
      ["site membership", (active: boolean) => prisma.siteMembership.update({ where: { id: siteMembership.id }, data: { isActive: active } })],
      ["organization membership", (active: boolean) => prisma.organizationMembership.update({ where: { id: orgMembership.id }, data: { isActive: active } })],
      ["user", (active: boolean) => prisma.user.update({ where: { id: user.id }, data: { isActive: active } })],
      ["site", (active: boolean) => prisma.site.update({ where: { id: site.id }, data: { isActive: active } })],
      ["organization", (active: boolean) => prisma.organization.update({ where: { id: org.id }, data: { isActive: active } })],
    ] as const) {
      await change(false); assert.equal((await get(site.id)).statusCode, 404, `Global ADMIN bypassed inactive ${label}`); await change(true);
    }
    await prisma.siteMembership.update({ where: { id: otherMembership.id }, data: { isActive: false } });
    assert.equal((await get(otherSite.id)).statusCode, 404, "Same organization is not sufficient for another site");
    console.log("PASS: raw replay, hand-derived balances, cutoffs, pagination, archived/empty/multi-unit history, tenant and active-membership predicates");

    // Representative synthetic fixture: 400 products, 3 sites / 2 tenants,
    // 300,000 events spanning a year, with delayed recording times. Retain the
    // existing production indexes; compare candidate vs effective-time-first
    // and baseline using transactional DDL that is always rolled back.
    const performanceProducts = new Map<string, string[]>();
    for (const organizationId of [org.id, foreignOrg.id]) {
      const ids = Array.from({ length: 200 }, () => randomUUID());
      await prisma.product.createMany({ data: ids.map((id, i) => ({ id, organizationId, name: `Performance ${i}`, barcodeValue: `${suffix}-${id}` })) });
      performanceProducts.set(organizationId, ids);
    }
    for (const s of sites) {
      await db.query(`INSERT INTO "InventoryTransaction" ("id", "organizationId", "siteId", "productId", "type", "quantity", "unitOfMeasure", "occurredAt", "createdAt")
        SELECT $1 || '-' || p.id || '-' || g::text, $2, $3, p.id, 'MANUAL_ADJUSTMENT', 1.0000, 'EACH',
          timestamp '2026-01-01' + (g % 365) * interval '1 day',
          timestamp '2026-01-01' + (g % 365) * interval '1 day' + (g % 7) * interval '1 hour'
        FROM "Product" p CROSS JOIN generate_series(1, 500) g
        WHERE p."organizationId" = $2 AND p.id = ANY($4::text[])`, [`${suffix}-${s.id}`, s.organizationId, s.id, performanceProducts.get(s.organizationId)]);
      const count = await db.query(`SELECT count(*)::int AS n FROM "InventoryTransaction" WHERE "organizationId" = $1 AND "siteId" = $2 AND "productId" = ANY($3::text[])`, [s.organizationId, s.id, performanceProducts.get(s.organizationId)]);
      assert.equal(count.rows[0].n, 100000);
    }
    await db.query('ANALYZE "InventoryTransaction"');
    const explain = async (variant: string) => {
      for (const size of [1, 50, 100]) for (const effective of ["2026-01-03T00:00:00Z", "2026-11-01T00:00:00Z"]) for (const recorded of [null, "2026-06-01T00:00:00Z"]) {
        const parameters = [org.id, site.id, performanceProducts.get(org.id)!.slice(0, size), effective, ...(recorded ? [recorded] : [])];
        const result = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT "productId", "unitOfMeasure", SUM(quantity), COUNT(*), MIN("occurredAt"), MAX("occurredAt"), MAX("createdAt")
          FROM "InventoryTransaction" WHERE "organizationId" = $1 AND "siteId" = $2 AND "productId" = ANY($3::text[])
            AND "occurredAt" < $4::timestamp ${recorded ? 'AND "createdAt" < $5::timestamp' : ''}
          GROUP BY "productId", "unitOfMeasure" ORDER BY "productId", "unitOfMeasure"`, parameters);
        console.log(JSON.stringify({ variant, size, effective, recorded, explain: result.rows[0]["QUERY PLAN"] }));
      }
    };
    await explain("candidate-product-before-effective");
    for (const alternative of ["baseline-existing-indexes", "effective-before-product"]) {
      await db.query("BEGIN");
      try {
        await db.query('DROP INDEX "InventoryTransaction_history_idx"');
        if (alternative === "effective-before-product") await db.query('CREATE INDEX "InventoryTransaction_history_validation_alternative" ON "InventoryTransaction" ("organizationId", "siteId", "occurredAt", "productId", "createdAt")');
        await explain(alternative);
      } finally { await db.query("ROLLBACK"); }
    }
    console.log("PASS: PostgreSQL reconciliation and 36 EXPLAIN (ANALYZE, BUFFERS) comparisons executed. Review plans/timings before finalizing index order; this script does not automatically approve it.");
    console.log("Synthetic immutable fixture retained. Destroy the disposable database after retaining output.");
  } finally { await app?.close(); if (prismaUsed) await prisma.$disconnect(); await db.end(); }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
