import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isUniqueConstraintError } from "../lib/prismaErrors.js";
import { resolveProduct } from "../lib/barcodeLookup/index.js";
import { matchExistingCategory } from "../lib/barcodeLookup/categoryMatch.js";
import { ensurePilotSiteForUser } from "../lib/pilotSite.js";
import { assignedCountWhere, countWriteError, hasRequiredCountObservations, isCurrentCountAssignee, lockCountLocation, lockCountProduct, lockCountScope, requireCountWriter } from "../lib/storeCountWriteAccess.js";

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  siteId: z.string().trim().min(1).optional(),
});

const scanSchema = z.object({
  barcodeValue: z.string().trim().min(1).max(128),
  locationId: z.string().trim().min(1),
  quantityDelta: z.number().int().min(0).max(999).default(1),
  clientScanId: z.string().trim().min(1).max(160).optional(),
});

const setQuantitySchema = z.object({
  quantity: z.number().int().min(0).max(999999),
  expectedQuantity: z.number().int().min(0).max(999999),
});

type SessionRow = Awaited<ReturnType<typeof prisma.storeCountSession.findUnique>>;

export type SummaryEntryInput = {
  productId: string | null;
  barcodeValue: string;
  quantity: number;
  locationId: string;
  location: { code: string };
  product: { name: string; packageSize: string | null } | null;
};

export type SummaryRow = {
  key: string;
  productId: string | null;
  barcodeValue: string;
  productName: string | null;
  packageSize: string | null;
  total: number;
  byLocation: Record<string, { locationCode: string; quantity: number }>;
};

type InventoryExpectationGroup = {
  productId: string;
  _sum: { quantity: number | Prisma.Decimal | null };
};

type RequiredLocationHint = {
  locationId: string;
  location: { id: string; sortOrder: number; code: string };
};

type DiscrepancyExpectationInput = {
  productId: string;
  expectedStoreQty: number | Prisma.Decimal;
};

type DiscrepancyActualGroup = {
  productId: string | null;
  _sum: { quantity: number | null };
};

export type DiscrepancyRowData = {
  sessionId: string;
  productId: string;
  expectedStoreQty: number;
  actualStoreQty: number;
  difference: number;
};

export function buildExpectationSnapshotData(rows: InventoryExpectationGroup[], sessionId: string) {
  return rows.map((row) => ({
    sessionId,
    productId: row.productId,
    expectedStoreQty: row._sum.quantity ?? 0,
  }));
}

export function buildLocationVisitData(rows: RequiredLocationHint[], sessionId: string) {
  const locations = [...rows]
    .sort((a, b) =>
      a.location.sortOrder - b.location.sortOrder
      || a.location.code.localeCompare(b.location.code)
      || a.location.id.localeCompare(b.location.id),
    );
  const seen = new Set<string>();
  return locations.flatMap((row) => {
    if (seen.has(row.locationId)) return [];
    seen.add(row.locationId);
    return [{ sessionId, locationId: row.locationId }];
  });
}

export function buildDiscrepancyRows(
  expectations: DiscrepancyExpectationInput[],
  actuals: DiscrepancyActualGroup[],
  sessionId: string,
): DiscrepancyRowData[] {
  const expectedByProduct = new Map(
    expectations.map((expectation) => [expectation.productId, Number(expectation.expectedStoreQty)]),
  );
  const actualByProduct = new Map(
    actuals.flatMap((actual) => actual.productId
      ? [[actual.productId, actual._sum.quantity ?? 0] as const]
      : []),
  );
  const productIds = new Set([...expectedByProduct.keys(), ...actualByProduct.keys()]);

  return [...productIds]
    .sort((a, b) => a.localeCompare(b))
    .flatMap((productId) => {
      const expectedStoreQty = expectedByProduct.get(productId) ?? 0;
      const actualStoreQty = actualByProduct.get(productId) ?? 0;
      const difference = actualStoreQty - expectedStoreQty;
      return difference === 0
        ? []
        : [{ sessionId, productId, expectedStoreQty, actualStoreQty, difference }];
    });
}

