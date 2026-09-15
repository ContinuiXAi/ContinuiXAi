import { readFile } from "node:fs/promises";
import { prisma } from "../src/lib/prisma.js";

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let userId: string | undefined;
let organizationId: string | undefined;

try {
  const user = await prisma.user.create({ data: { name: "Migration validation user", email: `migration-${suffix}@example.test`, passwordHash: "not-used" } });
  userId = user.id;
  const organization = await prisma.organization.create({ data: { name: "Migration Validation", slug: `migration-${suffix}` } });
  organizationId = organization.id;
  await prisma.organizationMembership.create({ data: { organizationId, userId, role: "VIEWER" } });
  await prisma.site.createMany({ data: [
    { organizationId, code: `A-${suffix}`, name: "Site A" },
    { organizationId, code: `B-${suffix}`, name: "Site B" },
  ] });

  const migration = await readFile(new URL("../prisma/migrations/20260908100000_site_membership_backfill_remediation/migration.sql", import.meta.url), "utf8");
  await prisma.$executeRawUnsafe(migration);
  const memberships = await prisma.siteMembership.count({ where: { userId, isActive: true } });
  if (memberships !== 2) throw new Error(`Expected 2 preserved site memberships, found ${memberships}.`);
  console.log("Populated multi-site membership backfill validation passed.");
} finally {
  if (organizationId) {
    await prisma.siteMembership.deleteMany({ where: { userId } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId } });
    await prisma.site.deleteMany({ where: { organizationId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
