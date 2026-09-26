import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isUniqueConstraintError } from "../lib/prismaErrors.js";
import { calculateStoreCountDiscrepancies } from "./storeCount.js";
import { inventoryTruthReviewRoutes } from "./inventoryTruthReview.js";
import { countWriteError, hasRequiredCountObservations, lockCountScope, requireCountWriter } from "../lib/storeCountWriteAccess.js";
import { lockSiteAndMembership } from "../lib/accessLocking.js";

const locationHintSchema = z.object({
  siteId: z.string().trim().min(1),
  locationId: z.string().trim().min(1),
  evidence: z.enum([
    "ASSIGNED",
    "PREVIOUSLY_COUNTED",
    "RECENTLY_STOCKED",
    "RECEIVED",
    "DISPLAY_COMPONENT",
  ]),
  isRequired: z.boolean().default(true),
  lastObservedAt: z.string().datetime().optional(),
}).strict();

const verifyLocationSchema = z.object({
  offlineQueueFlushed: z.literal(true),
}).strict();

const reassignSchema = z.object({
  toUserId: z.string().trim().min(1),
  reason: z.string().trim().max(500).optional(),
}).strict();

const stockStateQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

type StockStateCursor = { name: string; id: string };

function decodeStockStateCursor(cursor: string | undefined): StockStateCursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof decoded?.name !== "string" || !decoded.name || typeof decoded?.id !== "string" || !decoded.id) return null;
    return { name: decoded.name, id: decoded.id };
  } catch {
    return null;
  }
}

