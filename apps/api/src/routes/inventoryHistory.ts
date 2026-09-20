import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

// Ledger timestamps are timestamp(3). Reject sub-millisecond cutoffs instead of
// silently truncating them in JavaScript and changing half-open boundaries.
const timestamp = z.string().max(40).datetime({ offset: true })
  .regex(/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => Number.isFinite(new Date(value).getTime()), "Invalid timestamp or UTC offset");
const querySchema = z.object({
  asOfExclusive: timestamp,
  recordedBefore: timestamp.optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export async function inventoryHistoryRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.get("/sites/:siteId/as-of", async (request, reply) => {
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "Sign in to view inventory history." });
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Use ISO timestamps with timezone and at most millisecond precision, a nonempty cursor, and a limit from 1 to 100." });
    const { siteId } = request.params as { siteId: string };
    const site = await prisma.site.findFirst({
      where: {
        id: siteId, isActive: true,
        memberships: { some: { userId, isActive: true, user: { isActive: true } } },
        organization: { isActive: true, memberships: { some: { userId, isActive: true, user: { isActive: true } } } },
      }, select: { id: true, organizationId: true },
    });
    if (!site) return reply.code(404).send({ error: "Store not found." });
    const { limit, cursor } = parsed.data;
    const asOfExclusive = new Date(parsed.data.asOfExclusive);
    const recordedBefore = parsed.data.recordedBefore ? new Date(parsed.data.recordedBefore) : null;
    // Include archived catalog products: deactivation must not erase history.
    // Catalog labels are current metadata, not historical price/cost snapshots.
    const products = await prisma.product.findMany({
      where: { organizationId: site.organizationId, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, name: true, barcodeValue: true, isActive: true },
      orderBy: { id: "asc" }, take: limit + 1,
    });
    const page = products.slice(0, limit);
    const groups = page.length ? await prisma.inventoryTransaction.groupBy({
      by: ["productId", "unitOfMeasure"],
      where: {
        organizationId: site.organizationId, siteId: site.id, productId: { in: page.map((p) => p.id) },
        occurredAt: { lt: asOfExclusive }, ...(recordedBefore ? { createdAt: { lt: recordedBefore } } : {}),
      },
      _sum: { quantity: true }, _count: { _all: true },
      _min: { occurredAt: true }, _max: { occurredAt: true, createdAt: true },
      orderBy: [{ productId: "asc" }, { unitOfMeasure: "asc" }],
    }) : [];
    return {
      siteId: site.id, asOfExclusive: asOfExclusive.toISOString(), recordedBefore: recordedBefore?.toISOString() ?? null,
      valuationStatus: "unavailable", catalogMetadata: "current", quantityBasis: "signedLedgerEventsByUnit",
      rows: page.flatMap((product) => {
        const events = groups.filter((g) => g.productId === product.id);
        return (events.length ? events : [null]).map((g) => ({
          product, quantity: g?._sum.quantity?.toFixed(4) ?? "0.0000", unitOfMeasure: g?.unitOfMeasure ?? null,
          provenance: { source: "inventoryLedger", eventCount: g?._count._all ?? 0, firstOccurredAt: g?._min.occurredAt?.toISOString() ?? null, lastOccurredAt: g?._max.occurredAt?.toISOString() ?? null, lastRecordedAt: g?._max.createdAt?.toISOString() ?? null },
        }));
      }),
      nextCursor: products.length > limit ? page[page.length - 1].id : null,
    };
  });
}
