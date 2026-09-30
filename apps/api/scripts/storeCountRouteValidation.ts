import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { prisma } from "../src/lib/prisma.js";
import { productRoutes } from "../src/routes/products.js";
import { storeCountRoutes } from "../src/routes/storeCount.js";
import { inventoryTruthRoutes } from "../src/routes/inventoryTruth.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T;
}

async function main() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const adminEmail = `route-admin-${suffix}@example.test`;
  const userEmail = `route-user-${suffix}@example.test`;
  const unassignedEmail = `route-unassigned-${suffix}@example.test`;
  const organizationSlug = `route-org-${suffix}`;
  const siteCode = `SITE-${suffix}`;
  const locationCode = `ROUTE-${suffix}`;
  const barcodeAtomic = `route-atomic-${suffix}`;
  const barcodeRetry = `route-retry-${suffix}`;
  const barcodeConflict = `route-conflict-${suffix}`;
  const barcodeZero = `route-zero-${suffix}`;
  const barcodeCatalog = `route-catalog-${suffix}`;
  const barcodeCatalogChanged = `route-catalog-changed-${suffix}`;
  const compressedCosmeticUpc = "04210007";
  const expandedCosmeticUpc = "042000001007";
  const dualValidUpcE = "01234558";
  const dualValidUpcA = "012345000058";
  const concurrentDualCode = "00000116";
  const concurrentDualUpcA = "000100000016";
  const catalogName = `Catalog Product ${suffix}`;

  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: "store-count-route-validation-secret" });
  app.decorate("authenticate", async (request, reply) => {
    try { await request.jwtVerify(); } catch { await reply.code(401).send({ error: "unauthorized" }); }
  });
  await app.register(productRoutes, { prefix: "/api/products" });
  await app.register(storeCountRoutes, { prefix: "/api/store-count" });
  await app.register(inventoryTruthRoutes, { prefix: "/api/inventory-truth" });
  await app.ready();

  const connectionString = process.env.DATABASE_URL ?? "";
  const holder = new pg.Client({ connectionString, application_name: "store-count-catalog-holder" });
  const observer = new pg.Client({ connectionString, application_name: "store-count-catalog-observer" });
  await holder.connect();
  await observer.connect();
  const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);

  async function waitForBlockedSessionLock() {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM pg_stat_activity
        WHERE pid <> $1 AND state = 'active' AND query LIKE '%StoreCountSession%'
          AND $1 = ANY(pg_blocking_pids(pid))`, [holderPid]);
      if (result.rows[0].count > 0) return;
      await sleep(10);
    }
    throw new Error("Did not observe the HTTP scan blocked on StoreCountSession; catalog-race schedule is not proven");
  }

  let adminId: string | null = null;
  let userId: string | null = null;
  let unassignedUserId: string | null = null;
  let organizationId: string | null = null;
  let locationId: string | null = null;

  try {
    const [admin, user, unassignedUser] = await Promise.all([
      prisma.user.create({ data: { name: "Route Validation Admin", email: adminEmail, passwordHash: "not-used-in-route-validation", role: "ADMIN" } }),
      prisma.user.create({ data: { name: "Route Validation User", email: userEmail, passwordHash: "not-used-in-route-validation", role: "GENERAL" } }),
      prisma.user.create({ data: { name: "Route Unassigned User", email: unassignedEmail, passwordHash: "not-used-in-route-validation", role: "GENERAL" } }),
    ]);
    adminId = admin.id;
    userId = user.id;
    unassignedUserId = unassignedUser.id;

    const organization = await prisma.organization.create({ data: { name: "Route Validation Organization", slug: organizationSlug } });
    organizationId = organization.id;
    await prisma.organizationMembership.createMany({ data: [
      { organizationId: organization.id, userId: admin.id, role: "ADMIN", isActive: true },
      { organizationId: organization.id, userId: user.id, role: "INVENTORY", isActive: true },
    ] });
    const site = await prisma.site.create({ data: { organizationId: organization.id, code: siteCode, name: "Route validation site", type: "STORE", isActive: true } });
    await prisma.siteMembership.createMany({ data: [
      { siteId: site.id, userId: admin.id, isActive: true },
      { siteId: site.id, userId: user.id, isActive: true },
    ] });
    const location = await prisma.storeLocation.create({ data: { siteId: site.id, code: locationCode, name: "Route validation location", isActive: true } });
    locationId = location.id;
    await prisma.product.createMany({ data: [
      { organizationId, barcodeValue: barcodeAtomic, name: "Atomic route product", isActive: true },
      { organizationId, barcodeValue: barcodeRetry, name: "Retry route product", isActive: true },
      { organizationId, barcodeValue: barcodeConflict, name: "Conflict route product", isActive: true },
      { organizationId, barcodeValue: barcodeZero, name: "Confirmed-zero route product", isActive: true },
      { organizationId, barcodeValue: compressedCosmeticUpc, name: "Compressed cosmetic route product", isActive: true },
    ] });

    const adminToken = app.jwt.sign({ sub: admin.id, role: "ADMIN", tv: 0 });
    const userToken = app.jwt.sign({ sub: user.id, role: "GENERAL", tv: 0 });
    const unassignedToken = app.jwt.sign({ sub: unassignedUser.id, role: "GENERAL", tv: 0 });
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    // Live-pilot regression: a newly registered GENERAL user has no tenant/site
    // membership yet. With one unambiguous active organization/site available,
    // Start Count must provision the pilot membership rather than dead-end.
    const unassignedStart = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      headers: auth(unassignedToken),
      payload: { name: "Newly registered user pilot count" },
    });
    assert(unassignedStart.statusCode === 201, `unassigned pilot user could not start count: ${unassignedStart.statusCode} ${unassignedStart.body}`);
    const unassignedSession = parseJson<{ id: string; siteId: string | null }>(unassignedStart.body);
    assert(unassignedSession.siteId === site.id, "unassigned pilot user was not provisioned onto the only active site");
    const provisionedOrgMembership = await prisma.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId: organization.id, userId: unassignedUser.id } } });
    assert(provisionedOrgMembership?.isActive === true && provisionedOrgMembership.role === "INVENTORY", "pilot provisioning did not create active INVENTORY organization membership");
    const provisionedSiteMembership = await prisma.siteMembership.findUnique({ where: { siteId_userId: { siteId: site.id, userId: unassignedUser.id } } });
    assert(provisionedSiteMembership?.isActive === true, "pilot provisioning did not create active site membership");

    const startResponses = await Promise.all(Array.from({ length: 10 }, () => app.inject({ method: "POST", url: "/api/store-count/sessions", headers: auth(adminToken), payload: { name: "Route concurrency validation", siteId: site.id } })));
    for (const response of startResponses) assert(response.statusCode === 200 || response.statusCode === 201, `session creation returned ${response.statusCode}: ${response.body}`);
    const sessionIds = new Set(startResponses.map((response) => parseJson<{ id: string }>(response.body).id));
    assert(sessionIds.size === 1, `concurrent session creation produced ${sessionIds.size} ACTIVE sessions`);
    let sessionId = [...sessionIds][0]!;
    const activeSessionCount = await prisma.storeCountSession.count({ where: { startedById: admin.id, status: "ACTIVE", siteId: site.id } });
    assert(activeSessionCount === 1, `database contains ${activeSessionCount} ACTIVE sessions for one user/site`);

    const replacementResponse = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      headers: auth(adminToken),
      payload: { siteId: site.id, replaceEmptySessionId: sessionId },
    });
    assert(replacementResponse.statusCode === 201, `empty-session replacement returned ${replacementResponse.statusCode}: ${replacementResponse.body}`);
    const replacedSessionId = sessionId;
    sessionId = parseJson<{ id: string }>(replacementResponse.body).id;
    assert(sessionId !== replacedSessionId, "empty-session replacement returned the original session");
    const replacedSession = await prisma.storeCountSession.findUniqueOrThrow({ where: { id: replacedSessionId } });
    assert(replacedSession.status === "CANCELLED", "empty-session replacement did not cancel the original session atomically");
    const replacementRetry = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      headers: auth(adminToken),
      payload: { siteId: site.id, replaceEmptySessionId: replacedSessionId },
    });
    assert(replacementRetry.statusCode === 200, `empty-session replacement retry returned ${replacementRetry.statusCode}: ${replacementRetry.body}`);
    assert(parseJson<{ id: string }>(replacementRetry.body).id === sessionId, "replacement retry created or returned a different active session");

    const createCatalogProduct = await app.inject({ method: "POST", url: "/api/products", headers: auth(adminToken), payload: { barcodeValue: barcodeCatalog, name: catalogName, manufacturer: "Route Validation Co", packageSize: "12 ct", isActive: true } });
    assert(createCatalogProduct.statusCode === 201, `Product API create returned ${createCatalogProduct.statusCode}: ${createCatalogProduct.body}`);
    const createdCatalogProduct = parseJson<{ id: string; barcodeValue: string; name: string }>(createCatalogProduct.body);
    const catalogLookup = await app.inject({ method: "GET", url: `/api/products/by-barcode/${encodeURIComponent(barcodeCatalog)}`, headers: auth(adminToken) });
    assert(catalogLookup.statusCode === 200, `Product API barcode lookup returned ${catalogLookup.statusCode}: ${catalogLookup.body}`);
    assert(parseJson<{ id: string }>(catalogLookup.body).id === createdCatalogProduct.id, "Product API barcode lookup did not return the newly-created Product");
    const catalogScan = await app.inject({ method: "POST", url: `/api/store-count/sessions/${sessionId}/scan`, headers: auth(adminToken), payload: { barcodeValue: barcodeCatalog, locationId: location.id, quantityDelta: 1, clientScanId: `route-catalog-scan-${suffix}` } });
    assert(catalogScan.statusCode === 200, `newly cataloged Product scan returned ${catalogScan.statusCode}: ${catalogScan.body}`);
    const catalogEntry = parseJson<{ productId: string | null; quantity: number; product: { name: string } | null }>(catalogScan.body);
    assert(catalogEntry.productId === createdCatalogProduct.id && catalogEntry.product?.name === catalogName && catalogEntry.quantity === 1, "Store Count did not resolve the Product API catalog record correctly");
    const nonEmptyReplacement = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      headers: auth(adminToken),
      payload: { siteId: site.id, replaceEmptySessionId: sessionId },
    });
    assert(nonEmptyReplacement.statusCode === 409, `session with count evidence was replaced: ${nonEmptyReplacement.statusCode} ${nonEmptyReplacement.body}`);
    const stillActiveSession = await prisma.storeCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert(stillActiveSession.status === "ACTIVE", "rejected non-empty replacement changed the active session");

    const cosmeticProduct = await prisma.product.findUniqueOrThrow({
      where: { organizationId_barcodeValue: { organizationId, barcodeValue: compressedCosmeticUpc } },
    });
    const expandedLookup = await app.inject({
      method: "GET",
      url: `/api/products/by-barcode/${expandedCosmeticUpc}`,
      headers: auth(adminToken),
    });
    assert(expandedLookup.statusCode === 200, `expanded UPC-A lookup returned ${expandedLookup.statusCode}: ${expandedLookup.body}`);
    assert(parseJson<{ id: string }>(expandedLookup.body).id === cosmeticProduct.id, "expanded camera UPC did not resolve the legacy compressed product");
    const [cameraCosmeticScan, handheldCosmeticScan] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/store-count/sessions/${sessionId}/scan`,
        headers: auth(adminToken),
        payload: { barcodeValue: expandedCosmeticUpc, locationId: location.id, quantityDelta: 1, clientScanId: `route-camera-cosmetic-${suffix}` },
      }),
      app.inject({
        method: "POST",
        url: `/api/store-count/sessions/${sessionId}/scan`,
        headers: auth(adminToken),
        payload: { barcodeValue: compressedCosmeticUpc, locationId: location.id, quantityDelta: 1, clientScanId: `route-handheld-cosmetic-${suffix}` },
      }),
    ]);
    assert(cameraCosmeticScan.statusCode === 200, `camera cosmetic scan returned ${cameraCosmeticScan.statusCode}: ${cameraCosmeticScan.body}`);
    assert(handheldCosmeticScan.statusCode === 200, `handheld cosmetic scan returned ${handheldCosmeticScan.statusCode}: ${handheldCosmeticScan.body}`);
    const cosmeticEntry = await prisma.storeCountEntry.findFirstOrThrow({
      where: { sessionId, locationId: location.id, productId: cosmeticProduct.id },
    });
    assert(cosmeticEntry.productId === cosmeticProduct.id && cosmeticEntry.quantity === 2, "camera and handheld UPC forms did not accumulate on one product entry");
    const cosmeticEntryCount = await prisma.storeCountEntry.count({
      where: { sessionId, locationId: location.id, barcodeValue: { in: [compressedCosmeticUpc, expandedCosmeticUpc] } },
    });
    const cosmeticProductCount = await prisma.product.count({
      where: { organizationId, barcodeValue: { in: [compressedCosmeticUpc, expandedCosmeticUpc] } },
    });
    assert(cosmeticEntryCount === 1, `camera and handheld UPC forms produced ${cosmeticEntryCount} count entries, expected 1`);
    assert(cosmeticProductCount === 1, `camera and handheld UPC forms produced ${cosmeticProductCount} products, expected 1`);

    const dualProductResponse = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: auth(adminToken),
      payload: { barcodeValue: dualValidUpcE, barcodeFormat: "UPC_E", name: "Dual-valid UPC-E cosmetic", isActive: true },
    });
    assert(dualProductResponse.statusCode === 201, `explicit dual-valid UPC-E create returned ${dualProductResponse.statusCode}: ${dualProductResponse.body}`);
    const dualProduct = parseJson<{ id: string }>(dualProductResponse.body);
    const [dualCameraScan, dualHandheldScan] = await Promise.all([
      app.inject({ method: "POST", url: `/api/store-count/sessions/${sessionId}/scan`, headers: auth(adminToken), payload: { barcodeValue: dualValidUpcA, locationId: location.id, quantityDelta: 1, clientScanId: `route-dual-camera-${suffix}` } }),
      app.inject({ method: "POST", url: `/api/store-count/sessions/${sessionId}/scan`, headers: auth(adminToken), payload: { barcodeValue: dualValidUpcE, locationId: location.id, quantityDelta: 1, clientScanId: `route-dual-handheld-${suffix}` } }),
    ]);
    assert(dualCameraScan.statusCode === 200, `dual-valid camera scan returned ${dualCameraScan.statusCode}: ${dualCameraScan.body}`);
    assert(dualHandheldScan.statusCode === 200, `dual-valid handheld scan returned ${dualHandheldScan.statusCode}: ${dualHandheldScan.body}`);
    const dualEntry = await prisma.storeCountEntry.findUniqueOrThrow({
      where: { sessionId_locationId_barcodeValue: { sessionId, locationId: location.id, barcodeValue: dualValidUpcA } },
    });
    assert(dualEntry.productId === dualProduct.id && dualEntry.quantity === 2, "typed UPC-E alias did not unify concurrent camera and handheld scans");
    assert(await prisma.storeCountEntry.count({ where: { sessionId, locationId: location.id, productId: dualProduct.id } }) === 1, "typed UPC-E alias produced more than one count entry");

    const concurrentIdentityCreates = await Promise.all([
      app.inject({ method: "POST", url: "/api/products", headers: auth(adminToken), payload: { barcodeValue: concurrentDualCode, barcodeFormat: "UPC_E", name: "Concurrent UPC-E identity", isActive: true } }),
      app.inject({ method: "POST", url: "/api/products", headers: auth(adminToken), payload: { barcodeValue: concurrentDualCode, barcodeFormat: "EAN_8", name: "Concurrent EAN-8 identity", isActive: true } }),
    ]);
    assert(concurrentIdentityCreates.every((response) => response.statusCode === 201), `typed concurrent identity creates failed: ${concurrentIdentityCreates.map((response) => `${response.statusCode} ${response.body}`).join(" | ")}`);
    const concurrentUpcProduct = parseJson<{ id: string }>(concurrentIdentityCreates[0].body);
    const concurrentEanProduct = parseJson<{ id: string }>(concurrentIdentityCreates[1].body);
    assert(await prisma.product.count({ where: { organizationId, barcodeValue: { in: [concurrentDualCode, concurrentDualUpcA] } } }) === 2, "distinct concurrent EAN-8 and UPC-E identities were collapsed");
    assert(await prisma.productIdentifier.count({ where: { organizationId, type: "UPC", value: concurrentDualCode } }) === 1, "typed UPC-E alias was not persisted exactly once");
    const ambiguousRawLookup = await app.inject({ method: "GET", url: `/api/products/by-barcode/${concurrentDualCode}`, headers: auth(adminToken) });
    assert(ambiguousRawLookup.statusCode === 200, `exact EAN-8 lookup returned ${ambiguousRawLookup.statusCode}: ${ambiguousRawLookup.body}`);
    assert(parseJson<{ id: string }>(ambiguousRawLookup.body).id === concurrentEanProduct.id, "exact EAN-8 did not win over the distinct UPC-E alias");
    const typedCameraLookup = await app.inject({ method: "GET", url: `/api/products/by-barcode/${concurrentDualUpcA}`, headers: auth(adminToken) });
    assert(typedCameraLookup.statusCode === 200, `unambiguous UPC-A lookup returned ${typedCameraLookup.statusCode}: ${typedCameraLookup.body}`);
    assert(parseJson<{ id: string }>(typedCameraLookup.body).id === concurrentUpcProduct.id, "expanded UPC-A did not resolve its typed UPC-E product");

    // Deterministic stale-catalog proof. The scan completes its unlocked
    // product preflight and then blocks on the session row. While it is
    // blocked, the catalog writer changes that product's barcode and commits.
    // Once released, the scan must re-resolve under the organization lock and
    // reject without a count entry or idempotency log.
    const raceProduct = await prisma.product.create({
      data: { organizationId, barcodeValue: barcodeCatalogChanged, name: "Catalog race product", isActive: true },
    });
    const raceClientScanId = `route-catalog-race-${suffix}`;
    await holder.query("BEGIN");
    await holder.query('SELECT "id" FROM "StoreCountSession" WHERE "id" = $1 FOR UPDATE', [sessionId]);
    const blockedScan = app.inject({
      method: "POST",
      url: `/api/store-count/sessions/${sessionId}/scan`,
      headers: auth(adminToken),
      payload: { barcodeValue: barcodeCatalogChanged, locationId: location.id, quantityDelta: 1, clientScanId: raceClientScanId },
    });
    try {
      await waitForBlockedSessionLock();
      const catalogPatch = await app.inject({
        method: "PATCH",
        url: `/api/products/${raceProduct.id}?organizationId=${organization.id}`,
        headers: auth(adminToken),
        payload: { barcodeValue: `${barcodeCatalogChanged}-updated` },
      });
      assert(catalogPatch.statusCode === 200, `concurrent catalog PATCH returned ${catalogPatch.statusCode}: ${catalogPatch.body}`);
    } finally {
      await holder.query("COMMIT");
    }
    const staleCatalogScan = await blockedScan;
    assert(staleCatalogScan.statusCode === 409, `stale-catalog scan returned ${staleCatalogScan.statusCode}, expected 409: ${staleCatalogScan.body}`);
    assert(await prisma.storeCountEntry.count({ where: { sessionId, locationId: location.id, productId: raceProduct.id } }) === 0, "stale-catalog scan wrote a count entry");
    assert(await prisma.storeCountScanLog.count({ where: { idempotencyKey: raceClientScanId } }) === 0, "stale-catalog scan wrote an idempotency log");

    const atomicResponses = await Promise.all(Array.from({ length: 20 }, (_, index) => app.inject({ method: "POST", url: `/api/store-count/sessions/${sessionId}/scan`, headers: auth(adminToken), payload: { barcodeValue: barcodeAtomic, locationId: location.id, quantityDelta: 1, clientScanId: `route-atomic-${suffix}-${index}` } })));
    for (const response of atomicResponses) assert(response.statusCode === 200, `unique scan returned ${response.statusCode}: ${response.body}`);
    const atomicEntry = await prisma.storeCountEntry.findUniqueOrThrow({ where: { sessionId_locationId_barcodeValue: { sessionId, locationId: location.id, barcodeValue: barcodeAtomic } } });
    assert(atomicEntry.quantity === 20, `20 HTTP scans produced quantity ${atomicEntry.quantity}, expected 20`);

    const retryKey = `route-single-physical-scan-${suffix}`;
    const retryResponses = await Promise.all(Array.from({ length: 10 }, () => app.inject({ method: "POST", url: `/api/store-count/sessions/${sessionId}/scan`, headers: auth(adminToken), payload: { barcodeValue: barcodeRetry, locationId: location.id, quantityDelta: 1, clientScanId: retryKey } })));
    for (const response of retryResponses) assert(response.statusCode === 200, `idempotent retry returned ${response.statusCode}: ${response.body}`);
    const retryEntry = await prisma.storeCountEntry.findUniqueOrThrow({ where: { sessionId_locationId_barcodeValue: { sessionId, locationId: location.id, barcodeValue: barcodeRetry } } });
    assert(retryEntry.quantity === 1, `10 HTTP retries produced quantity ${retryEntry.quantity}, expected 1`);

    const zeroScan = await app.inject({ method: "POST", url: `/api/store-count/sessions/${sessionId}/scan`, headers: auth(adminToken), payload: { barcodeValue: barcodeZero, locationId: location.id, quantityDelta: 1, clientScanId: `route-zero-${suffix}` } });
    assert(zeroScan.statusCode === 200, `zero setup scan returned ${zeroScan.statusCode}: ${zeroScan.body}`);
    const zeroEntryId = parseJson<{ id: string }>(zeroScan.body).id;
    const zeroPatch = await app.inject({ method: "PATCH", url: `/api/store-count/sessions/${sessionId}/entries/${zeroEntryId}`, headers: auth(adminToken), payload: { quantity: 0, expectedQuantity: 1 } });
    assert(zeroPatch.statusCode === 200, `confirmed-zero PATCH returned ${zeroPatch.statusCode}: ${zeroPatch.body}`);
    const zeroEntry = await prisma.storeCountEntry.findUniqueOrThrow({ where: { id: zeroEntryId } });
    assert(zeroEntry.quantity === 0, `confirmed-zero entry stored quantity ${zeroEntry.quantity}, expected 0`);
    assert(zeroEntry.countedByUserId === admin.id, "confirmed-zero correction lost employee attribution");
    const zeroSummaryResponse = await app.inject({ method: "GET", url: `/api/store-count/sessions/${sessionId}/summary`, headers: auth(adminToken) });
    const zeroSummary = parseJson<{ rows: Array<{ barcodeValue: string; byLocation: Record<string, { quantity: number }> }> }>(zeroSummaryResponse.body);
    const zeroSummaryRow = zeroSummary.rows.find((row) => row.barcodeValue === barcodeZero);
    assert(Boolean(zeroSummaryRow), "summary omitted a verified-zero product/location");
    assert(zeroSummaryRow!.byLocation[location.id]?.quantity === 0, "summary did not preserve verified zero by location");

    const adminConflictKey = `route-conflict-admin-${suffix}`;
    const adminConflict = await app.inject({ method: "POST", url: `/api/store-count/sessions/${sessionId}/scan`, headers: auth(adminToken), payload: { barcodeValue: barcodeConflict, locationId: location.id, quantityDelta: 1, clientScanId: adminConflictKey } });
    assert(adminConflict.statusCode === 200, `admin conflict setup returned ${adminConflict.statusCode}: ${adminConflict.body}`);
    const userConflictKey = `route-conflict-user-${suffix}`;
    const collaborator = await app.inject({ method: "POST", url: `/api/store-count/sessions/${sessionId}/scan`, headers: auth(userToken), payload: { barcodeValue: barcodeConflict, locationId: location.id, quantityDelta: 1, clientScanId: userConflictKey } });
    assert(collaborator.statusCode === 403, `non-assignee scan returned ${collaborator.statusCode}: ${collaborator.body}`);
    const unchangedEntry = await prisma.storeCountEntry.findUniqueOrThrow({ where: { sessionId_locationId_barcodeValue: { sessionId, locationId: location.id, barcodeValue: barcodeConflict } } });
    assert(unchangedEntry.quantity === 1 && unchangedEntry.countedByUserId === admin.id, "non-assignee changed count evidence");
    const actorLogs = await prisma.storeCountScanLog.findMany({ where: { idempotencyKey: { in: [adminConflictKey, userConflictKey] } }, orderBy: { createdAt: "asc" } });
    assert(actorLogs.length === 1, `expected one authorized actor scan log, found ${actorLogs.length}`);
    assert(actorLogs.some((log) => log.userId === admin.id), "scan log missing admin actor");
    assert(!actorLogs.some((log) => log.userId === user.id), "non-assignee wrote a scan log");

    const userSessionResponse = await app.inject({ method: "POST", url: "/api/store-count/sessions", headers: auth(userToken), payload: { name: "Second-user session", siteId: site.id } });
    assert(userSessionResponse.statusCode === 201, `second user session returned ${userSessionResponse.statusCode}: ${userSessionResponse.body}`);
    const userSessionId = parseJson<{ id: string }>(userSessionResponse.body).id;
    const conflictKey = `route-cross-session-${suffix}`;
    const firstConflictKeyUse = await app.inject({ method: "POST", url: `/api/store-count/sessions/${sessionId}/scan`, headers: auth(adminToken), payload: { barcodeValue: barcodeConflict, locationId: location.id, quantityDelta: 1, clientScanId: conflictKey } });
    assert(firstConflictKeyUse.statusCode === 200, `first idempotency-key use returned ${firstConflictKeyUse.statusCode}`);
    const crossSessionReuse = await app.inject({ method: "POST", url: `/api/store-count/sessions/${userSessionId}/scan`, headers: auth(userToken), payload: { barcodeValue: barcodeConflict, locationId: location.id, quantityDelta: 1, clientScanId: conflictKey } });
    assert(crossSessionReuse.statusCode === 409, `cross-session idempotency-key reuse returned ${crossSessionReuse.statusCode}, expected 409`);

    const unexplainedFinish = await app.inject({ method: "POST", url: `/api/store-count/sessions/${sessionId}/complete`, headers: auth(adminToken) });
    assert(unexplainedFinish.statusCode === 409, `unexplained actual-only overages completed: ${unexplainedFinish.body}`);
    const differences = await prisma.storeCountDiscrepancy.findMany({ where: { sessionId, status: "OPEN" } });
    assert(differences.length > 0, "positive observations without baseline must create discrepancies");
    for (const difference of differences) {
      const explanation = await app.inject({ method: "PATCH", url: `/api/inventory-truth/counts/${sessionId}/discrepancies/${difference.id}/explain`, headers: auth(adminToken), payload: { reason: "OTHER_MANAGER_REVIEW", note: "Disposable fixture has no opening baseline; physical quantity checked." } });
      assert(explanation.statusCode === 200, `explanation failed: ${explanation.statusCode} ${explanation.body}`);
    }
    const completeResponse = await app.inject({ method: "POST", url: `/api/store-count/sessions/${sessionId}/complete`, headers: auth(adminToken) });
    assert(completeResponse.statusCode === 200, `session completion returned ${completeResponse.statusCode}: ${completeResponse.body}`);
    const completedScan = await app.inject({ method: "POST", url: `/api/store-count/sessions/${sessionId}/scan`, headers: auth(adminToken), payload: { barcodeValue: barcodeAtomic, locationId: location.id, quantityDelta: 1, clientScanId: `route-after-complete-${suffix}` } });
    assert(completedScan.statusCode === 409, `scan into completed session returned ${completedScan.statusCode}, expected 409`);
    const atomicAfterCompletion = await prisma.storeCountEntry.findUniqueOrThrow({ where: { sessionId_locationId_barcodeValue: { sessionId, locationId: location.id, barcodeValue: barcodeAtomic } } });
    assert(atomicAfterCompletion.quantity === 20, `rejected post-completion scan changed quantity to ${atomicAfterCompletion.quantity}`);

    console.log("Store Count HTTP route validation passed:");
    console.log("- newly registered unassigned pilot user is provisioned onto the single active organization/site");
    console.log("- concurrent session starts collapse to one ACTIVE session per user/site");
    console.log("- empty-session setup replacement is atomic and retry-safe; non-empty sessions are preserved");
    console.log("- Product API and Store Count resolve the same catalog record");
    console.log("- camera UPC-A and handheld UPC-E forms resolve one product and one accumulating count entry");
    console.log("- a catalog PATCH between scan preflight and locked authorization is detected; no stale count or retry log is written");
    console.log("- 20 concurrent unique HTTP scans => quantity 20");
    console.log("- 10 concurrent HTTP retries with one clientScanId => quantity 1");
    console.log("- confirmed zero remains persisted and visible in the location summary");
    console.log("- non-assignee capture is denied without entry or scan-log mutation");
    console.log("- unexplained overages reject Finish; explicit employee explanations permit completion");
    console.log("- clientScanId reuse across sessions => HTTP 409");
    console.log("- completed sessions reject new scans with HTTP 409 and preserve prior quantity");
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    if (organizationId) {
      const siteIds = (await prisma.site.findMany({ where: { organizationId }, select: { id: true } })).map((site) => site.id);
      await prisma.storeCountAssignmentEvent.deleteMany({ where: { session: { siteId: { in: siteIds } } } });
      if (siteIds.length > 0) await prisma.storeCountSession.deleteMany({ where: { siteId: { in: siteIds } } });
    }
    if (locationId) await prisma.storeLocation.deleteMany({ where: { id: locationId } });
    if (organizationId) {
      await prisma.siteMembership.deleteMany({ where: { site: { organizationId } } });
      await prisma.organizationMembership.deleteMany({ where: { organizationId } });
      await prisma.product.deleteMany({ where: { organizationId } });
      await prisma.site.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    const cleanupIds = [adminId, userId, unassignedUserId].filter((id): id is string => Boolean(id));
    if (cleanupIds.length) await prisma.user.deleteMany({ where: { id: { in: cleanupIds } } });
    await holder.end();
    await observer.end();
    await app.close();
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
