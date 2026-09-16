import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

const assignmentSchema = z.object({
  siteIds: z.array(z.string().trim().min(1)).min(1),
});

async function targetOrganizationIds(adminId: string, userId: string): Promise<string[] | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return null;
  const memberships = await prisma.organizationMembership.findMany({
    where: { userId, isActive: true, organization: { isActive: true, memberships: { some: { userId: adminId, isActive: true } } } },
    select: { organizationId: true },
  });
  return memberships.length > 0 ? memberships.map((membership) => membership.organizationId) : null;
}

export async function siteMembershipRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.requireAdmin);

  app.get("/users/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const organizationIds = await targetOrganizationIds(request.user.sub, userId);
    if (!organizationIds) return reply.code(404).send({ error: "user not found" });
    const sites = await prisma.site.findMany({
      where: { isActive: true, organizationId: { in: organizationIds } },
      orderBy: [{ code: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        code: true,
        memberships: { where: { userId }, select: { isActive: true }, take: 1 },
      },
    });
    return sites.map((site) => ({
      id: site.id,
      name: site.name,
      code: site.code,
      assigned: site.memberships[0]?.isActive === true,
    }));
  });

  app.put("/users/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const parsed = assignmentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Select at least one site." });
    const organizationIds = await targetOrganizationIds(request.user.sub, userId);
    if (!organizationIds) return reply.code(404).send({ error: "user not found" });

    const siteIds = [...new Set(parsed.data.siteIds)];
    const scopedSites = await prisma.site.findMany({
      where: { id: { in: siteIds }, isActive: true, organizationId: { in: organizationIds } },
      select: { id: true },
    });
    if (scopedSites.length !== siteIds.length) {
      return reply.code(403).send({ error: "One or more sites are outside this user's organization." });
    }

    const allScopedSites = await prisma.site.findMany({
      where: { isActive: true, organizationId: { in: organizationIds } },
      select: { id: true },
    });
    const allScopedSiteIds = allScopedSites.map((site) => site.id);
    await prisma.$transaction(async (tx) => {
      await tx.siteMembership.updateMany({
        where: { userId, siteId: { in: allScopedSiteIds } },
        data: { isActive: false },
      });
      for (const siteId of siteIds) {
        await tx.siteMembership.upsert({
          where: { siteId_userId: { siteId, userId } },
          update: { isActive: true },
          create: { siteId, userId },
        });
      }
    });
    return { ok: true, siteIds };
  });
}
