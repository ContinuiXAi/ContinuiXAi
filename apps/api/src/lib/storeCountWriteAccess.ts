import type { Prisma } from "@prisma/client";

export type CountScope = {
  id: string;
  siteId: string;
  organizationId: string;
  status: string;
  startedAt: Date;
  startedById: string | null;
  assignedToId: string | null;
  organizationRole: string;
};

export function isCurrentCountAssignee(scope: Pick<CountScope, "assignedToId" | "startedById">, userId: string) {
  return scope.assignedToId === userId || (scope.assignedToId === null && scope.startedById === userId);
}

export function assignedCountWhere(userId: string) {
  return { OR: [{ assignedToId: userId }, { assignedToId: null, startedById: userId }] };
}

// Take the session lock BEFORE reading authorization. A request admitted before
// reassignment/revocation may wait here; the next statement must see fresh state.
// SHARE locks keep authority stable until commit without serializing all counts.
export async function lockCountScope(tx: Prisma.TransactionClient, sessionId: string, userId: string) {
  await tx.$queryRaw`SELECT "status" FROM "StoreCountSession" WHERE "id" = ${sessionId} FOR UPDATE`;
  const rows = await tx.$queryRaw<CountScope[]>`
    SELECT session."id", session."siteId", site."organizationId", session."status", session."startedAt",
      session."startedById", session."assignedToId", organization_membership."role" AS "organizationRole"
    FROM "StoreCountSession" AS session
    INNER JOIN "Site" AS site ON site."id" = session."siteId"
    INNER JOIN "Organization" AS organization ON organization."id" = site."organizationId"
    INNER JOIN "SiteMembership" AS site_membership ON site_membership."siteId" = site."id"
    INNER JOIN "OrganizationMembership" AS organization_membership ON organization_membership."organizationId" = organization."id"
    INNER JOIN "User" AS actor ON actor."id" = organization_membership."userId"
    WHERE session."id" = ${sessionId}
      AND site_membership."userId" = ${userId} AND organization_membership."userId" = ${userId}
      AND site_membership."isActive" = TRUE AND organization_membership."isActive" = TRUE
      AND site."isActive" = TRUE AND organization."isActive" = TRUE AND actor."isActive" = TRUE
    FOR SHARE OF site_membership, organization_membership, site, organization, actor
  `;
  return rows[0] ?? null;
}

export async function requireCountWriter(tx: Prisma.TransactionClient, sessionId: string, userId: string) {
  const scope = await lockCountScope(tx, sessionId, userId);
  if (!scope) throw new Error("COUNT_ACCESS_REVOKED");
  if (!isCurrentCountAssignee(scope, userId)) throw new Error("COUNT_NOT_ASSIGNED");
  if (scope.status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
  return scope;
}

export function countWriteError(error: unknown) {
  if (!(error instanceof Error)) return null;
  switch (error.message) {
    case "COUNT_ACCESS_REVOKED": return { code: 404, error: "count session not found" };
    case "COUNT_NOT_ASSIGNED": return { code: 403, error: "Only the currently assigned employee can change this count. Ask a supervisor to reassign it first. Pending offline work must be reconciled with its original employee and scan identity." };
    case "SESSION_NOT_ACTIVE": return { code: 409, error: "count session is not active" };
    case "COUNT_LOCATION_INVALID": return { code: 403, error: "Active location for this count site not found." };
    case "COUNT_PRODUCT_INVALID": return { code: 409, error: "This product changed. Reload the product before counting." };
    case "COUNT_COMPOSITION_PARENT": return { code: 409, error: "This is a display or mixed package. Count its individual component products, not the parent package." };
    default: return null;
  }
}

export async function lockCountLocation(tx: Prisma.TransactionClient, scope: CountScope, locationId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "StoreLocation" WHERE "id" = ${locationId} AND "siteId" = ${scope.siteId} AND "isActive" = TRUE FOR SHARE
  `;
  if (!rows.length) throw new Error("COUNT_LOCATION_INVALID");
}

export async function lockCountProduct(tx: Prisma.TransactionClient, scope: CountScope, productId: string) {
  // Composition APIs require an Organization UPDATE lock, conflicting with the
  // scope's SHARE lock. Classification cannot change during the write. Old recipes mark
  // a parent: temporarily inactive versions must not reopen parent counting.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Product" WHERE "id" = ${productId} AND "organizationId" = ${scope.organizationId} AND "isActive" = TRUE FOR SHARE
  `;
  if (!rows.length) throw new Error("COUNT_PRODUCT_INVALID");
  const parent = await tx.productComposition.findFirst({
    where: { parentPackaging: { productId, product: { organizationId: scope.organizationId } } }, select: { id: true },
  });
  if (parent) throw new Error("COUNT_COMPOSITION_PARENT");
}

// No entry is different from a persisted zero. The frozen assignment list, not
// mutable location hints, defines which product/location observations are owed.
export async function hasRequiredCountObservations(tx: Prisma.TransactionClient, sessionId: string, locationId: string | null = null) {
  const missing = await tx.$queryRaw<Array<{ productId: string; locationId: string }>>`
    SELECT requirement->>'productId' AS "productId", requirement->>'locationId' AS "locationId"
    FROM "StoreCountSession" AS missing_observation
    CROSS JOIN LATERAL jsonb_array_elements(missing_observation."routeSnapshot") AS requirement
    WHERE missing_observation."id" = ${sessionId}
      AND (${locationId}::text IS NULL OR requirement->>'locationId' = ${locationId})
      AND EXISTS (SELECT 1 FROM "StoreCountLocationVisit" AS visit WHERE visit."sessionId" = missing_observation."id" AND visit."locationId" = requirement->>'locationId')
      AND NOT EXISTS (
        SELECT 1 FROM "StoreCountEntry" AS entry
        INNER JOIN "Product" AS product ON product."id" = entry."productId"
        INNER JOIN "StoreLocation" AS location ON location."id" = entry."locationId"
        INNER JOIN "Site" AS site ON site."id" = missing_observation."siteId"
        WHERE entry."sessionId" = missing_observation."id"
          AND entry."productId" = requirement->>'productId' AND entry."locationId" = requirement->>'locationId'
          AND product."organizationId" = site."organizationId" AND location."siteId" = site."id"
          AND entry."quantity" >= 0
      )
    LIMIT 1
  `;
  return missing.length === 0;
}
