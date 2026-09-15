import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isUniqueConstraintError } from "../lib/prismaErrors.js";
import { resolveProduct } from "../lib/barcodeLookup/index.js";
import { matchExistingCategory } from "../lib/barcodeLookup/categoryMatch.js";
import { ensurePilotSiteForUser } from "../lib/pilotSite.js";

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  siteId: z.string().trim().min(1).optional(),
});

const scanSchema = z.object({
  barcodeValue: z.string().trim().min(1).max(128),
  locationId: z.string().trim().min(1),
  quantityDelta: z.number().int().min(1).max(999).default(1),
  clientScanId: z.string().trim().min(1).max(160).optional(),
});

const setQuantitySchema = z.object({
  quantity: z.number().int().min(0).max(999999),
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
  const session = await prisma.storeCountSession.findUnique({ where: { id: sessionId } });
  if (!session) return { ok: false, code: 404, error: "count session not found" };

  if (session.siteId) {
    const site = await resolveAuthorizedSite(userId, session.siteId, role);
    if (!site && role !== "ADMIN") {
      return { ok: false, code: 403, error: "you do not have access to this count site" };
    }
  } else if (session.startedById !== userId && role !== "ADMIN") {
    return { ok: false, code: 403, error: "you do not have access to this count session" };
  }
  return { ok: true, session };
}

function canManageSession(session: NonNullable<SessionRow>, userId: string, role: string) {
  return session.startedById === userId || role === "ADMIN";
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
        WHERE site."id" = ${authorizedSite.id}
          AND site_membership."userId" = ${userId}
          AND site_membership."isActive" = TRUE
          AND organization_membership."userId" = ${userId}
          AND organization_membership."isActive" = TRUE
          AND site."isActive" = TRUE
          AND organization."isActive" = TRUE
        FOR UPDATE OF site, site_membership, organization, organization_membership
      `;
      const lockedSite = authorizedSites[0];
      if (!lockedSite) return { status: "forbidden" as const };

      const existing = await tx.storeCountSession.findFirst({
        where: { status: "ACTIVE", startedById: userId, siteId: lockedSite.id },
        orderBy: { startedAt: "desc" },
      });
      if (existing) return { status: "ok" as const, created: false, session: existing };
      const session = await tx.storeCountSession.create({
        data: { name: parsed.data.name ?? null, startedById: userId, siteId: lockedSite.id },
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
          isRequired: true,
          location: { siteId: lockedSite.id, isActive: true },
          product: { organizationId: lockedSite.organizationId, isActive: true },
        },
        select: {
          locationId: true,
          location: { select: { id: true, sortOrder: true, code: true } },
        },
        orderBy: [
          { location: { sortOrder: "asc" } },
          { location: { code: "asc" } },
          { location: { id: "asc" } },
        ],
      });
      const visits = buildLocationVisitData(requiredHints, session.id);
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
        where: { status: "ACTIVE", siteId: authorizedSite.id },
        orderBy: { startedAt: "desc" },
        include: {
          entries: {
            orderBy: { updatedAt: "desc" },
            include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
          },
        },
      });
    }

    return prisma.storeCountSession.findFirst({
      where: { status: "ACTIVE", startedById: userId },
      orderBy: { startedAt: "desc" },
      include: {
        entries: {
          orderBy: { updatedAt: "desc" },
          include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
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

    if (clientScanId) {
      const prior = await findIdempotentEntry(clientScanId, id);
      if (prior === "conflict") return reply.code(409).send({ error: "clientScanId was already used for another count session" });
      if (prior) return reply.send(prior);
    }

    let product = await prisma.product.findFirst({
      where: { organizationId: countSite.organizationId, barcodeValue },
    });
    if (!product) {
      try {
        product = await findOrEnrichProduct(barcodeValue, countSite.organizationId);
      } catch {
        product = null;
      }
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const lockedSession = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status" FROM "StoreCountSession" WHERE "id" = ${id} FOR UPDATE
        `;
        if (lockedSession[0]?.status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");

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

        const previousEntry = await tx.storeCountEntry.findUnique({
          where: {
            sessionId_locationId_barcodeValue: { sessionId: id, locationId, barcodeValue },
          },
          include: { countedBy: { select: { id: true, name: true } } },
        });
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
      if (error instanceof Error && error.message === "SESSION_NOT_ACTIVE") {
        return reply.code(409).send({ error: "count session is not active" });
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
        const lockedSession = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status" FROM "StoreCountSession" WHERE "id" = ${sessionId} FOR UPDATE
        `;
        if (lockedSession[0]?.status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");

        const entry = await tx.storeCountEntry.findFirst({ where: { id: entryId, sessionId } });
        if (!entry) throw new Error("ENTRY_NOT_FOUND");

        return tx.storeCountEntry.update({
          where: { id: entryId },
          data: { quantity: parsed.data.quantity, countedByUserId: userId, scannedAt: new Date() },
          include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message === "SESSION_NOT_ACTIVE") {
        return reply.code(409).send({ error: "count session is not active" });
      }
      if (error instanceof Error && error.message === "ENTRY_NOT_FOUND") {
        return reply.code(404).send({ error: "count entry not found" });
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
    if (!canManageSession(access.session, userId, role)) {
      return reply.code(403).send({ error: "only the count owner or an administrator can complete this session" });
    }
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });

    const entryCount = await prisma.storeCountEntry.count({ where: { sessionId: id } });
    if (entryCount === 0) return reply.code(409).send({ error: "cannot complete an empty count" });

    return prisma.storeCountSession.update({
      where: { id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  });

  app.post("/sessions/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (!canManageSession(access.session, userId, role)) {
      return reply.code(403).send({ error: "only the count owner or an administrator can cancel this session" });
    }
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });

    return prisma.storeCountSession.update({
      where: { id },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
  });
}
