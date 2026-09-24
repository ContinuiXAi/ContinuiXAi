import type { Prisma } from "@prisma/client";

type LockMode = "share" | "update";
type UserRow = { id: string; role: string; isActive: boolean };
type OrganizationMembershipRow = { organizationId: string; role: string };

export type LockedOrganizationAccess = {
  actor: UserRow;
  organizationId: string;
  organizationRole: string;
};

export type LockedSiteAccess = LockedOrganizationAccess & {
  id: string;
};

async function lockActor(tx: Prisma.TransactionClient, userId: string, mode: LockMode) {
  const rows = mode === "update"
    ? await tx.$queryRaw<UserRow[]>`SELECT "id", "role", "isActive" FROM "User" WHERE "id" = ${userId} AND "isActive" = TRUE FOR UPDATE`
    : await tx.$queryRaw<UserRow[]>`SELECT "id", "role", "isActive" FROM "User" WHERE "id" = ${userId} AND "isActive" = TRUE FOR SHARE`;
  return rows[0] ?? null;
}

export async function lockActorOrganizationAccess(
  tx: Prisma.TransactionClient,
  userId: string,
  organizationId: string,
  mode: LockMode,
): Promise<LockedOrganizationAccess | null> {
  const organizations = mode === "update"
    ? await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} AND "isActive" = TRUE FOR UPDATE`
    : await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} AND "isActive" = TRUE FOR SHARE`;
  if (!organizations[0]) return null;
  const actor = await lockActor(tx, userId, mode);
  if (!actor) return null;
  const memberships = mode === "update"
    ? await tx.$queryRaw<OrganizationMembershipRow[]>`SELECT "organizationId", "role" FROM "OrganizationMembership" WHERE "organizationId" = ${organizationId} AND "userId" = ${userId} AND "isActive" = TRUE FOR UPDATE`
    : await tx.$queryRaw<OrganizationMembershipRow[]>`SELECT "organizationId", "role" FROM "OrganizationMembership" WHERE "organizationId" = ${organizationId} AND "userId" = ${userId} AND "isActive" = TRUE FOR SHARE`;
  if (!memberships[0]) return null;
  return { actor, organizationId, organizationRole: memberships[0].role };
}

export async function lockSiteAndMembership(
  tx: Prisma.TransactionClient,
  userId: string,
  siteId: string,
  mode: LockMode,
  candidateOrganizationId?: string,
): Promise<LockedSiteAccess | null> {
  const candidate = candidateOrganizationId
    ? { id: siteId, organizationId: candidateOrganizationId }
    : await tx.site.findFirst({ where: { id: siteId }, select: { id: true, organizationId: true } });
  if (!candidate) return null;
  const organizationAccess = await lockActorOrganizationAccess(tx, userId, candidate.organizationId, mode);
  if (!organizationAccess) return null;
  const sites = mode === "update"
    ? await tx.$queryRaw<Array<{ id: string; organizationId: string }>>`SELECT "id", "organizationId" FROM "Site" WHERE "id" = ${siteId} AND "isActive" = TRUE FOR UPDATE`
    : await tx.$queryRaw<Array<{ id: string; organizationId: string }>>`SELECT "id", "organizationId" FROM "Site" WHERE "id" = ${siteId} AND "isActive" = TRUE FOR SHARE`;
  const site = sites[0];
  if (!site || site.organizationId !== candidate.organizationId) return null;
  const memberships = mode === "update"
    ? await tx.$queryRaw<Array<{ siteId: string }>>`SELECT "siteId" FROM "SiteMembership" WHERE "siteId" = ${siteId} AND "userId" = ${userId} AND "isActive" = TRUE FOR UPDATE`
    : await tx.$queryRaw<Array<{ siteId: string }>>`SELECT "siteId" FROM "SiteMembership" WHERE "siteId" = ${siteId} AND "userId" = ${userId} AND "isActive" = TRUE FOR SHARE`;
  if (!memberships[0]) return null;
  return { ...organizationAccess, id: site.id };
}
