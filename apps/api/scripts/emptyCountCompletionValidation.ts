import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { prisma } from "../src/lib/prisma.js";
import { storeCountRoutes } from "../src/routes/storeCount.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: "empty-count-completion-validation-secret" });
  app.decorate("authenticate", async (request, reply) => {
    try { await request.jwtVerify(); } catch { await reply.code(401).send({ error: "unauthorized" }); }
  });
  await app.register(storeCountRoutes, { prefix: "/api/store-count" });
  await app.ready();

  let userId: string | null = null;
  let organizationId: string | null = null;
  let siteId: string | null = null;
  try {
    const user = await prisma.user.create({ data: { name: "Empty Count Validation", email: `empty-count-${suffix}@example.test`, passwordHash: "not-used", role: "GENERAL" } });
    userId = user.id;
    const organization = await prisma.organization.create({ data: { name: `Empty Count Org ${suffix}`, slug: `empty-count-${suffix}` } });
    organizationId = organization.id;
    await prisma.organizationMembership.create({ data: { organizationId: organization.id, userId: user.id, role: "INVENTORY", isActive: true } });
    const site = await prisma.site.create({ data: { organizationId: organization.id, code: `EMPTY-${suffix}`, name: "Empty count validation site", type: "STORE", isActive: true } });
    siteId = site.id;
    await prisma.siteMembership.create({ data: { siteId: site.id, userId: user.id, isActive: true } });

    const token = app.jwt.sign({ sub: user.id, role: "GENERAL", tv: 0 });
    const headers = { authorization: `Bearer ${token}` };
    const start = await app.inject({ method: "POST", url: "/api/store-count/sessions", headers, payload: { name: "Empty count must stay active", siteId: site.id } });
    assert(start.statusCode === 201, `could not create empty count session: ${start.statusCode} ${start.body}`);
    const session = JSON.parse(start.body) as { id: string };

    const complete = await app.inject({ method: "POST", url: `/api/store-count/sessions/${session.id}/complete`, headers });
    assert(complete.statusCode === 409, `empty count completed with ${complete.statusCode}; expected 409 so an accidental Finish cannot dead-end the pilot`);
    const body = JSON.parse(complete.body) as { error?: string };
    assert(body.error === "cannot complete an empty count", `unexpected empty-count error: ${complete.body}`);

    const stillActive = await prisma.storeCountSession.findUniqueOrThrow({ where: { id: session.id } });
    assert(stillActive.status === "ACTIVE", `empty count status changed to ${stillActive.status}`);

    console.log("Empty Count completion validation passed: an empty active Count cannot be completed accidentally.");
  } finally {
    if (userId) {
      await prisma.storeCountScanLog.deleteMany({ where: { userId } });
      await prisma.storeCountEntry.deleteMany({ where: { countedByUserId: userId } });
      await prisma.storeCountAssignmentEvent.deleteMany({ where: { session: { startedById: userId } } });
      await prisma.storeCountSession.deleteMany({ where: { startedById: userId } });
      await prisma.siteMembership.deleteMany({ where: { userId } });
      await prisma.organizationMembership.deleteMany({ where: { userId } });
    }
    if (siteId) await prisma.storeLocation.deleteMany({ where: { siteId } });
    if (organizationId) {
      await prisma.site.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
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
