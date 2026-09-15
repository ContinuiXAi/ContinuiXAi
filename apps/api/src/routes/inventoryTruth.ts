import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

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

function asNumber(quantity: unknown) {
  const number = Number(quantity);
  if (!Number.isFinite(number)) throw new Error("invalid inventory expectation quantity");
  return number;
}

export async function inventoryTruthRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

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
      const authorizedSites = await tx.$queryRaw<Array<{ id: string; organizationId: string }>>`
        SELECT site."id", site."organizationId"
        FROM "Site" AS site
        INNER JOIN "SiteMembership" AS site_membership
          ON site_membership."siteId" = site."id"
        INNER JOIN "Organization" AS organization
          ON organization."id" = site."organizationId"
        INNER JOIN "OrganizationMembership" AS organization_membership
          ON organization_membership."organizationId" = organization."id"
        WHERE site_membership."userId" = ${userId}
          AND site."id" = ${siteId}
          AND site_membership."isActive" = TRUE
          AND organization_membership."userId" = ${userId}
          AND organization_membership."isActive" = TRUE
          AND site."isActive" = TRUE
          AND organization."isActive" = TRUE
        FOR UPDATE OF site, site_membership, organization, organization_membership
      `;
      const site = authorizedSites[0];
      if (!site) return { status: "forbidden" as const };

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
        location: { siteId: session.siteId, isActive: true },
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

    const hints = await prisma.productLocationHint.findMany({
      where: {
        organizationId: session.site.organizationId,
        siteId: session.siteId,
        location: { siteId: session.siteId, isActive: true },
        product: { organizationId: session.site.organizationId, isActive: true },
      },
      select: {
        productId: true,
        locationId: true,
        evidence: true,
        product: { select: { id: true, barcodeValue: true, name: true, packageSize: true } },
        location: { select: { id: true, code: true, sortOrder: true } },
      },
      orderBy: [
        { location: { sortOrder: "asc" } },
        { location: { code: "asc" } },
        { location: { id: "asc" } },
        { product: { name: "asc" } },
        { productId: "asc" },
      ],
    });

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
}