function encodeStockStateCursor(cursor: StockStateCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decimalString(quantity: unknown): string {
  if (quantity === null || quantity === undefined) return "0.0000";
  if (typeof quantity === "object" && quantity !== null && "toFixed" in quantity && typeof quantity.toFixed === "function") {
    return quantity.toFixed(4);
  }
  const value = String(quantity);
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("invalid inventory ledger quantity");
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(4, "0").slice(0, 4)}`;
}

type LockedCount = {
  id: string;
  siteId: string;
  organizationId: string;
  status: string;
  assignedToId: string | null;
};

type LockedVisit = LockedCount & {
  visitStatus: string;
  completedById: string | null;
  completedAt: Date | null;
};

function asNumber(quantity: unknown) {
  const number = Number(quantity);
  if (!Number.isFinite(number)) throw new Error("invalid inventory expectation quantity");
  return number;
}

function isActiveAssigneeSiteConflict(error: unknown) {
  if (!isUniqueConstraintError(error)) return false;
  const meta = (error as {
    meta?: {
      modelName?: unknown;
      target?: unknown;
      driverAdapterError?: {
        cause?: { constraint?: { fields?: unknown } };
      };
    };
  }).meta;
  const isExpectedFields = (fields: unknown) => {
    if (!Array.isArray(fields) || fields.length !== 2) return false;
    const normalized = fields.map((field) => {
      if (typeof field !== "string") return null;
      const identifier = field.trim();
      return identifier.startsWith('"') && identifier.endsWith('"')
        ? identifier.slice(1, -1).replaceAll('""', '"')
        : identifier;
    });
    return normalized[0] === "assignedToId" && normalized[1] === "siteId";
  };

  if (meta?.target === "StoreCountSession_one_active_per_assignee_site") return true;
  if (isExpectedFields(meta?.target)) {
    return meta?.modelName === undefined || meta.modelName === "StoreCountSession";
  }
  return meta?.modelName === "StoreCountSession"
    && isExpectedFields(meta.driverAdapterError?.cause?.constraint?.fields);
}

export async function inventoryTruthRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  await inventoryTruthReviewRoutes(app);

  app.get("/sites", async (request) => {
    const userId = request.user.sub;
    if (!userId) return [];
    return prisma.site.findMany({
      where: {
        isActive: true,
        memberships: { some: { userId, isActive: true, user: { isActive: true } } },
        organization: { isActive: true, memberships: { some: { userId, isActive: true, user: { isActive: true } } } },
      },
      select: { id: true, code: true, name: true },
      orderBy: [{ code: "asc" }, { id: "asc" }],
    });
  });

  app.get("/sites/:siteId/stock-state", async (request, reply) => {
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "invalid authenticated user" });
    const { siteId } = request.params as { siteId: string };
    const parsed = stockStateQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "cursor and limit must be valid" });
    const cursor = decodeStockStateCursor(parsed.data.cursor);
    if (parsed.data.cursor && !cursor) return reply.code(400).send({ error: "cursor is invalid" });

    // Tenant access is explicit: a global ADMIN role does not replace an active
    // user, organization membership, or site membership for the requested site.
    const site = await prisma.site.findFirst({
      where: {
        id: siteId,
        isActive: true,
        memberships: { some: { userId, isActive: true, user: { isActive: true } } },
        organization: { isActive: true, memberships: { some: { userId, isActive: true, user: { isActive: true } } } },
      },
      select: { id: true, organizationId: true },
    });
    if (!site) return reply.code(404).send({ error: "site not found" });

    const products = await prisma.product.findMany({
      where: {
        organizationId: site.organizationId,
        isActive: true,
        ...(cursor ? {
          OR: [
            { name: { gt: cursor.name } },
            { name: cursor.name, id: { gt: cursor.id } },
          ],
        } : {}),
      },
      select: { id: true, barcodeValue: true, name: true, manufacturer: true, packageSize: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: parsed.data.limit + 1,
    });
    const page = products.slice(0, parsed.data.limit);
    // One application-server creation-time cutoff for every row in this page.
    // This is not a commit-time watermark: only rows visible to this read are
    // included. Business occurredAt may be backdated and is deliberately unused.
    const ledgerCreatedThrough = new Date();
    const balances = page.length === 0 ? [] : await prisma.inventoryTransaction.groupBy({
      by: ["productId"],
      where: { organizationId: site.organizationId, siteId: site.id, productId: { in: page.map((product) => product.id) }, createdAt: { lte: ledgerCreatedThrough } },
      _sum: { quantity: true },
    });
    const balanceByProductId = new Map(balances.map((balance) => [balance.productId, decimalString(balance._sum.quantity)]));
    const asOf = ledgerCreatedThrough.toISOString();

    return {
      rows: page.map((product) => ({
        product,
        onHand: balanceByProductId.get(product.id) ?? "0.0000",
        asOf,
        committed: { status: "notTracked" as const },
        incoming: { status: "notTracked" as const },
      })),
      nextCursor: products.length > parsed.data.limit
        ? encodeStockStateCursor({ name: page.at(-1)!.name, id: page.at(-1)!.id })
        : null,
    };
  });

  app.post("/products/:productId/location-hints", async (request, reply) => {
    const parsed = locationHintSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "invalid authenticated user" });
    const { productId } = request.params as { productId: string };
    const { siteId, locationId, evidence, isRequired } = parsed.data;

    const lastObservedAt = parsed.data.lastObservedAt
      ? new Date(parsed.data.lastObservedAt)
      : new Date();
    const result = await prisma.$transaction(async (tx) => {
      const site = await lockSiteAndMembership(tx, userId, siteId, "update");
      if (!site) return { status: "forbidden" as const };
      if (!["OWNER", "ADMIN", "MANAGER"].includes(site.organizationRole)) {
        return { status: "manager-required" as const };
      }

      const product = await tx.product.findFirst({
        where: { id: productId, organizationId: site.organizationId, isActive: true },
        select: { id: true },
      });
      if (!product) return { status: "product-not-found" as const };

      const location = await tx.storeLocation.findFirst({
        where: { id: locationId, siteId: site.id, isActive: true },
        select: { id: true },
      });
      if (!location) return { status: "location-not-found" as const };

      const hint = await tx.productLocationHint.upsert({
        where: { siteId_productId_locationId: { siteId: site.id, productId: product.id, locationId: location.id } },
        update: { evidence, isRequired, lastObservedAt },
        create: {
          organizationId: site.organizationId,
          siteId: site.id,
          productId: product.id,
          locationId: location.id,
          evidence,
          isRequired,
          lastObservedAt,
        },
      });
      return { status: "created" as const, hint };
    });
    if (result.status === "forbidden") {
      return reply.code(403).send({ error: "you do not have access to that site" });
    }
    if (result.status === "manager-required") {
      return reply.code(403).send({ error: "manager access is required to assign count locations" });
    }
    if (result.status === "product-not-found") {
      return reply.code(404).send({ error: "product not found" });
    }
    if (result.status === "location-not-found") {
      return reply.code(404).send({ error: "location not found" });
    }
    return reply.code(201).send(result.hint);
  });

  app.get("/counts/:sessionId/route", async (request, reply) => {
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "invalid authenticated user" });
    const { sessionId } = request.params as { sessionId: string };

    const session = await prisma.storeCountSession.findFirst({
      where: {
        id: sessionId,
        site: {
          isActive: true,
          memberships: { some: { userId, isActive: true } },
          organization: {
            isActive: true,
            memberships: { some: { userId, isActive: true } },
          },
        },
      },
      select: {
        id: true,
        siteId: true,
        routeSnapshot: true,
        site: { select: { organizationId: true } },
      },
    });
    if (!session?.siteId || !session.site) return reply.code(404).send({ error: "count session not found" });

    const expectations = await prisma.storeCountExpectation.findMany({
      where: {
        sessionId: session.id,
        product: { organizationId: session.site.organizationId },
      },
      select: { productId: true, expectedStoreQty: true },
      orderBy: { productId: "asc" },
    });
    const locationVisits = await prisma.storeCountLocationVisit.findMany({
      where: {
        sessionId: session.id,
        location: { siteId: session.siteId },
      },
      select: {
        status: true,
        location: { select: { id: true, code: true, name: true, sortOrder: true } },
      },
      orderBy: [
        { location: { sortOrder: "asc" } },
        { location: { code: "asc" } },
        { location: { id: "asc" } },
      ],
    });

    const hints = session.routeSnapshot as Array<{
      productId: string; locationId: string; evidence: string;
      product: { id: string; barcodeValue: string | null; name: string; packageSize: string | null };
      location: { id: string; code: string; sortOrder: number };
    }>;

    const expectedByProduct = new Map(
      expectations.map((expectation) => [
        expectation.productId,
        asNumber(expectation.expectedStoreQty),
      ]),
    );
    const statusByLocation = new Map(
      locationVisits.map((visit) => [visit.location.id, visit.status]),
    );
    const hintsByProduct = new Map<string, typeof hints>();
    for (const hint of hints) {
      const productHints = hintsByProduct.get(hint.productId) ?? [];
      productHints.push(hint);
      hintsByProduct.set(hint.productId, productHints);
    }

    const locations = locationVisits.map((visit) => {
      const products = new Map<string, (typeof hints)[number]["product"]>();
      for (const hint of hints) {
        if (hint.locationId === visit.location.id) products.set(hint.productId, hint.product);
      }
      return {
        id: visit.location.id,
        code: visit.location.code,
        name: visit.location.name,
        status: visit.status,
        products: [...products.values()]
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
          .map((product) => ({
            productId: product.id,
            barcodeValue: product.barcodeValue,
            name: product.name,
            packageSize: product.packageSize,
            expectedStoreQty: expectedByProduct.get(product.id) ?? 0,
            suspectedLocations: (hintsByProduct.get(product.id) ?? []).map((hint) => ({
              locationId: hint.locationId,
              code: hint.location.code,
              verified: statusByLocation.get(hint.locationId) === "VERIFIED",
              evidence: hint.evidence,
            })),
          })),
      };
    });

    return {
      sessionId: session.id,
      expectedProducts: expectations.length,
      locations,
    };
  });

  app.post("/counts/:sessionId/locations/:locationId/verify", async (request, reply) => {
    const parsed = verifyLocationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "invalid authenticated user" });
    const { sessionId, locationId } = request.params as { sessionId: string; locationId: string };

    try {
    const result = await prisma.$transaction(async (tx) => {
      await requireCountWriter(tx, sessionId, userId);
      const rows = await tx.$queryRaw<LockedVisit[]>`
        SELECT
          session."id",
          session."siteId",
          site."organizationId",
          session."status",
          session."assignedToId",
          visit."status" AS "visitStatus",
          visit."completedById",
          visit."completedAt"
        FROM "StoreCountSession" AS session
        INNER JOIN "Site" AS site
          ON site."id" = session."siteId"
        INNER JOIN "Organization" AS organization
          ON organization."id" = site."organizationId"
        INNER JOIN "StoreCountLocationVisit" AS visit
          ON visit."sessionId" = session."id"
        INNER JOIN "StoreLocation" AS location
          ON location."id" = visit."locationId"
          AND session."siteId" = location."siteId"
        INNER JOIN "SiteMembership" AS site_membership
          ON site_membership."siteId" = site."id"
        INNER JOIN "OrganizationMembership" AS organization_membership
          ON organization_membership."organizationId" = organization."id"
        WHERE session."id" = ${sessionId}
          AND visit."locationId" = ${locationId}
          AND site_membership."userId" = ${userId}
          AND organization_membership."userId" = ${userId}
          AND site_membership."isActive" = TRUE
          AND organization_membership."isActive" = TRUE
          AND location."isActive" = TRUE
          AND site."isActive" = TRUE
          AND organization."isActive" = TRUE
        FOR UPDATE OF session, visit
      `;
      const locked = rows[0];
      if (!locked) return { status: "not-found" as const };
      if (locked.status !== "ACTIVE") return { status: "not-active" as const };

      if (!await hasRequiredCountObservations(tx, sessionId, locationId)) return { status: "missing-observation" as const };

      const completedAt = new Date();
      const alreadyVerified = locked.visitStatus === "VERIFIED";
      const visit = await tx.storeCountLocationVisit.upsert({
        where: { sessionId_locationId: { sessionId, locationId } },
        update: alreadyVerified
          ? {}
          : { status: "VERIFIED", completedById: userId, completedAt },
        create: {
          sessionId,
          locationId,
          status: "VERIFIED",
          completedById: userId,
          completedAt,
        },
      });
      const calculation = await calculateStoreCountDiscrepancies(tx, {
        sessionId,
        siteId: locked.siteId,
        organizationId: locked.organizationId,
      });
      return { status: "verified" as const, visit, calculation };
    });

    if (result.status === "not-found") return reply.code(404).send({ error: "count location visit not found" });
    if (result.status === "not-active") return reply.code(409).send({ error: "count session is not active" });
    if (result.status === "missing-observation") return reply.code(409).send({ error: "Count every assigned product at this location. Save None here for products you checked and did not find." });
    return {
      visit: result.visit,
      discrepanciesFinalized: result.calculation.finalized,
      discrepancies: result.calculation.discrepancies,
    };
    } catch (error) {
      const rejection = countWriteError(error);
      if (rejection) return reply.code(rejection.code).send({ error: rejection.error });
      throw error;
    }
  });

  app.get("/counts/:sessionId/discrepancies", async (request, reply) => {
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "invalid authenticated user" });
    const { sessionId } = request.params as { sessionId: string };

    const result = await prisma.$transaction(async (tx) => {
      const locked = await lockCountScope(tx, sessionId, userId);
      if (!locked) return null;
      if (locked.status === "COMPLETED") {
        const discrepancies = await tx.storeCountDiscrepancy.findMany({
          where: {
            sessionId,
            product: { organizationId: locked.organizationId },
          },
          orderBy: [{ productId: "asc" }, { id: "asc" }],
        });
        return { finalized: true as const, discrepancies };
      }
      if (locked.status === "CANCELLED") {
        const unverifiedVisits = await tx.storeCountLocationVisit.count({
          where: {
            sessionId,
            status: { not: "VERIFIED" },
            location: { siteId: locked.siteId },
          },
        });
        const discrepancies = await tx.storeCountDiscrepancy.findMany({
          where: {
            sessionId,
            product: { organizationId: locked.organizationId },
          },
          orderBy: [{ productId: "asc" }, { id: "asc" }],
        });
        return { finalized: unverifiedVisits === 0, discrepancies };
      }
      return calculateStoreCountDiscrepancies(tx, {
        sessionId,
        siteId: locked.siteId,
        organizationId: locked.organizationId,
      });
    });
    if (!result) return reply.code(404).send({ error: "count session not found" });
    return result;
  });

  app.post("/counts/:sessionId/reassign", async (request, reply) => {
    const parsed = reassignSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "invalid authenticated user" });
    const { sessionId } = request.params as { sessionId: string };

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
      const scope = await lockCountScope(tx, sessionId, userId);
      if (!scope || !["OWNER", "ADMIN", "MANAGER"].includes(scope.organizationRole)) return { status: "forbidden" as const };
      const rows = await tx.$queryRaw<LockedCount[]>`
        SELECT
          session."id",
          session."siteId",
          site."organizationId",
          session."status",
          session."assignedToId"
        FROM "StoreCountSession" AS session
        INNER JOIN "Site" AS site
          ON site."id" = session."siteId"
        INNER JOIN "Organization" AS organization
          ON organization."id" = site."organizationId"
        INNER JOIN "OrganizationMembership" AS organization_membership
          ON organization_membership."organizationId" = organization."id"
        INNER JOIN "SiteMembership" AS site_membership
          ON site_membership."siteId" = site."id"
        WHERE session."id" = ${sessionId}
          AND organization_membership."userId" = ${userId}
          AND site_membership."userId" = ${userId}
          AND organization_membership."isActive" = TRUE
          AND organization_membership."role" IN ('OWNER', 'ADMIN', 'MANAGER')
          AND site_membership."isActive" = TRUE
          AND organization."isActive" = TRUE
          AND site."isActive" = TRUE
        FOR UPDATE OF session
      `;
      const locked = rows[0];
      if (!locked) return { status: "forbidden" as const };
      if (locked.status !== "ACTIVE") return { status: "not-active" as const };

      const recipient = await tx.organizationMembership.findFirst({
        where: {
          organizationId: locked.organizationId,
          userId: parsed.data.toUserId,
          isActive: true,
          user: {
            isActive: true,
            siteMemberships: { some: { siteId: locked.siteId, isActive: true } },
          },
        },
        select: { userId: true },
      });
      if (!recipient) return { status: "recipient-not-found" as const };
      if (locked.assignedToId === recipient.userId) {
        const session = await tx.storeCountSession.update({
          where: { id: sessionId, siteId: locked.siteId },
          data: { assignedToId: recipient.userId },
        });
        return { status: "reassigned" as const, session };
      }

      const session = await tx.storeCountSession.update({
        where: { id: sessionId, siteId: locked.siteId },
        data: { assignedToId: recipient.userId },
      });
      await tx.storeCountAssignmentEvent.create({
        data: {
          sessionId,
          fromUserId: locked.assignedToId,
          toUserId: recipient.userId,
          assignedById: userId,
          ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
        },
      });
      return { status: "reassigned" as const, session };
      });
    } catch (error) {
      if (isActiveAssigneeSiteConflict(error)) {
        return reply.code(409).send({ error: "That employee already has an active count at this site. Finish or reassign their existing count before assigning another one." });
      }
      throw error;
    }

    if (result.status === "forbidden") return reply.code(403).send({ error: "manager access to this count site is required" });
    if (result.status === "not-active") return reply.code(409).send({ error: "count session is not active" });
    if (result.status === "recipient-not-found") return reply.code(404).send({ error: "active employee for this count site not found" });
    return result.session;
  });
}
