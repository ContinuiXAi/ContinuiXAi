import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify from "fastify";
import pg from "pg";
import { prisma } from "../src/lib/prisma.js";
import { storeCountRoutes } from "../src/routes/storeCount.js";
import { inventoryTruthRoutes } from "../src/routes/inventoryTruth.js";
import { productRoutes } from "../src/routes/products.js";

// Synthetic, expendable PostgreSQL only. Keep ledger/assignment history until
// database teardown; never disable RESTRICT, FK, or append-only protections.
async function main() {
  const connectionString = process.env.DATABASE_URL ?? "";
  const url = new URL(connectionString);
  assert(["localhost", "127.0.0.1", "postgres"].includes(url.hostname), "Use a disposable local database");
  assert(url.pathname.endsWith("_ci"), "Database name must end in _ci; independently verify this is not a production tunnel");
  const holder = new pg.Client({ connectionString, application_name: "truth-final-holder" });
  const observer = new pg.Client({ connectionString, application_name: "truth-final-observer" });
  await holder.connect(); await observer.connect();
  const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    Object.assign(request, { user: { sub: request.headers["x-fixture-actor"], role: "GENERAL" } });
  });
  await app.register(storeCountRoutes, { prefix: "/count" });
  await app.register(inventoryTruthRoutes, { prefix: "/truth" });
  await app.register(productRoutes, { prefix: "/products" });
  await app.ready();
  const suffix = randomUUID();
  const org = await prisma.organization.create({ data: { name: "Final count validator", slug: `final-${suffix}` } });
  const site = await prisma.site.create({ data: { organizationId: org.id, code: `F-${suffix}`, name: "Final count validation" } });
  const location = await prisma.storeLocation.create({ data: { siteId: site.id, code: `F-${suffix}`, name: "Shelf" } });
  const actors = await Promise.all(["a", "b", "manager"].map(async (name) => {
    const user = await prisma.user.create({ data: { name, email: `${name}-${suffix}@example.test`, passwordHash: "not-a-login" } });
    await prisma.organizationMembership.create({ data: { organizationId: org.id, userId: user.id, role: name === "manager" ? "MANAGER" : "INVENTORY" } });
    await prisma.siteMembership.create({ data: { siteId: site.id, userId: user.id } });
    return user;
  }));
  const [a, b, manager] = actors;
  const send = (actor: string, method: "GET" | "POST" | "PATCH", path: string, payload?: object) =>
    app.inject({ method, url: path, headers: { "x-fixture-actor": actor }, payload });
  const initial = new Date(Date.now() - 120_000);
  const start = new Date(Date.now() - 60_000);
  async function product(quantity = 15) {
    const item = await prisma.product.create({ data: { organizationId: org.id, name: "Component", barcodeValue: randomUUID() } });
    if (quantity > 0) {
      await prisma.inventoryTransaction.create({
        data: { organizationId: org.id, siteId: site.id, locationId: location.id, productId: item.id, type: "RECEIVE", quantity, createdAt: initial, occurredAt: initial },
      });
    }
    return item;
  }
  type Item = Awaited<ReturnType<typeof product>>;
  const snapshot = (item: Item) => ({ productId: item.id, locationId: location.id, isRequired: true, evidence: "ASSIGNED", product: { id: item.id, barcodeValue: item.barcodeValue, name: item.name, packageSize: item.packageSize }, location: { id: location.id, code: location.code, sortOrder: location.sortOrder } });
  async function count(item: Item, owner = a.id, actual = 13) {
    const session = await prisma.storeCountSession.create({ data: { siteId: site.id, startedById: a.id, assignedToId: owner, startedAt: start, routeSnapshot: [snapshot(item)] } });
    await prisma.storeCountAssignmentEvent.create({ data: { sessionId: session.id, toUserId: owner, assignedById: manager.id, reason: "Disposable fixture assignment" } });
    await prisma.storeCountExpectation.create({ data: { sessionId: session.id, productId: item.id, expectedStoreQty: 15 } });
    await prisma.storeCountLocationVisit.create({ data: { sessionId: session.id, locationId: location.id, status: "VERIFIED", completedById: owner, completedAt: new Date() } });
    const entry = await prisma.storeCountEntry.create({ data: { sessionId: session.id, productId: item.id, locationId: location.id, barcodeValue: item.barcodeValue!, quantity: actual, countedByUserId: owner } });
    const discrepancy = await prisma.storeCountDiscrepancy.create({ data: { sessionId: session.id, productId: item.id, expectedStoreQty: 15, actualStoreQty: actual, difference: actual - 15, reason: "COULD_NOT_FIND", explainedById: owner, explainedAt: new Date() } });
    return { session, entry, discrepancy, item };
  }
  type Count = Awaited<ReturnType<typeof count>>;
  const scan = (c: Count, actor = a.id, key = randomUUID(), barcodeValue = c.item.barcodeValue!, quantityDelta = 1) => send(actor, "POST", `/count/sessions/${c.session.id}/scan`, { barcodeValue, locationId: location.id, quantityDelta, clientScanId: key });
  const edit = (c: Count, actor = a.id, quantity = 12, expectedQuantity = c.entry.quantity) => send(actor, "PATCH", `/count/sessions/${c.session.id}/entries/${c.entry.id}`, { quantity, expectedQuantity });
  const verify = (c: Count, actor = a.id) => send(actor, "POST", `/truth/counts/${c.session.id}/locations/${location.id}/verify`, { offlineQueueFlushed: true });
  const finish = (c: Count, actor = a.id) => send(actor, "POST", `/count/sessions/${c.session.id}/complete`);
  const cancel = (c: Count, actor = a.id) => send(actor, "POST", `/count/sessions/${c.session.id}/cancel`);
  const reassign = (c: Count) => send(manager.id, "POST", `/truth/counts/${c.session.id}/reassign`, { toUserId: b.id, reason: "Audited handoff" });
  async function reviewToken(c: Count) {
    const review = await send(manager.id, "GET", `/truth/counts/${c.session.id}/review`);
    assert.equal(review.statusCode, 200, review.body);
    return review.json().discrepancies.find((row: { id: string }) => row.id === c.discrepancy.id).reviewToken as string;
  }
  const approve = (c: Count, token: string) => send(manager.id, "POST", `/truth/counts/${c.session.id}/discrepancies/${c.discrepancy.id}/approve`, { reviewToken: token });
  const unchanged = async (c: Count, quantity = 13) => {
    const entry = await prisma.storeCountEntry.findUniqueOrThrow({ where: { id: c.entry.id } });
    assert.equal(entry.quantity, quantity); assert.equal(entry.countedByUserId, c.entry.countedByUserId);
    assert.equal(await prisma.storeCountScanLog.count({ where: { sessionId: c.session.id } }), 0);
  };
  // No timer decides ordering. A separate backend observes actual blocked HTTP
  // writer connections before authority/state is changed or the lock released.
  async function waitForWriters(expected: number) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM pg_stat_activity
        WHERE pid <> $1 AND state = 'active' AND query LIKE '%StoreCountSession%'
          AND cardinality(pg_blocking_pids(pid)) > 0`, [holderPid]);
      if (result.rows[0].count >= expected) return;
      await sleep(10);
    }
    throw new Error(`Did not observe ${expected} blocked count writers; schedule is not proven`);
  }
  async function scheduled(c: Count, requests: Array<() => ReturnType<typeof send>>, beforeCommit?: () => Promise<unknown>) {
    await holder.query("BEGIN");
    try {
      await holder.query('SELECT "id" FROM "StoreCountSession" WHERE "id" = $1 FOR UPDATE', [c.session.id]);
      const pending = [];
      for (const request of requests) {
        pending.push(Promise.resolve(request()));
        await waitForWriters(pending.length);
      }
      await beforeCommit?.();
      await holder.query("COMMIT");
      return await Promise.all(pending);
    } catch (error) { await holder.query("ROLLBACK"); throw error; }
  }
  try {
    // Two simultaneous ACTIVE sessions, newer other-owner session must not win.
    const discoveryItem = await product();
    const acceptedStoreTotalAdjustment = await prisma.inventoryTransaction.create({
      data: {
        organizationId: org.id,
        siteId: site.id,
        locationId: null,
        productId: discoveryItem.id,
        type: "COUNT_ADJUSTMENT",
        quantity: 1,
        actorUserId: manager.id,
        reason: "Disposable nullable-location contract check",
      },
    });
    assert.equal(acceptedStoreTotalAdjustment.locationId, null);
    await assert.rejects(
      prisma.inventoryTransaction.create({
        data: { organizationId: org.id, siteId: site.id, locationId: null, productId: discoveryItem.id, type: "RECEIVE", quantity: 1 },
      }),
      /physical movement requires a Location/,
    );

    const owned = await count(discoveryItem); const other = await count(discoveryItem, b.id);
    await prisma.storeCountSession.update({ where: { id: other.session.id }, data: { startedAt: new Date() } });
    assert.equal((await send(a.id, "GET", "/count/sessions/active")).json().id, owned.session.id);
    assert.equal((await send(b.id, "POST", "/count/sessions", { siteId: site.id })).json().id, other.session.id);

    const conflictingReassignment = await reassign(owned);
    assert.equal(conflictingReassignment.statusCode, 409, conflictingReassignment.body);
    assert.match(conflictingReassignment.json().error, /finish or reassign/i);
    assert.equal((await prisma.storeCountSession.findUniqueOrThrow({ where: { id: owned.session.id } })).assignedToId, a.id);
    assert.equal(await prisma.storeCountAssignmentEvent.count({ where: { sessionId: owned.session.id } }), 1);
    assert.equal((await cancel(other, b.id)).statusCode, 200);

    const original = await prisma.storeCountSession.findUniqueOrThrow({ where: { id: owned.session.id } });
    assert.equal((await reassign(owned)).statusCode, 200);
    const restarted = await send(a.id, "POST", "/count/sessions", { siteId: site.id });
    assert.equal(restarted.statusCode, 201, restarted.body);
    const restartedSession = await prisma.storeCountSession.findUniqueOrThrow({ where: { id: restarted.json().id } });
    const handedOff = await prisma.storeCountSession.findUniqueOrThrow({ where: { id: owned.session.id } });
    assert.notEqual(restartedSession.id, handedOff.id);
    assert.equal(restartedSession.startedById, a.id);
    assert.equal(restartedSession.assignedToId, a.id);
    assert.equal(handedOff.startedById, original.startedById);
    assert.equal(handedOff.startedAt.getTime(), original.startedAt.getTime());
    assert.equal(handedOff.assignedToId, b.id);
    const handoffHistory = await prisma.storeCountAssignmentEvent.findMany({ where: { sessionId: owned.session.id }, orderBy: { occurredAt: "asc" } });
    assert.equal(handoffHistory.length, 2);
    assert.equal(handoffHistory[0].toUserId, a.id);
    assert.equal(handoffHistory[1].fromUserId, a.id);
    assert.equal(handoffHistory[1].toUserId, b.id);
    assert.equal((await send(a.id, "POST", `/count/sessions/${restartedSession.id}/cancel`)).statusCode, 200);

    for (const action of [scan, edit, verify, finish, cancel]) {
      assert.equal((await action(owned)).statusCode, 403);
      assert.equal((await action(owned, manager.id)).statusCode, 403);
    }
    await unchanged(owned);
    const history = await prisma.storeCountAssignmentEvent.findMany({ where: { sessionId: owned.session.id }, orderBy: { occurredAt: "asc" } });
    assert.equal(history.length, 2); assert.equal(history[1].fromUserId, a.id); assert.equal(history[1].toUserId, b.id); assert.equal(history[1].assignedById, manager.id);
    const originalKey = randomUUID();
    assert.equal((await scan(owned, b.id, originalKey)).statusCode, 200);
    assert.equal((await scan(owned, b.id, originalKey)).statusCode, 200);
    assert.equal((await edit(owned, b.id, 12, 14)).statusCode, 200);
    const edited = await prisma.storeCountEntry.findUniqueOrThrow({ where: { id: owned.entry.id } });
    assert.equal(edited.quantity, 12);
    assert.equal(edited.countedByUserId, b.id);
    assert.equal((await verify(owned, b.id)).statusCode, 200);
    assert.equal((await finish(owned, b.id)).statusCode, 200);
    const cancellable = await count(await product(), b.id);
    assert.equal((await cancel(cancellable, b.id)).statusCode, 200);

    // Reassignment wins before queued former-owner scan obtains its lock.
    const handoff = await count(await product());
    const handoffResults = await scheduled(handoff, [() => reassign(handoff), () => scan(handoff)]);
    assert.deepEqual(handoffResults.map((r) => r.statusCode), [200, 403]); await unchanged(handoff);
    assert.equal((await cancel(handoff, b.id)).statusCode, 200);
    const scanFirst = await count(await product());
    const scanFirstResults = await scheduled(scanFirst, [() => scan(scanFirst), () => reassign(scanFirst)]);
    assert.deepEqual(scanFirstResults.map((r) => r.statusCode), [200, 200]);
    assert.equal((await scan(scanFirst)).statusCode, 403);
    assert.equal((await prisma.storeCountEntry.findUniqueOrThrow({ where: { id: scanFirst.entry.id } })).quantity, 14);
    assert.equal((await cancel(scanFirst, b.id)).statusCode, 200);

    // A scan that wins the session lock makes an already-open correction stale.
    // Both are real HTTP requests on separate PostgreSQL connections.
    const scanBeforeEdit = await count(await product());
    const scanBeforeEditResults = await scheduled(scanBeforeEdit, [
      () => scan(scanBeforeEdit),
      () => edit(scanBeforeEdit, a.id, 12, 13),
    ]);
    assert.deepEqual(scanBeforeEditResults.map((r) => r.statusCode), [200, 409]);
    assert.match(scanBeforeEditResults[1].json().error, /changed on another device/i);
    assert.equal((await prisma.storeCountEntry.findUniqueOrThrow({ where: { id: scanBeforeEdit.entry.id } })).quantity, 14);
    assert.equal((await cancel(scanBeforeEdit)).statusCode, 200);

    // Omitted product is not zero, even with a stale VERIFIED visit and reason.
    const evidence = await count(await product()); const missing = await product();
    await prisma.storeCountSession.update({ where: { id: evidence.session.id }, data: { routeSnapshot: [snapshot(evidence.item), snapshot(missing)] } });
    const missingToken = await reviewToken(evidence);
    assert.equal((await verify(evidence)).statusCode, 409);
    assert.equal((await finish(evidence)).statusCode, 409);
    assert.equal((await approve(evidence, missingToken)).statusCode, 409);
    await prisma.productLocationHint.create({ data: { organizationId: org.id, siteId: site.id, productId: missing.id, locationId: location.id, evidence: "ASSIGNED" } });
    await prisma.productLocationHint.deleteMany({ where: { siteId: site.id, productId: missing.id } });
    const route = await send(a.id, "GET", `/truth/counts/${evidence.session.id}/route`);
    assert.equal(route.json().locations[0].products.length, 2);
    assert.equal((await scan(evidence, a.id, randomUUID(), missing.barcodeValue!, 0)).statusCode, 200);
    assert.equal((await verify(evidence)).statusCode, 200);
    assert.equal((await approve(evidence, await reviewToken(evidence))).statusCode, 200);
    await prisma.storeCountDiscrepancy.updateMany({
      where: { sessionId: evidence.session.id, status: "OPEN", reason: null },
      data: { reason: "COULD_NOT_FIND", explainedById: a.id, explainedAt: new Date() },
    });
    assert.equal((await finish(evidence)).statusCode, 200);

    // Parent aliases remain parent-only across active, revised, inactive recipes.
    const component = await product(); const parent = await product(0);
    const packaging = await prisma.productPackaging.create({ data: { productId: parent.id, level: "CASE", name: "Display", unitsOfEach: 1 } });
    const alias = randomUUID();
    await prisma.productIdentifier.create({ data: { organizationId: org.id, productId: parent.id, packagingId: packaging.id, type: "UPC", value: alias } });
    const display = await count(component);
    for (const quantity of [4, 6]) {
      const recipe = await send(manager.id, "POST", `/products/${parent.id}/compositions`, { parentPackagingId: packaging.id, components: [{ componentProductId: component.id, quantityPerParent: quantity }] });
      assert.equal(recipe.statusCode, 201, recipe.body);
      for (const barcode of [parent.barcodeValue!, alias]) assert.equal((await scan(display, a.id, randomUUID(), barcode)).statusCode, 409);
    }
    await prisma.productComposition.updateMany({ where: { parentPackagingId: packaging.id }, data: { isActive: false } });
    assert.equal((await scan(display, a.id, randomUUID(), alias)).statusCode, 409);
    await unchanged(display);
    assert.equal((await scan(display)).statusCode, 200);
    assert.equal(await prisma.storeCountEntry.count({ where: { sessionId: display.session.id, productId: parent.id } }), 0);
    assert.equal((await finish(display)).statusCode, 200);

    const legacy = await prisma.storeCountSession.create({ data: { startedById: a.id, assignedToId: null, routeSnapshot: [] } });
    assert.equal((await send(b.id, "POST", `/count/sessions/${legacy.id}/cancel`)).statusCode, 404);
    assert.equal((await send(a.id, "POST", `/count/sessions/${legacy.id}/cancel`)).statusCode, 200);
    assert.equal((await prisma.storeCountSession.findUniqueOrThrow({ where: { id: legacy.id } })).status, "CANCELLED");

    // Every relationship is revoked after preflight but before authoritative
    // session acquisition. Scan/PATCH are separate requests and assertions.
    for (const action of [scan, edit, verify, finish, cancel]) {
      for (const relation of ["user", "organization", "site", "orgMembership", "siteMembership"]) {
        const c = await count(await product());
        const [table, column, value] = relation === "user" ? ["User", "id", a.id]
          : relation === "organization" ? ["Organization", "id", org.id]
            : relation === "site" ? ["Site", "id", site.id]
              : relation === "orgMembership" ? ["OrganizationMembership", "userId", a.id] : ["SiteMembership", "userId", a.id];
        const results = await scheduled(c, [() => action(c)], () => holder.query(`UPDATE "${table}" SET "isActive" = false WHERE "${column}" = $1`, [value]));
        assert.equal(results[0].statusCode, 404, `${action.name}/${relation}: ${results[0].body}`);
        await holder.query(`UPDATE "${table}" SET "isActive" = true WHERE "${column}" = $1`, [value]);
        await unchanged(c);
        assert.equal((await prisma.storeCountSession.findUniqueOrThrow({ where: { id: c.session.id } })).status, "ACTIVE");
        assert.equal((await cancel(c)).statusCode, 200);
      }
    }

    // Cancellation obeys the same state transition lock in both real orders.
    for (const first of ["cancel", "finish", "approve"]) {
      const c = await count(await product()); const token = await reviewToken(c);
      const actions = first === "cancel" ? [() => cancel(c), () => finish(c)]
        : first === "finish" ? [() => finish(c), () => cancel(c)] : [() => approve(c, token), () => cancel(c)];
      const results = await scheduled(c, actions);
      assert.deepEqual(results.map((r) => r.statusCode), [200, 409]);
      assert.equal((await prisma.storeCountSession.findUniqueOrThrow({ where: { id: c.session.id } })).status, first === "cancel" ? "CANCELLED" : first === "finish" ? "COMPLETED" : "ACTIVE");
      assert.equal(await prisma.inventoryTransaction.count({ where: { referenceId: c.discrepancy.id } }), first === "approve" ? 1 : 0);
      await unchanged(c);
      if (first === "approve") assert.equal((await finish(c)).statusCode, 200);
    }
    const cancelFirst = await count(await product()); const cancelToken = await reviewToken(cancelFirst);
    assert.deepEqual((await scheduled(cancelFirst, [() => cancel(cancelFirst), () => approve(cancelFirst, cancelToken)])).map((r) => r.statusCode), [200, 409]);
    assert.equal(await prisma.inventoryTransaction.count({ where: { referenceId: cancelFirst.discrepancy.id } }), 0);
    console.log("Final inventory truth PostgreSQL validation passed: assigned discovery/handoff, real scan-versus-stale-edit conflict, frozen required zero evidence, recipe aliases/versions, all five authority revocations across scan/edit/verify/Finish/Cancel, and both cancellation/Finish/approval lock orders. Fixture evidence retained until disposable database teardown.");
  } finally { await app.close(); await holder.end(); await observer.end(); await prisma.$disconnect(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
