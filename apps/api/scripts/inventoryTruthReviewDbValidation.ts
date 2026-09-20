import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { prisma } from "../src/lib/prisma.js";
import { inventoryTruthRoutes } from "../src/routes/inventoryTruth.js";
import { storeCountRoutes } from "../src/routes/storeCount.js";

// Disposable CI database only. Append-only ledger fixtures intentionally remain
// until the database service is destroyed; never disable ledger protections.
async function main() {
  assert(["localhost", "127.0.0.1", "postgres"].includes(new URL(process.env.DATABASE_URL ?? "").hostname), "Use a disposable local PostgreSQL database");
  const suffix = randomUUID();
  const manager = await prisma.user.create({ data: { name: "Review validator", email: `review-${suffix}@example.test`, passwordHash: "not-a-login", role: "GENERAL" } });
  const organization = await prisma.organization.create({ data: { name: "Review validator", slug: `review-${suffix}` } });
  const site = await prisma.site.create({ data: { organizationId: organization.id, code: `R-${suffix}`, name: "Review validation" } });
  await prisma.organizationMembership.create({ data: { organizationId: organization.id, userId: manager.id, role: "MANAGER" } });
  await prisma.siteMembership.create({ data: { siteId: site.id, userId: manager.id } });
  const location = await prisma.storeLocation.create({ data: { siteId: site.id, code: `R-${suffix}`, name: "Shelf" } });
  const app = Fastify();
  app.decorate("authenticate", async (request) => { Object.assign(request, { user: { sub: manager.id, role: "GENERAL" } }); });
  await app.register(inventoryTruthRoutes, { prefix: "/api/inventory-truth" });
  await app.register(storeCountRoutes, { prefix: "/api/store-count" });
  const initial = new Date(Date.now() - 60_000);
  const overlappingStart = new Date(Date.now() - 30_000);
  async function product() {
    const result = await prisma.product.create({ data: { organizationId: organization.id, name: "Count product", barcodeValue: randomUUID() } });
    await prisma.inventoryTransaction.create({ data: { organizationId: organization.id, siteId: site.id, locationId: location.id, productId: result.id, type: "RECEIVE", quantity: 15, createdAt: initial, occurredAt: initial } });
    return result;
  }
  async function count(productId: string, barcodeValue: string, startedAt = overlappingStart, expected = 15, actual = 13, status: "ACTIVE" | "COMPLETED" = "COMPLETED") {
    const activeSession = await prisma.storeCountSession.create({ data: { siteId: site.id, startedById: manager.id, assignedToId: manager.id, startedAt, status: "ACTIVE" } });
    await prisma.storeCountLocationVisit.create({ data: { sessionId: activeSession.id, locationId: location.id, status: "VERIFIED", completedById: manager.id, completedAt: new Date() } });
    const entry = await prisma.storeCountEntry.create({ data: { sessionId: activeSession.id, productId, barcodeValue, locationId: location.id, quantity: actual } });
    await prisma.storeCountExpectation.create({ data: { sessionId: activeSession.id, productId, expectedStoreQty: expected } });
    const discrepancy = await prisma.storeCountDiscrepancy.create({ data: { sessionId: activeSession.id, productId, expectedStoreQty: expected, actualStoreQty: actual, difference: actual - expected, reason: "COULD_NOT_FIND", note: "Checked all locations", explainedById: manager.id, explainedAt: new Date() } });
    const session = status === "COMPLETED"
      ? await prisma.storeCountSession.update({ where: { id: activeSession.id }, data: { status: "COMPLETED", completedAt: new Date() } })
      : activeSession;
    const review = await app.inject({ method: "GET", url: `/api/inventory-truth/counts/${session.id}/review` });
    assert.equal(review.statusCode, 200, review.body);
    return { session, entry, discrepancy, token: review.json().discrepancies[0].reviewToken as string };
  }
  type Count = Awaited<ReturnType<typeof count>>;
  const approve = (value: Count) => app.inject({ method: "POST", url: `/api/inventory-truth/counts/${value.session.id}/discrepancies/${value.discrepancy.id}/approve`, payload: { reviewToken: value.token } });
  const total = async (productId: string) => Number((await prisma.inventoryTransaction.aggregate({ where: { siteId: site.id, productId }, _sum: { quantity: true } }))._sum.quantity);
  try {
    for (const order of [[0, 1], [1, 0]]) {
      const item = await product();
      const sessions = [await count(item.id, item.barcodeValue!), await count(item.id, item.barcodeValue!)];
      assert.equal((await approve(sessions[order[0]])).statusCode, 200);
      assert.equal((await approve(sessions[order[1]])).statusCode, 409);
      assert.equal((await approve(sessions[order[0]])).statusCode, 200);
      assert.equal(await total(item.id), 13);
    }
    const item = await product();
    const a = await count(item.id, item.barcodeValue!); const b = await count(item.id, item.barcodeValue!);
    const results = await Promise.all([approve(a), approve(b)]);
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
    assert.equal(await total(item.id), 13);
    // Ensure timestamps differ at the schema's millisecond precision.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = await count(item.id, item.barcodeValue!, new Date(), 13, 12);
    assert.equal((await approve(later)).statusCode, 200); assert.equal(await total(item.id), 12);

    const receiptProduct = await product();
    const stale = await count(receiptProduct.id, receiptProduct.barcodeValue!);
    await prisma.inventoryTransaction.create({ data: { organizationId: organization.id, siteId: site.id, locationId: location.id, productId: receiptProduct.id, type: "RECEIVE", quantity: 3, occurredAt: initial } });
    assert.equal((await approve(stale)).statusCode, 409); assert.equal(await total(receiptProduct.id), 18);
    const legacyProduct = await product(); const legacy = await count(legacyProduct.id, legacyProduct.barcodeValue!);
    await prisma.inventoryTransaction.create({ data: { organizationId: organization.id, siteId: site.id, locationId: location.id, productId: legacyProduct.id, type: "RECEIVE", quantity: 3, createdAt: initial, occurredAt: initial } });
    assert.equal((await approve(legacy)).statusCode, 409); assert.equal(await total(legacyProduct.id), 18);

    // The supported mutable UPC must not overwrite an approved entry's identity.
    const guardedProduct = await product(); const guarded = await count(guardedProduct.id, guardedProduct.barcodeValue!, overlappingStart, 15, 13, "ACTIVE");
    assert.equal((await approve(guarded)).statusCode, 200);
    await prisma.product.update({ where: { id: guardedProduct.id }, data: { barcodeValue: randomUUID() } });
    const replacement = await prisma.product.create({ data: { organizationId: organization.id, name: "Replacement UPC product", barcodeValue: guardedProduct.barcodeValue } });
    const remapped = await app.inject({ method: "POST", url: `/api/store-count/sessions/${guarded.session.id}/scan`, payload: { barcodeValue: replacement.barcodeValue, locationId: location.id, quantityDelta: 1, clientScanId: randomUUID() } });
    assert.equal(remapped.statusCode, 409, remapped.body);
    const original = await prisma.storeCountEntry.findUniqueOrThrow({ where: { id: guarded.entry.id } });
    assert.equal(original.productId, guardedProduct.id); assert.equal(original.quantity, 13);
    const discovery = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/reviews" });
    assert.equal(discovery.statusCode, 200, discovery.body);
    assert(discovery.json().pending.some((value: { id: string }) => value.id === stale.session.id));
    await prisma.organizationMembership.update({ where: { organizationId_userId: { organizationId: organization.id, userId: manager.id } }, data: { isActive: false } });
    assert.equal((await approve(later)).statusCode, 404);
    assert.equal(await total(item.id), 12);
    const revokedList = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/reviews" });
    assert.deepEqual(revokedList.json(), { pending: [], completed: [] });
    console.log("Inventory truth PostgreSQL validation passed: both overlapping approval orders, concurrent sessions, idempotent retry, later valid count, backdated receipt fence, exact ledger totals, immutable remapped-UPC evidence.");
  } finally { await app.close(); await prisma.$disconnect(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