export async function calculateStoreCountDiscrepancies(
  tx: Prisma.TransactionClient,
  scope: { sessionId: string; siteId: string; organizationId: string },
) {
  const unverifiedVisits = await tx.storeCountLocationVisit.count({
    where: {
      sessionId: scope.sessionId,
      status: { not: "VERIFIED" },
      location: { siteId: scope.siteId },
    },
  });
  if (unverifiedVisits > 0 || !await hasRequiredCountObservations(tx, scope.sessionId)) return { finalized: false as const, discrepancies: [] };

  const expectations = await tx.storeCountExpectation.findMany({
    where: {
      sessionId: scope.sessionId,
      product: { organizationId: scope.organizationId },
    },
    select: { productId: true, expectedStoreQty: true },
    orderBy: { productId: "asc" },
  });
  const actuals = await tx.storeCountEntry.groupBy({
    by: ["productId"],
    where: {
      sessionId: scope.sessionId,
      productId: { not: null },
      location: { siteId: scope.siteId },
      product: { organizationId: scope.organizationId },
    },
    _sum: { quantity: true },
    orderBy: { productId: "asc" },
  });
  const discrepancyRows = buildDiscrepancyRows(expectations, actuals, scope.sessionId);
  const existingDiscrepancies = await tx.storeCountDiscrepancy.findMany({
    where: {
      sessionId: scope.sessionId,
      product: { organizationId: scope.organizationId },
    },
    orderBy: [{ productId: "asc" }, { id: "asc" }],
  });
  const existingByProduct = new Map(existingDiscrepancies.map((row) => [row.productId, row]));
  const discrepancyByProduct = new Map(discrepancyRows.map((row) => [row.productId, row]));
  const productIds = [...new Set([
    ...expectations.map((row) => row.productId),
    ...actuals.flatMap((row) => row.productId ? [row.productId] : []),
  ])].sort((a, b) => a.localeCompare(b));

  for (const productId of productIds) {
    const row = discrepancyByProduct.get(productId);
    const existing = existingByProduct.get(productId);
    if (!row) {
      if (existing && (existing.status === "OPEN" || existing.status === "RESOLVED")) {
        const expectedStoreQty = Number(
          expectations.find((expectation) => expectation.productId === productId)?.expectedStoreQty ?? 0,
        );
        const actualStoreQty = actuals.find((actual) => actual.productId === productId)?._sum.quantity ?? 0;
        await tx.storeCountDiscrepancy.update({
          where: { id: existing.id },
          data: { expectedStoreQty, actualStoreQty, difference: 0, status: "RESOLVED" },
        });
      }
      continue;
    }
    if (existing) {
      if (existing.status === "APPROVED" || existing.status === "REJECTED") continue;
      await tx.storeCountDiscrepancy.update({
        where: { id: existing.id },
        data: {
          expectedStoreQty: row.expectedStoreQty,
          actualStoreQty: row.actualStoreQty,
          difference: row.difference,
          ...(existing.status === "RESOLVED" ? { status: "OPEN" as const } : {}),
        },
      });
      continue;
    }
    await tx.storeCountDiscrepancy.upsert({
      where: { sessionId_productId: { sessionId: scope.sessionId, productId } },
      update: {
        expectedStoreQty: row.expectedStoreQty,
        actualStoreQty: row.actualStoreQty,
        difference: row.difference,
      },
      create: row,
    });
  }

  const discrepancies = await tx.storeCountDiscrepancy.findMany({
    where: {
      sessionId: scope.sessionId,
      product: { organizationId: scope.organizationId },
    },
    orderBy: [{ productId: "asc" }, { id: "asc" }],
  });
  return { finalized: true as const, discrepancies };
}

