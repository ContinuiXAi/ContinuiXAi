import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { prisma } from "../src/lib/prisma.js";
import { storeCountRoutes } from "../src/routes/storeCount.js";
import { inventoryTruthRoutes } from "../src/routes/inventoryTruth.js";
import { storeCountExportRoutes } from "../src/routes/storeCountExport.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: "store-count-site-authorization-validation" });
  app.decorate("authenticate", async (request, reply) => {
    try { await request.jwtVerify(); } catch { await reply.code(401).send({ error: "unauthorized" }); }
  });
  await app.register(storeCountRoutes, { prefix: "/api/store-count" });
  await app.register(storeCountExportRoutes, { prefix: "/api/store-count" });
  await app.register(inventoryTruthRoutes, { prefix: "/api/inventory-truth" });
  await app.ready();

  let userId: string | null = null;
  let adminId: string | null = null;
  let organizationId: string | null = null;

  try {
    const user = await prisma.user.create({
      data: {
        name: "Site scoped counter",
        email: `site-counter-${suffix}@example.test`,
        passwordHash: "not-used",
        role: "GENERAL",
      },
    });
    userId = user.id;

    const admin = await prisma.user.create({
      data: {
        name: "Organization-wide site admin",
        email: `site-admin-${suffix}@example.test`,
        passwordHash: "not-used",
        role: "ADMIN",
      },
    });
    adminId = admin.id;

    const organization = await prisma.organization.create({
      data: { name: "Two Site Count Validation", slug: `two-site-${suffix}` },
    });
    organizationId = organization.id;

    await prisma.organizationMembership.create({
      data: { organizationId: organization.id, userId: user.id, role: "INVENTORY", isActive: true },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: organization.id, userId: admin.id, role: "ADMIN", isActive: true },
    });

    const siteA = await prisma.site.create({
      data: { organizationId: organization.id, code: `A-${suffix}`, name: "Authorized Site", type: "STORE", isActive: true },
    });
    const siteB = await prisma.site.create({
      data: { organizationId: organization.id, code: `B-${suffix}`, name: "Unauthorized Site", type: "STORE", isActive: true },
    });
    await prisma.siteMembership.create({ data: { siteId: siteA.id, userId: user.id, isActive: true } });
    const location = await prisma.storeLocation.create({
      data: { siteId: siteB.id, code: `ADMIN-${suffix}`, name: "ADMIN validation shelf", isActive: true },
    });
    const product = await prisma.product.create({
      data: { organizationId: organization.id, name: "ADMIN validation product", barcodeValue: `ADMIN-${suffix}`, isActive: true },
    });
    await prisma.productLocationHint.create({
      data: {
        organizationId: organization.id,
        siteId: siteB.id,
        productId: product.id,
        locationId: location.id,
        evidence: "ASSIGNED",
        isRequired: true,
      },
    });

    const token = app.jwt.sign({ sub: user.id, role: "GENERAL", tv: 0 });
    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Must not start", siteId: siteB.id },
    });

    assert(response.statusCode === 403, `site-scoped user started Count at unauthorized Site B: ${response.statusCode} ${response.body}`);
    const unauthorizedSessions = await prisma.storeCountSession.count({ where: { siteId: siteB.id, startedById: user.id } });
    assert(unauthorizedSessions === 0, `unauthorized Site B session was persisted (${unauthorizedSessions})`);

    const adminToken = app.jwt.sign({ sub: admin.id, role: "ADMIN", tv: 0 });
    const adminStart = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Organization-wide admin count", siteId: siteB.id },
    });
    assert(adminStart.statusCode === 201, `organization ADMIN without SiteMembership could not start Count: ${adminStart.statusCode} ${adminStart.body}`);
    const adminSession = JSON.parse(adminStart.body) as { id: string; siteId: string | null };
    assert(adminSession.siteId === siteB.id, "organization ADMIN Count was created for the wrong site");

    const adminRead = await app.inject({
      method: "GET",
      url: `/api/store-count/sessions/${adminSession.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert(adminRead.statusCode === 200, `organization ADMIN could not read the Count after creation: ${adminRead.statusCode} ${adminRead.body}`);

    const adminRoute = await app.inject({
      method: "GET",
      url: `/api/inventory-truth/counts/${adminSession.id}/route`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert(adminRoute.statusCode === 200, `organization ADMIN could not load the Count route without SiteMembership: ${adminRoute.statusCode} ${adminRoute.body}`);

    const adminScan = await app.inject({
      method: "POST",
      url: `/api/store-count/sessions/${adminSession.id}/scan`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { barcodeValue: product.barcodeValue, locationId: location.id, quantityDelta: 0, clientScanId: `admin-${suffix}` },
    });
    assert(adminScan.statusCode === 200, `organization ADMIN could not record the required Count observation: ${adminScan.statusCode} ${adminScan.body}`);

    const adminVerify = await app.inject({
      method: "POST",
      url: `/api/inventory-truth/counts/${adminSession.id}/locations/${location.id}/verify`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { offlineQueueFlushed: true },
    });
    assert(adminVerify.statusCode === 200, `organization ADMIN could not verify the Count location without SiteMembership: ${adminVerify.statusCode} ${adminVerify.body}`);

    const adminDiscrepancies = await app.inject({
      method: "GET",
      url: `/api/inventory-truth/counts/${adminSession.id}/discrepancies`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert(adminDiscrepancies.statusCode === 200, `organization ADMIN could not read Count discrepancies without SiteMembership: ${adminDiscrepancies.statusCode} ${adminDiscrepancies.body}`);

    const adminReview = await app.inject({
      method: "GET",
      url: `/api/inventory-truth/counts/${adminSession.id}/review`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert(adminReview.statusCode === 200, `organization ADMIN could not review the Count without SiteMembership: ${adminReview.statusCode} ${adminReview.body}`);

    const adminExport = await app.inject({
      method: "GET",
      url: `/api/store-count/sessions/${adminSession.id}/export.csv`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert(adminExport.statusCode === 200, `organization ADMIN could not export the Count without SiteMembership: ${adminExport.statusCode} ${adminExport.body}`);

    const adminCancel = await app.inject({
      method: "POST",
      url: `/api/store-count/sessions/${adminSession.id}/cancel`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert(adminCancel.statusCode === 200, `organization ADMIN could not cancel its own Count without SiteMembership: ${adminCancel.statusCode} ${adminCancel.body}`);

    console.log("Store Count site authorization validation passed: GENERAL access remains site-scoped and ADMIN create/read/route/write/verify/review/export access is organization-wide.");
  } finally {
    if (organizationId) {
      const siteIds = (await prisma.site.findMany({ where: { organizationId }, select: { id: true } })).map((site) => site.id);
      await prisma.storeCountAssignmentEvent.deleteMany({ where: { session: { siteId: { in: siteIds } } } });
      if (siteIds.length) await prisma.storeCountSession.deleteMany({ where: { siteId: { in: siteIds } } });
      await prisma.productLocationHint.deleteMany({ where: { organizationId } });
      await prisma.product.deleteMany({ where: { organizationId } });
      await prisma.storeLocation.deleteMany({ where: { siteId: { in: siteIds } } });
      await prisma.siteMembership.deleteMany({ where: { site: { organizationId } } });
      await prisma.organizationMembership.deleteMany({ where: { organizationId } });
      await prisma.site.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    if (adminId) await prisma.user.deleteMany({ where: { id: adminId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
