import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Prisma, StoreCountDiscrepancy } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { calculateStoreCountDiscrepancies } from "./storeCount.js";
import { hasRequiredCountObservations, isCurrentCountAssignee, lockCountScope } from "../lib/storeCountWriteAccess.js";

const explanationSchema = z.object({
  reason: z.enum(["COULD_NOT_FIND", "WRONG_SHELF_OR_LOCATION", "RECEIVING_PROBLEM", "STOCKING_PROBLEM", "SALE_NOT_RECORDED", "DAMAGE_OR_EXPIRATION", "EMPTY_PACKAGE_POSSIBLE_THEFT", "PRODUCT_OR_PACKAGE_CHANGED", "OTHER_MANAGER_REVIEW"]),
  note: z.string().max(500).default(""),
}).strict();
const approvalSchema = z.object({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Scope = { id: string; siteId: string; organizationId: string; status: string; startedAt: Date; assignedToId: string | null; organizationRole: string };

// Every writer uses the same session-first lock order as Count capture/completion.
async function lockScope(tx: Prisma.TransactionClient, sessionId: string, userId: string) {
  return lockCountScope(tx, sessionId, userId);
}
async function lockDiscrepancy(tx: Prisma.TransactionClient, scope: Scope, id: string) {
  const rows = await tx.$queryRaw<StoreCountDiscrepancy[]>`
    SELECT discrepancy.* FROM "StoreCountDiscrepancy" AS discrepancy
    INNER JOIN "Product" AS product ON product."id" = discrepancy."productId"
    WHERE discrepancy."id" = ${id} AND discrepancy."sessionId" = ${scope.id}
      AND product."organizationId" = ${scope.organizationId}
    FOR UPDATE OF discrepancy
  `;
  return rows[0] ?? null;
}
function isManager(scope: Scope) { return ["OWNER", "ADMIN", "MANAGER"].includes(scope.organizationRole); }
async function countedEntries(tx: Prisma.TransactionClient, scope: Scope) {
  return tx.storeCountEntry.findMany({
    where: { sessionId: scope.id, location: { siteId: scope.siteId }, product: { organizationId: scope.organizationId } },
    select: { productId: true, quantity: true, location: { select: { id: true, code: true, name: true } } },
    orderBy: [{ location: { code: "asc" } }, { locationId: "asc" }, { id: "asc" }],
  });
}
function locationsFor(entries: Awaited<ReturnType<typeof countedEntries>>, productId: string) {
  const locations = new Map<string, { locationId: string; code: string; name: string | null; quantity: number }>();
  for (const entry of entries.filter((entry) => entry.productId === productId)) {
    const previous = locations.get(entry.location.id);
    locations.set(entry.location.id, { locationId: entry.location.id, code: entry.location.code, name: entry.location.name, quantity: (previous?.quantity ?? 0) + entry.quantity });
  }
  return [...locations.values()];
}
function reviewToken(row: StoreCountDiscrepancy, locations: ReturnType<typeof locationsFor>) {
  return createHash("sha256").update(JSON.stringify([
    row.id, row.sessionId, row.productId, String(row.expectedStoreQty), String(row.actualStoreQty), String(row.difference),
    row.reason, row.note, row.explainedById, row.explainedAt,
    [...locations].sort((a, b) => a.locationId.localeCompare(b.locationId)),
  ])).digest("hex");
}
async function allVerified(tx: Prisma.TransactionClient, scope: Scope) {
  // Include every persisted required visit, even if its location was subsequently deactivated.
  return await tx.storeCountLocationVisit.count({ where: { sessionId: scope.id, status: { not: "VERIFIED" } } }) === 0
    && await hasRequiredCountObservations(tx, scope.id);
}

export async function inventoryTruthReviewRoutes(app: FastifyInstance) {
  app.get("/counts/reviews", async (request, reply) => {
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "Sign in to find count reviews." });
    const site = {
      isActive: true,
      memberships: { some: { userId, isActive: true, user: { isActive: true } } },
      organization: { isActive: true, memberships: { some: { userId, isActive: true } } },
    };
    const select = { id: true, name: true, status: true, startedAt: true, site: { select: { name: true } }, startedBy: { select: { name: true } } } as const;
    const [pending, completed] = await Promise.all([
      prisma.storeCountSession.findMany({ where: { site, status: { in: ["ACTIVE", "COMPLETED"] }, discrepancies: { some: { status: "OPEN" } } }, select, orderBy: [{ startedAt: "asc" }, { id: "asc" }], take: 100 }),
      prisma.storeCountSession.findMany({ where: { site, status: "COMPLETED", discrepancies: { some: {}, none: { status: "OPEN" } } }, select, orderBy: [{ startedAt: "desc" }, { id: "asc" }], take: 20 }),
    ]);
    return { pending, completed };
  });

  app.get("/counts/:sessionId/review", async (request, reply) => {
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "sign in to review this count" });
    const { sessionId } = request.params as { sessionId: string };
    const result = await prisma.$transaction(async (tx) => {
      const scope = await lockScope(tx, sessionId, userId);
      if (!scope) return null;
      const finalized = await allVerified(tx, scope);
      if (scope.status === "ACTIVE" && finalized) await calculateStoreCountDiscrepancies(tx, { sessionId, siteId: scope.siteId, organizationId: scope.organizationId });
      const rows = await tx.storeCountDiscrepancy.findMany({
        where: { sessionId, product: { organizationId: scope.organizationId } },
        include: { product: { select: { name: true, barcodeValue: true, packageSize: true } }, explainedBy: { select: { name: true } }, reviewedBy: { select: { name: true } } },
        orderBy: [{ productId: "asc" }, { id: "asc" }],
      });
      const entries = await countedEntries(tx, scope);
      return {
        sessionId, sessionStatus: scope.status, finalized,
        canExplain: scope.status === "ACTIVE" && isCurrentCountAssignee(scope, userId),
        canApprove: ["ACTIVE", "COMPLETED"].includes(scope.status) && isManager(scope),
        discrepancies: rows.map((row) => {
          const countedLocations = locationsFor(entries, row.productId);
          return { ...row, expectedStoreQty: Number(row.expectedStoreQty), actualStoreQty: Number(row.actualStoreQty), difference: Number(row.difference), countedLocations, reviewToken: reviewToken(row, countedLocations) };
        }),
      };
    });
    if (!result) return reply.code(404).send({ error: "count session not found" });
    return result;
  });

  app.patch("/counts/:sessionId/discrepancies/:id/explain", async (request, reply) => {
    const parsed = explanationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Choose a listed reason and a note of 500 characters or fewer." });
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "sign in to explain this count" });
    const { sessionId, id } = request.params as { sessionId: string; id: string };
    const result = await prisma.$transaction(async (tx) => {
      const scope = await lockScope(tx, sessionId, userId);
      if (!scope) return { code: 404, error: "count session not found" };
      if (!isCurrentCountAssignee(scope, userId)) return { code: 403, error: "Only the currently assigned employee can explain this count." };
      if (scope.status !== "ACTIVE") return { code: 409, error: "This count is locked. Its explanation cannot be changed." };
      const row = await lockDiscrepancy(tx, scope, id);
      if (!row) return { code: 404, error: "count discrepancy not found" };
      if (row.status !== "OPEN" || !await allVerified(tx, scope)) return { code: 409, error: "Complete the location checks before explaining an open difference." };
      const discrepancy = await tx.storeCountDiscrepancy.update({ where: { id }, data: { ...parsed.data, explainedById: userId, explainedAt: new Date() } });
      return { code: 200, discrepancy };
    });
    return reply.code(result.code).send(result.code === 200 ? result.discrepancy : { error: result.error });
  });

  app.post("/counts/:sessionId/discrepancies/:id/approve", async (request, reply) => {
    const parsed = approvalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Reload the review before approving this baseline." });
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "sign in to approve this count" });
    const { sessionId, id } = request.params as { sessionId: string; id: string };
    const result = await prisma.$transaction(async (tx) => {
      const scope = await lockScope(tx, sessionId, userId);
      if (!scope) return { code: 404, error: "count session not found" };
      if (!isManager(scope)) return { code: 403, error: "A manager with access to this store must approve the baseline." };
      if (!["ACTIVE", "COMPLETED"].includes(scope.status)) return { code: 409, error: "This count cannot be approved." };
      const row = await lockDiscrepancy(tx, scope, id);
      if (!row) return { code: 404, error: "count discrepancy not found" };
      const ledgerId = `store-count-discrepancy:${row.id}`;
      if (row.status === "APPROVED") {
        const transaction = await tx.inventoryTransaction.findUnique({ where: { id: ledgerId } });
        if (!transaction) return { code: 409, error: "Approval evidence needs manager support. No new adjustment was made." };
        return { code: 200, discrepancy: row, transaction };
      }
      if (row.status !== "OPEN" || !row.reason || !await allVerified(tx, scope)) return { code: 409, error: "Check every location and save an employee explanation before approval." };
      // A Product row lock also conflicts with the FK key-share lock taken by
      // ledger inserts. Distinct count sessions cannot approve one frozen
      // expectation twice, and ledger inserts cannot interleave with this check.
      const products = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Product" WHERE "id" = ${row.productId} AND "organizationId" = ${scope.organizationId} FOR UPDATE
      `;
      if (!products.length) return { code: 404, error: "count product not found" };
      const laterEvent = await tx.inventoryTransaction.findFirst({ where: {
        organizationId: scope.organizationId, siteId: scope.siteId, productId: row.productId,
        OR: [{ createdAt: { gte: scope.startedAt } }, { occurredAt: { gte: scope.startedAt } }],
      }, select: { id: true } });
      if (laterEvent) return { code: 409, error: "Store inventory changed after this count started. Start a new count before approving this product." };
      // Also fence legacy/backdated recording timestamps: the reviewed frozen
      // expectation must still equal the ledger under the same product lock.
      const currentLedger = await tx.inventoryTransaction.aggregate({ where: {
        organizationId: scope.organizationId, siteId: scope.siteId, productId: row.productId,
      }, _sum: { quantity: true } });
      if (Number(currentLedger._sum.quantity ?? 0) !== Number(row.expectedStoreQty)) return { code: 409, error: "The store baseline changed. Start a new count before approving this product." };
      const locations = locationsFor(await countedEntries(tx, scope), row.productId);
      const actual = locations.reduce((total, location) => total + location.quantity, 0);
      if (actual !== Number(row.actualStoreQty) || actual - Number(row.expectedStoreQty) !== Number(row.difference) || parsed.data.reviewToken !== reviewToken(row, locations)) {
        return { code: 409, error: "This count changed. Return to Count to refresh its results, then review again." };
      }
      const transaction = await tx.inventoryTransaction.create({ data: {
        id: ledgerId, organizationId: scope.organizationId, siteId: scope.siteId, productId: row.productId, locationId: null,
        type: "COUNT_ADJUSTMENT", quantity: row.difference, referenceType: "STORE_COUNT_DISCREPANCY", referenceId: row.id,
        actorUserId: userId, reason: row.reason,
        createdAt: new Date(), occurredAt: new Date(),
        metadata: { sessionId, expectedStoreQty: String(row.expectedStoreQty), actualStoreQty: String(row.actualStoreQty), difference: String(row.difference), note: row.note, explainedById: row.explainedById, explainedAt: row.explainedAt?.toISOString() ?? null, countedLocations: locations, reviewToken: parsed.data.reviewToken },
      } });
      const discrepancy = await tx.storeCountDiscrepancy.update({ where: { id }, data: { status: "APPROVED", reviewedById: userId, reviewedAt: new Date() } });
      return { code: 200, discrepancy, transaction };
    });
    return reply.code(result.code).send(result.code === 200 ? { discrepancy: result.discrepancy, transaction: result.transaction } : { error: result.error });
  });
}