async function rejectApprovedProductWrite(tx: Prisma.TransactionClient, sessionId: string, productId: string | null) {
  if (!productId) return;
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status" FROM "StoreCountDiscrepancy"
    WHERE "sessionId" = ${sessionId} AND "productId" = ${productId} AND "status" = 'APPROVED'
  `;
  if (rows.some((row) => row.status === "APPROVED")) throw new Error("PRODUCT_BASELINE_APPROVED");
}

export function buildSummaryRows(entries: SummaryEntryInput[]): SummaryRow[] {
  const byKey = new Map<string, SummaryRow>();
  for (const entry of entries) {
    const key = entry.productId ?? `barcode:${entry.barcodeValue}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        productId: entry.productId,
        barcodeValue: entry.barcodeValue,
        productName: entry.product?.name ?? null,
        packageSize: entry.product?.packageSize ?? null,
        total: 0,
        byLocation: {},
      };
      byKey.set(key, row);
    }
    row.total += entry.quantity;
    const existingLoc = row.byLocation[entry.locationId];
    row.byLocation[entry.locationId] = {
      locationCode: entry.location.code,
      quantity: (existingLoc?.quantity ?? 0) + entry.quantity,
    };
  }
  return [...byKey.values()].sort((a, b) =>
    (a.productName || a.barcodeValue).localeCompare(b.productName || b.barcodeValue),
  );
}

async function resolveAuthorizedSite(userId: string, requestedSiteId?: string, role?: string) {
  const sites = await prisma.site.findMany({
    where: {
      isActive: true,
      organization: {
        isActive: true,
        memberships: { some: { userId, isActive: true } },
      },
      memberships: { some: { userId, isActive: true } },
      ...(requestedSiteId ? { id: requestedSiteId } : {}),
    },
    orderBy: [{ code: "asc" }, { id: "asc" }],
    select: { id: true, organizationId: true },
  });

  if (requestedSiteId && sites[0]) return sites[0];
  if (!requestedSiteId && sites.length === 1) return sites[0];

  // Preserve the proven single-site pilot bootstrap: a user with an active
  // organization membership may be provisioned onto the one unambiguous site.
  // ensurePilotSiteForUser fails closed once multiple active/assigned sites exist.
  if (!requestedSiteId && role !== "ADMIN") {
    const pilotSite = await ensurePilotSiteForUser(userId, role);
    if (pilotSite && (!requestedSiteId || pilotSite.id === requestedSiteId)) {
      return { id: pilotSite.id, organizationId: pilotSite.organizationId };
    }
  }

  return null;
}

async function assertSessionAccess(
  sessionId: string,
  userId: string,
  role: string,
): Promise<{ ok: true; session: NonNullable<SessionRow> } | { ok: false; code: number; error: string }> {
  const session = await prisma.storeCountSession.findFirst({
    where: {
      id: sessionId,
      OR: [
        { siteId: null, ...(role === "ADMIN" ? {} : { startedById: userId }) },
        {
          site: {
            isActive: true,
            memberships: { some: { userId, isActive: true } },
            organization: {
              isActive: true,
              memberships: { some: { userId, isActive: true } },
            },
          },
        },
      ],
    },
  });
  if (!session) return { ok: false, code: 404, error: "count session not found" };
  return { ok: true, session };
}

