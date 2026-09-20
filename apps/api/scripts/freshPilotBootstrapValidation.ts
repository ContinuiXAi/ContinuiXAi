import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { prisma } from "../src/lib/prisma.js";
import { storeCountRoutes } from "../src/routes/storeCount.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `fresh-pilot-${suffix}@example.test`;

  // This must run against the pristine post-migration database, before any fixture tenant exists.
  const existingOrganizations = await prisma.organization.count({ where: { isActive: true } });
  const existingSites = await prisma.site.count({ where: { isActive: true } });
  assert(existingOrganizations === 0 && existingSites === 0, "fresh pilot bootstrap validation must run before tenant fixtures are created");

  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: "fresh-pilot-bootstrap-validation-secret" });
  app.decorate("authenticate", async (request, reply) => {
    try { await request.jwtVerify(); } catch { await reply.code(401).send({ error: "unauthorized" }); }
  });
  await app.register(storeCountRoutes, { prefix: "/api/store-count" });
  await app.ready();

  let userId: string | null = null;
  let organizationId: string | null = null;

  try {
    const user = await prisma.user.create({
      data: { name: "Fresh Pilot User", email, passwordHash: "not-used-in-validation", role: "GENERAL" },
    });
    userId = user.id;
    const token = app.jwt.sign({ sub: user.id, role: "GENERAL", tv: 0 });

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "First count on fresh deployment" },
    });

    assert(response.statusCode === 201, `fresh database first user could not start count: ${response.statusCode} ${response.body}`);

    const membership = await prisma.organizationMembership.findFirst({ where: { userId: user.id, isActive: true } });
    assert(Boolean(membership), "fresh database bootstrap did not create organization membership");
    organizationId = membership!.organizationId;

    const siteMembership = await prisma.siteMembership.findFirst({ where: { userId: user.id, isActive: true } });
    assert(Boolean(siteMembership), "fresh database bootstrap did not create site membership");

    const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
    assert(organization?.name === "Continuixai", "fresh database bootstrap did not create the Continuixai organization");

    console.log("Fresh pilot bootstrap validation passed: first registered user can safely create the initial organization/site and start Count.");
  } finally {
    if (userId) {
      // Only this disposable fixture's events; production RESTRICT stays intact.
      await prisma.storeCountAssignmentEvent.deleteMany({ where: { session: { startedById: userId } } });
      await prisma.storeCountSession.deleteMany({ where: { startedById: userId } });
      await prisma.siteMembership.deleteMany({ where: { userId } });
      await prisma.organizationMembership.deleteMany({ where: { userId } });
    }
    if (organizationId) {
      await prisma.storeLocation.deleteMany({ where: { site: { organizationId } } });
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