async function findOrEnrichProduct(barcodeValue: string, organizationId: string) {
  const existing = await prisma.product.findFirst({ where: { organizationId, barcodeValue } });
  if (existing) return existing;

  const lookup = await resolveProduct(barcodeValue);
  if (!lookup.found || !lookup.name?.trim()) return null;

  const categories = await prisma.category.findMany({
    where: { isActive: true },
    select: { id: true, name: true, isActive: true },
  });
  const matchedCategory = matchExistingCategory(lookup.category, categories);

  try {
    return await prisma.product.create({
      data: {
        organizationId,
        barcodeValue,
        name: lookup.name.trim(),
        manufacturer: lookup.brand?.trim() || null,
        description: lookup.description?.trim() || null,
        packageSize: lookup.size?.trim() || null,
        imageUrl: lookup.imageUrl?.trim() || null,
        categoryId: matchedCategory?.id ?? null,
        isActive: true,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return prisma.product.findFirst({ where: { organizationId, barcodeValue } });
  }
}

async function findIdempotentEntry(clientScanId: string, sessionId: string) {
  const log = await prisma.storeCountScanLog.findUnique({
    where: { idempotencyKey: clientScanId },
    include: { entry: { include: { product: true, location: true, countedBy: { select: { id: true, name: true } } } } },
  });
  if (!log) return null;
  if (log.sessionId !== sessionId) return "conflict" as const;
  return log.entry;
}

export async function storeCountRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "invalid authenticated user" });

    let authorizedSite = await resolveAuthorizedSite(userId, parsed.data.siteId, request.user.role);
    if (!authorizedSite && !parsed.data.siteId) {
      authorizedSite = await ensurePilotSiteForUser(userId, request.user.role);
    }
    if (!authorizedSite) {
      if (parsed.data.siteId) return reply.code(403).send({ error: "you do not have access to that site" });
      return reply.code(400).send({ error: "select an authorized site before starting a count" });
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`store-count:${userId}:${authorizedSite.id}`}))`;
      const authorizedSites = await tx.$queryRaw<Array<{ id: string; organizationId: string }>>`
        SELECT site."id", site."organizationId"
        FROM "Site" AS site
        INNER JOIN "SiteMembership" AS site_membership
          ON site_membership."siteId" = site."id"
        INNER JOIN "Organization" AS organization
          ON organization."id" = site."organizationId"
        INNER JOIN "OrganizationMembership" AS organization_membership
          ON organization_membership."organizationId" = organization."id"
        INNER JOIN "User" AS actor ON actor."id" = organization_membership."userId"
        WHERE site."id" = ${authorizedSite.id}
          AND site_membership."userId" = ${userId}
          AND site_membership."isActive" = TRUE
          AND organization_membership."userId" = ${userId}
          AND organization_membership."isActive" = TRUE
          AND site."isActive" = TRUE
          AND organization."isActive" = TRUE
          AND actor."isActive" = TRUE
        FOR UPDATE OF site, site_membership, organization, organization_membership, actor
      `;
      const lockedSite = authorizedSites[0];
      if (!lockedSite) return { status: "forbidden" as const };

      const existing = await tx.storeCountSession.findFirst({
        where: { status: "ACTIVE", ...assignedCountWhere(userId), siteId: lockedSite.id },
        orderBy: { startedAt: "desc" },
      });
      if (existing) return { status: "ok" as const, created: false, session: existing };
      const session = await tx.storeCountSession.create({
        data: {
          name: parsed.data.name ?? null,
          startedById: userId,
          assignedToId: userId,
          siteId: lockedSite.id,
        },
      });
      await tx.storeCountAssignmentEvent.create({
        data: {
          sessionId: session.id,
          fromUserId: null,
          toUserId: userId,
          assignedById: userId,
        },
      });

      const expectationGroups = await tx.inventoryTransaction.groupBy({
        by: ["productId"],
        where: {
          organizationId: lockedSite.organizationId,
          siteId: lockedSite.id,
          product: { organizationId: lockedSite.organizationId },
        },
        _sum: { quantity: true },
        orderBy: { productId: "asc" },
      });
      const expectations = buildExpectationSnapshotData(expectationGroups, session.id);
      if (expectations.length > 0) {
        await tx.storeCountExpectation.createMany({ data: expectations });
      }

      const requiredHints = await tx.productLocationHint.findMany({
        where: {
          organizationId: lockedSite.organizationId,
          siteId: lockedSite.id,
          location: { siteId: lockedSite.id, isActive: true },
          product: { organizationId: lockedSite.organizationId, isActive: true },
        },
        select: {
          productId: true,
          locationId: true,
          evidence: true,
          isRequired: true,
          product: { select: { id: true, barcodeValue: true, name: true, packageSize: true } },
          location: { select: { id: true, sortOrder: true, code: true } },
        },
        orderBy: [
          { location: { sortOrder: "asc" } },
          { location: { code: "asc" } },
          { location: { id: "asc" } },
        ],
      });
      await tx.storeCountSession.update({ where: { id: session.id }, data: { routeSnapshot: requiredHints } });
      const visits = buildLocationVisitData(requiredHints.filter((hint) => hint.isRequired), session.id);
      if (visits.length > 0) {
        await tx.storeCountLocationVisit.createMany({ data: visits });
      }
      return { status: "ok" as const, created: true, session };
    });

    if (result.status === "forbidden") {
      return reply.code(403).send({ error: "you do not have access to that site" });
    }
    return reply.code(result.created ? 201 : 200).send(result.session);
  });

  app.get("/sessions/active", async (request) => {
    const userId = request.user.sub;
    const authorizedSite = await resolveAuthorizedSite(userId, undefined, request.user.role);
    if (authorizedSite) {
      return prisma.storeCountSession.findFirst({
        where: { status: "ACTIVE", siteId: authorizedSite.id, ...assignedCountWhere(userId) },
        orderBy: { startedAt: "desc" },
        include: {
          assignedTo: { select: { id: true, name: true } },
          expectations: {
            where: { product: { organizationId: authorizedSite.organizationId } },
            orderBy: { productId: "asc" },
          },
          locationVisits: {
            where: { location: { siteId: authorizedSite.id } },
            orderBy: [{ location: { sortOrder: "asc" } }, { locationId: "asc" }],
            include: { location: true, completedBy: { select: { id: true, name: true } } },
          },
          entries: {
            where: {
              location: { siteId: authorizedSite.id },
              OR: [
                { productId: null },
                { product: { organizationId: authorizedSite.organizationId } },
              ],
            },
            orderBy: { updatedAt: "desc" },
            include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
          },
          assignmentEvents: {
            orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
            include: {
              fromUser: { select: { id: true, name: true } },
              toUser: { select: { id: true, name: true } },
              assignedBy: { select: { id: true, name: true } },
            },
          },
        },
      });
    }

    return prisma.storeCountSession.findFirst({
      where: { status: "ACTIVE", startedById: userId, siteId: null },
      orderBy: { startedAt: "desc" },
      include: {
        assignedTo: { select: { id: true, name: true } },
        expectations: { orderBy: { productId: "asc" } },
        locationVisits: {
          orderBy: [{ location: { sortOrder: "asc" } }, { locationId: "asc" }],
          include: { location: true, completedBy: { select: { id: true, name: true } } },
        },
        entries: {
          orderBy: { updatedAt: "desc" },
          include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
        },
        assignmentEvents: {
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
          include: {
            fromUser: { select: { id: true, name: true } },
            toUser: { select: { id: true, name: true } },
            assignedBy: { select: { id: true, name: true } },
          },
        },
      },
    });
  });

  app.get("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });

    const session = await prisma.storeCountSession.findUnique({
      where: { id },
      include: {
        entries: {
          orderBy: [{ locationId: "asc" }, { updatedAt: "desc" }],
          include: {
            product: { include: { category: true } },
            location: true,
            countedBy: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!session) return reply.code(404).send({ error: "count session not found" });
    return session;
  });

  app.post("/sessions/:id/scan", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = scanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });

    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });

    if (!access.session.siteId) {
      return reply.code(409).send({ error: "count session is not assigned to a site" });
    }
    const countSite = await prisma.site.findUnique({
      where: { id: access.session.siteId },
      select: { organizationId: true },
    });
    if (!countSite) return reply.code(409).send({ error: "count site no longer exists" });

    const { barcodeValue, locationId, quantityDelta, clientScanId } = parsed.data;
    const location = await prisma.storeLocation.findUnique({ where: { id: locationId } });
    if (!location) return reply.code(400).send({ error: "unknown locationId" });
    if (!location.isActive) return reply.code(400).send({ error: "this location is inactive" });
    if (access.session.siteId && location.siteId !== access.session.siteId) {
      return reply.code(403).send({ error: "location does not belong to this count site" });
    }

    let product = await prisma.product.findFirst({
      where: { organizationId: countSite.organizationId, barcodeValue },
    });
    if (!product) {
      const identifier = await prisma.productIdentifier.findFirst({
        where: { organizationId: countSite.organizationId, value: barcodeValue, product: { organizationId: countSite.organizationId } }, include: { product: true },
      });
      product = identifier?.product ?? null;
    }
    if (!product) {
      try {
        product = await findOrEnrichProduct(barcodeValue, countSite.organizationId);
      } catch {
        product = null;
      }
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const scope = await requireCountWriter(tx, id, userId);
        await lockCountLocation(tx, scope, locationId);

        if (clientScanId) {
          const prior = await tx.storeCountScanLog.findUnique({ where: { idempotencyKey: clientScanId } });
          if (prior) {
            if (prior.sessionId !== id) throw new Error("IDEMPOTENCY_SESSION_CONFLICT");
            const priorEntry = await tx.storeCountEntry.findUniqueOrThrow({
              where: { id: prior.entryId },
              include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
            });
            return { entry: priorEntry, countedByDifferentUser: false, previousCounterName: null };
          }
        }

        if (scope.organizationId !== countSite.organizationId || scope.siteId !== access.session.siteId) throw new Error("COUNT_ACCESS_REVOKED");
        if (product) await lockCountProduct(tx, scope, product.id);
        const previousEntry = await tx.storeCountEntry.findUnique({
          where: {
            sessionId_locationId_barcodeValue: { sessionId: id, locationId, barcodeValue },
          },
          include: { countedBy: { select: { id: true, name: true } } },
        });
        if (previousEntry?.productId && previousEntry.productId !== product?.id) await lockCountProduct(tx, scope, previousEntry.productId);
        await rejectApprovedProductWrite(tx, id, previousEntry?.productId ?? null);
        await rejectApprovedProductWrite(tx, id, product?.id ?? null);
        const countedByDifferentUser = Boolean(previousEntry?.countedByUserId && previousEntry.countedByUserId !== userId);
        const previousCounterName = countedByDifferentUser ? previousEntry?.countedBy?.name ?? null : null;

        const now = new Date();
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "StoreCountEntry"
            ("id", "sessionId", "productId", "barcodeValue", "locationId", "quantity", "countedByUserId", "scannedAt", "updatedAt")
          VALUES
            (${randomUUID()}, ${id}, ${product?.id ?? null}, ${barcodeValue}, ${locationId}, ${quantityDelta}, ${userId}, ${now}, ${now})
          ON CONFLICT ("sessionId", "locationId", "barcodeValue")
          DO UPDATE SET
            "quantity" = "StoreCountEntry"."quantity" + EXCLUDED."quantity",
            "productId" = COALESCE(EXCLUDED."productId", "StoreCountEntry"."productId"),
            "countedByUserId" = EXCLUDED."countedByUserId",
            "scannedAt" = EXCLUDED."scannedAt",
            "updatedAt" = EXCLUDED."updatedAt"
          RETURNING "id"
        `;
        const countedId = rows[0]?.id;
        if (!countedId) throw new Error("STORE_COUNT_ENTRY_WRITE_FAILED");
        const counted = await tx.storeCountEntry.findUniqueOrThrow({
          where: { id: countedId },
          include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
        });

        if (clientScanId) {
          await tx.storeCountScanLog.create({
            data: {
              idempotencyKey: clientScanId,
              entryId: counted.id,
              sessionId: id,
              userId,
              quantityDelta,
            },
          });
        }
        return { entry: counted, countedByDifferentUser, previousCounterName };
      });
      return reply.send({ ...result.entry, countedByDifferentUser: result.countedByDifferentUser, previousCounterName: result.previousCounterName });
    } catch (error) {
      const rejection = countWriteError(error);
      if (rejection) return reply.code(rejection.code).send({ error: rejection.error });
      if (error instanceof Error && error.message === "SESSION_NOT_ACTIVE") {
        return reply.code(409).send({ error: "count session is not active" });
      }
      if (error instanceof Error && error.message === "PRODUCT_BASELINE_APPROVED") {
        return reply.code(409).send({ error: "This product's baseline is approved. Start a new count to record a change." });
      }
      if (error instanceof Error && error.message === "IDEMPOTENCY_SESSION_CONFLICT") {
        return reply.code(409).send({ error: "clientScanId was already used for another count session" });
      }
      if (clientScanId && isUniqueConstraintError(error)) {
        const prior = await findIdempotentEntry(clientScanId, id);
        if (prior === "conflict") return reply.code(409).send({ error: "clientScanId was already used for another count session" });
        if (prior) return reply.send(prior);
      }
      throw error;
    }
  });

  app.patch("/sessions/:sessionId/entries/:entryId", async (request, reply) => {
    const { sessionId, entryId } = request.params as { sessionId: string; entryId: string };
    const parsed = setQuantitySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });

    const access = await assertSessionAccess(sessionId, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });

    try {
      return await prisma.$transaction(async (tx) => {
        const scope = await requireCountWriter(tx, sessionId, userId);

        const entry = await tx.storeCountEntry.findFirst({ where: { id: entryId, sessionId, location: { siteId: scope.siteId }, OR: [{ productId: null }, { product: { organizationId: scope.organizationId } }] } });
        if (!entry) throw new Error("ENTRY_NOT_FOUND");
        await lockCountLocation(tx, scope, entry.locationId);
        if (entry.productId) await lockCountProduct(tx, scope, entry.productId);
        await rejectApprovedProductWrite(tx, sessionId, entry.productId);
        if (entry.quantity !== parsed.data.expectedQuantity) throw new Error("ENTRY_QUANTITY_CHANGED");

        return tx.storeCountEntry.update({
          where: { id: entryId },
          data: { quantity: parsed.data.quantity, countedByUserId: userId, scannedAt: new Date() },
          include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
        });
      });
    } catch (error) {
      const rejection = countWriteError(error);
      if (rejection) return reply.code(rejection.code).send({ error: rejection.error });
      if (error instanceof Error && error.message === "SESSION_NOT_ACTIVE") {
        return reply.code(409).send({ error: "count session is not active" });
      }
      if (error instanceof Error && error.message === "ENTRY_NOT_FOUND") {
        return reply.code(404).send({ error: "count entry not found" });
      }
      if (error instanceof Error && error.message === "ENTRY_QUANTITY_CHANGED") {
        return reply.code(409).send({ error: "This count changed on another device. Reload the latest total before correcting it." });
      }
      if (error instanceof Error && error.message === "PRODUCT_BASELINE_APPROVED") {
        return reply.code(409).send({ error: "This product's baseline is approved. Start a new count to record a change." });
      }
      throw error;
    }
  });

  app.get("/sessions/:id/summary", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });

    const session = await prisma.storeCountSession.findUnique({
      where: { id },
      include: { entries: { include: { product: true, location: true } } },
    });
    if (!session) return reply.code(404).send({ error: "count session not found" });

    const rows = buildSummaryRows(session.entries);
    const totalUnits = rows.reduce((sum, row) => sum + row.total, 0);
    const locations = [...new Set(session.entries.map((entry) => entry.location.code))].sort();

    return {
      session: {
        id: session.id,
        name: session.name,
        status: session.status,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
      },
      distinctProducts: rows.length,
      totalUnits,
      locations,
      rows,
    };
  });

  app.post("/sessions/:id/complete", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });
    if (!access.session.siteId) {
      const legacyResult = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{
          status: string;
          startedById: string | null;
          assignedToId: string | null;
        }>>`
          SELECT session."status", session."startedById", session."assignedToId"
          FROM "StoreCountSession" AS session
          WHERE session."id" = ${id}
            AND session."siteId" IS NULL
          FOR UPDATE OF session
        `;
        const locked = rows[0];
        if (!locked || locked.status !== "ACTIVE") return { status: "not-active" as const };
        const legacyScope = { ...locked, organizationRole: "" };
        if (!isCurrentCountAssignee(legacyScope, userId)) return { status: "forbidden" as const };
        const actors = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "User" WHERE "id" = ${userId} AND "isActive" = TRUE FOR SHARE
        `;
        if (!actors.length) return { status: "forbidden" as const };
        const entryCount = await tx.storeCountEntry.count({ where: { sessionId: id } });
        if (entryCount === 0) return { status: "empty" as const };
        const session = await tx.storeCountSession.update({
          where: { id, siteId: null },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
        return { status: "completed" as const, session };
      });
      if (legacyResult.status === "not-active") return reply.code(409).send({ error: "count session is not active" });
      if (legacyResult.status === "forbidden") {
        return reply.code(403).send({ error: "only the current assignee can complete this session; ask a supervisor to reassign it first" });
      }
      if (legacyResult.status === "empty") return reply.code(409).send({ error: "cannot complete an empty count" });
      return legacyResult.session;
    }

    const result = await prisma.$transaction(async (tx) => {
      const locked = await lockCountScope(tx, id, userId);
      if (!locked) return { status: "not-found" as const };
      if (locked.status !== "ACTIVE") return { status: "not-active" as const };
      if (!isCurrentCountAssignee(locked, userId)) return { status: "forbidden" as const };

      const calculation = await calculateStoreCountDiscrepancies(tx, {
        sessionId: id,
        siteId: locked.siteId,
        organizationId: locked.organizationId,
      });
      if (!calculation.finalized) return { status: "unverified-locations" as const };

      const entryCount = await tx.storeCountEntry.count({
        where: { sessionId: id, location: { siteId: locked.siteId } },
      });
      if (entryCount === 0) return { status: "empty" as const };

      const unexplained = await tx.storeCountDiscrepancy.count({
        where: {
          sessionId: id,
          status: "OPEN",
          reason: null,
          product: { organizationId: locked.organizationId },
        },
      });
      if (unexplained > 0) return { status: "unexplained" as const };

      const session = await tx.storeCountSession.update({
        where: { id, siteId: locked.siteId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      return { status: "completed" as const, session };
    });

    if (result.status === "not-found") return reply.code(404).send({ error: "count session not found" });
    if (result.status === "not-active") return reply.code(409).send({ error: "count session is not active" });
    if (result.status === "forbidden") {
      return reply.code(403).send({ error: "only the current assignee can complete this session; ask a supervisor to reassign it first" });
    }
    if (result.status === "unverified-locations") {
      return reply.code(409).send({ error: "verify every required location before completing this count" });
    }
    if (result.status === "empty") return reply.code(409).send({ error: "cannot complete an empty count" });
    if (result.status === "unexplained") {
      return reply.code(409).send({ error: "add an employee explanation for every discrepancy before completing this count" });
    }
    return result.session;
  });

  app.post("/sessions/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });
    if (!access.session.siteId) {
      const legacyResult = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{
          status: string;
          startedById: string | null;
          assignedToId: string | null;
        }>>`
          SELECT session."status", session."startedById", session."assignedToId"
          FROM "StoreCountSession" AS session
          WHERE session."id" = ${id}
            AND session."siteId" IS NULL
          FOR UPDATE OF session
        `;
        const locked = rows[0];
        if (!locked || locked.status !== "ACTIVE") return { status: "not-active" as const };
        const legacyScope = { ...locked, organizationRole: "" };
        if (!isCurrentCountAssignee(legacyScope, userId)) return { status: "forbidden" as const };
        const actors = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "User" WHERE "id" = ${userId} AND "isActive" = TRUE FOR SHARE
        `;
        if (!actors.length) return { status: "forbidden" as const };
        const approvals = await tx.storeCountDiscrepancy.count({ where: { sessionId: id, status: "APPROVED" } });
        if (approvals > 0) return { status: "approved" as const };
        const session = await tx.storeCountSession.update({
          where: { id, siteId: null, status: "ACTIVE" },
          data: { status: "CANCELLED", completedAt: new Date() },
        });
        return { status: "cancelled" as const, session };
      });
      if (legacyResult.status === "not-active") return reply.code(409).send({ error: "count session is not active" });
      if (legacyResult.status === "forbidden") {
        return reply.code(403).send({ error: "only the current assignee can cancel this session; ask a supervisor to reassign it first" });
      }
      if (legacyResult.status === "approved") {
        return reply.code(409).send({ error: "This count has approved adjustments and cannot be cancelled. Complete its remaining work." });
      }
      return legacyResult.session;
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const scope = await requireCountWriter(tx, id, userId);
        const approvals = await tx.storeCountDiscrepancy.count({ where: { sessionId: id, status: "APPROVED" } });
        if (approvals > 0) return reply.code(409).send({ error: "This count has approved adjustments and cannot be cancelled. Complete its remaining work." });
        return tx.storeCountSession.update({ where: { id, siteId: scope.siteId, status: "ACTIVE" }, data: { status: "CANCELLED", completedAt: new Date() } });
      });
    } catch (error) {
      const rejection = countWriteError(error);
      if (rejection) return reply.code(rejection.code).send({ error: rejection.error });
      throw error;
    }
  });
}
