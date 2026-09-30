import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { ambiguousRetailBarcodeAlternate, inferRetailBarcodeFormat, normalizeRetailBarcode, preferredRetailBarcode, productInputSchema, productUpdateSchema, upcEAliasForRetailBarcode, type RetailBarcodeFormat } from "@continuixai/shared";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isUniqueConstraintError } from "../lib/prismaErrors.js";
import { resolveOrganizationContext } from "../lib/organizationContext.js";
import { lockActorOrganizationAccess } from "../lib/accessLocking.js";
import { BARCODE_ALIAS_SOURCE, BARCODE_PRIMARY_SOURCE, MANAGED_BARCODE_SOURCES, lockProductBarcodeWrites, retailBarcodeDuplicateWhere, retailBarcodeProductWhere } from "../lib/productBarcodeIdentity.js";
import {
  MAX_INVENTORY_QUANTITY,
  aggregateCompositionDefinition,
} from "../lib/packagingResolution.js";

type ProductQuery = { q?: string; includeInactive?: string; organizationId?: string };

type CanonicalProductBarcodeResult =
  | { value: string | null | undefined; format: RetailBarcodeFormat | null; upcEAlias: string | null; primaryIdentifier: { type: "EAN"; value: string; source: string } | null }
  | { error: string; code: 400 | 422 };

function canonicalProductBarcode(
  barcodeValue: string | null | undefined,
  barcodeFormat?: RetailBarcodeFormat,
): CanonicalProductBarcodeResult {
  if (barcodeFormat && !barcodeValue) {
    return { error: "Choose a barcode before selecting its format.", code: 400 as const };
  }
  if (!barcodeValue) return { value: barcodeValue, format: null, upcEAlias: null, primaryIdentifier: null };
  if (!barcodeFormat && /^\d{8}$/.test(barcodeValue) && ambiguousRetailBarcodeAlternate(barcodeValue)) {
    return {
      error: "This 8-digit code can be UPC-E or EAN-8. Scan it with the camera or choose its barcode format.",
      code: 422 as const,
    };
  }
  const normalized = barcodeFormat
    ? normalizeRetailBarcode(barcodeValue, barcodeFormat)
    : preferredRetailBarcode(barcodeValue);
  if (!normalized) {
    return { error: `The barcode is not a valid ${barcodeFormat?.replace("_", "-") ?? "retail code"}.`, code: 400 as const };
  }
  // The stored value is canonical. A leading-zero EAN-13 and a UPC-E both
  // normalize to UPC-A, so downstream duplicate checks must use the stored
  // identity rather than the caller's original label format.
  const inferredFormat: RetailBarcodeFormat | null = barcodeFormat === "EAN_8" && /^\d{8}$/.test(normalized)
    ? "EAN_8"
    : inferRetailBarcodeFormat(normalized);
  const upcEAlias = inferredFormat === "UPC_A"
    ? upcEAliasForRetailBarcode(normalized)
    : null;
  const primaryIdentifier = inferredFormat === "EAN_8"
    ? { type: "EAN" as const, value: normalized, source: BARCODE_PRIMARY_SOURCE }
    : null;
  return { value: normalized, format: inferredFormat, upcEAlias, primaryIdentifier };
}

function managedBarcodeIdentifiers(
  organizationId: string,
  canonical: Exclude<CanonicalProductBarcodeResult, { error: string; code: 400 | 422 }>,
) {
  return [
    ...(canonical.upcEAlias
      ? [{ organizationId, type: "UPC" as const, value: canonical.upcEAlias, source: BARCODE_ALIAS_SOURCE }]
      : []),
    ...(canonical.primaryIdentifier
      ? [{ organizationId, ...canonical.primaryIdentifier }]
      : []),
  ];
}

const compositionInputSchema = z.object({
  parentPackagingId: z.string().trim().min(1),
  components: z.array(z.object({
    componentProductId: z.string().trim().min(1),
    quantityPerParent: z.number().int().positive().max(MAX_INVENTORY_QUANTITY),
  })).min(1),
}).strict();

async function organizationForRequest(request: {
  user: { sub: string; role?: string };
  query: unknown;
}) {
  const query = request.query as ProductQuery;
  return resolveOrganizationContext(request.user.sub, request.user.role, query.organizationId?.trim() || undefined);
}

async function lockProductCatalogAccess(
  tx: Prisma.TransactionClient,
  userId: string,
  platformRole: string | undefined,
  organizationId: string,
) {
  if (platformRole !== "ADMIN") {
    return Boolean(await lockActorOrganizationAccess(tx, userId, organizationId, "update"));
  }
  const organizations = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} AND "isActive" = TRUE FOR UPDATE
  `;
  if (!organizations[0]) return false;
  const actors = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User" WHERE "id" = ${userId} AND "isActive" = TRUE AND "role" = 'ADMIN' FOR UPDATE
  `;
  return Boolean(actors[0]);
}

export async function productRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request, reply) => {
    const context = await organizationForRequest(request);
    if (!context) return reply.code(400).send({ error: "select one authorized organization" });
    const query = request.query as ProductQuery;
    const includeInactive = query.includeInactive === "true";
    const q = query.q?.trim();

    return prisma.product.findMany({
      where: {
        organizationId: context.organizationId,
        ...(includeInactive ? {} : { isActive: true }),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { manufacturer: { contains: q, mode: "insensitive" } },
                { barcodeValue: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: { name: "asc" },
      include: { category: true },
    });
  });

  app.get("/by-barcode/:barcode", async (request, reply) => {
    const context = await organizationForRequest(request);
    if (!context) return reply.code(400).send({ error: "select one authorized organization" });
    const { barcode } = request.params as { barcode: string };
    // A product's exact primary barcode wins over aliases. This is essential
    // for dual-valid eight-digit labels: an EAN-8 may legitimately equal a
    // different UPC product's typed UPC-E alias.
    const exactMatches = await prisma.product.findMany({
      where: { organizationId: context.organizationId, barcodeValue: barcode.trim() },
      include: { category: true },
      take: 2,
    });
    const matches = exactMatches.length > 0
      ? exactMatches
      : await prisma.product.findMany({
          where: retailBarcodeProductWhere(context.organizationId, barcode),
          include: { category: true },
          take: 2,
        });
    const ambiguousAlternate = ambiguousRetailBarcodeAlternate(barcode);
    const conflictMatches = ambiguousAlternate && matches.length === 0
      ? await prisma.product.findMany({
          where: retailBarcodeProductWhere(context.organizationId, barcode, { includeAmbiguousAlternate: true }),
          include: { category: true },
          take: 2,
        })
      : matches;
    if (matches.length > 1 || (matches.length === 0 && conflictMatches.length > 0)) {
      return reply.code(409).send({ error: "barcode matches more than one product; review the catalog" });
    }
    const product = matches[0] ?? null;
    if (!product && /^\d{8}$/.test(barcode.trim()) && ambiguousAlternate) {
      return reply.code(422).send({ error: "This 8-digit code can be UPC-E or EAN-8. Configure the scanner to send UPC-A, use the camera, or select the product manually." });
    }
    if (!product) return reply.code(404).send({ error: "product not found" });
    return product;
  });

  app.get("/:id/compositions", async (request, reply) => {
    const context = await organizationForRequest(request);
    if (!context) return reply.code(400).send({ error: "select one authorized organization" });
    const { id } = request.params as { id: string };
    const parentProduct = await prisma.product.findFirst({
      where: { id, organizationId: context.organizationId },
      select: { id: true },
    });
    if (!parentProduct) return reply.code(404).send({ error: "product not found" });

    return prisma.productComposition.findMany({
      where: {
        parentPackaging: {
          productId: id,
          product: { organizationId: context.organizationId },
        },
        componentProduct: { organizationId: context.organizationId },
      },
      include: {
        parentPackaging: true,
        componentProduct: true,
      },
      orderBy: [
        { parentPackagingId: "asc" },
        { version: "desc" },
        { componentProductId: "asc" },
      ],
    });
  });

  app.post("/:id/compositions", async (request, reply) => {
    const context = await organizationForRequest(request);
    if (!context) return reply.code(400).send({ error: "select one authorized organization" });
    const parsed = compositionInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { id } = request.params as { id: string };

    let components: ReturnType<typeof aggregateCompositionDefinition>;
    try {
      components = aggregateCompositionDefinition(parsed.data.components, id);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Invalid composition",
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const access = await lockActorOrganizationAccess(tx, request.user.sub, context.organizationId, "update");
      if (!access || !["OWNER", "ADMIN", "MANAGER"].includes(access.organizationRole)) return { status: "forbidden" as const };

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`product-composition:${context.organizationId}:${parsed.data.parentPackagingId}`}))`;

      const parentPackaging = await tx.productPackaging.findFirst({
        where: {
          id: parsed.data.parentPackagingId,
          productId: id,
          isActive: true,
          product: { organizationId: context.organizationId, isActive: true },
        },
        select: { id: true, productId: true },
      });
      if (!parentPackaging) return { status: "parent-not-found" as const };

      const componentProductIds = components.map((component) => component.productId);
      const componentProducts = await tx.product.findMany({
        where: {
          id: { in: componentProductIds },
          organizationId: context.organizationId,
          isActive: true,
        },
        select: { id: true },
      });
      if (componentProducts.length !== componentProductIds.length) {
        return { status: "component-not-found" as const };
      }

      const latest = await tx.productComposition.aggregate({
        where: { parentPackagingId: parentPackaging.id },
        _max: { version: true },
      });
      const version = (latest._max.version ?? 0) + 1;

      await tx.productComposition.updateMany({
        where: { parentPackagingId: parentPackaging.id, isActive: true },
        data: { isActive: false },
      });
      await tx.productComposition.createMany({
        data: components.map((component) => ({
          parentPackagingId: parentPackaging.id,
          componentProductId: component.productId,
          quantityPerParent: component.eachQuantity,
          version,
          isActive: true,
        })),
      });
      const created = await tx.productComposition.findMany({
        where: { parentPackagingId: parentPackaging.id, version },
        include: { componentProduct: true },
        orderBy: { componentProductId: "asc" },
      });
      return { status: "created" as const, created };
    });

    if (result.status === "forbidden") {
      return reply.code(403).send({ error: "manager access required" });
    }
    if (result.status === "parent-not-found") {
      return reply.code(404).send({ error: "parent packaging not found" });
    }
    if (result.status === "component-not-found") {
      return reply.code(404).send({ error: "component product not found" });
    }
    return reply.code(201).send(result.created);
  });

  app.get("/:id", async (request, reply) => {
    const context = await organizationForRequest(request);
    if (!context) return reply.code(400).send({ error: "select one authorized organization" });
    const { id } = request.params as { id: string };
    const product = await prisma.product.findFirst({
      where: { id, organizationId: context.organizationId },
      include: { category: true },
    });
    if (!product) return reply.code(404).send({ error: "product not found" });
    return product;
  });

  app.post("/", async (request, reply) => {
    const context = await organizationForRequest(request);
    if (!context) return reply.code(400).send({ error: "select one authorized organization" });
    const parsed = productInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { barcodeFormat, ...productData } = parsed.data;
    const canonical = canonicalProductBarcode(productData.barcodeValue, barcodeFormat);
    if ("error" in canonical) return reply.code(canonical.code).send({ error: canonical.error });
    const barcodeValue = canonical.value;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const authorized = await lockProductCatalogAccess(tx, request.user.sub, request.user.role, context.organizationId);
        if (!authorized) return { forbidden: true as const };
        await lockProductBarcodeWrites(tx, context.organizationId);
        if (barcodeValue) {
          const duplicate = await tx.product.findMany({
            where: retailBarcodeDuplicateWhere(context.organizationId, barcodeValue, canonical.format, canonical.upcEAlias),
            select: { id: true },
            take: 1,
          });
          if (duplicate.length > 0) return { forbidden: false as const, duplicate: true as const };
        }
        const product = await tx.product.create({
          data: {
            ...productData,
            barcodeValue,
            organizationId: context.organizationId,
            ...(managedBarcodeIdentifiers(context.organizationId, canonical).length > 0
              ? {
                  identifiers: {
                    create: managedBarcodeIdentifiers(context.organizationId, canonical),
                  },
                }
              : {}),
          },
        });
        return { forbidden: false as const, duplicate: false as const, product };
      });
      if (result.forbidden) return reply.code(403).send({ error: "active organization membership required" });
      if (result.duplicate) return reply.code(409).send({ error: `A product with barcode "${parsed.data.barcodeValue}" already exists.` });
      return reply.code(201).send(result.product);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({ error: `A product with barcode "${parsed.data.barcodeValue}" already exists.` });
      }
      throw err;
    }
  });

  app.patch("/:id", async (request, reply) => {
    const context = await organizationForRequest(request);
    if (!context) return reply.code(400).send({ error: "select one authorized organization" });
    const { id } = request.params as { id: string };
    const parsed = productUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { barcodeFormat, ...productData } = parsed.data;
    if (barcodeFormat && productData.barcodeValue === undefined) {
      return reply.code(400).send({ error: "Choose a barcode before selecting its format." });
    }
    const canonical = canonicalProductBarcode(productData.barcodeValue, barcodeFormat);
    if ("error" in canonical) return reply.code(canonical.code).send({ error: canonical.error });
    const data = productData.barcodeValue === undefined
      ? productData
      : { ...productData, barcodeValue: canonical.value };

    try {
      const result = await prisma.$transaction(async (tx) => {
        const authorized = await lockProductCatalogAccess(tx, request.user.sub, request.user.role, context.organizationId);
        if (!authorized) return { status: "forbidden" as const };
        await lockProductBarcodeWrites(tx, context.organizationId);
        const existing = await tx.product.findFirst({
          where: { id, organizationId: context.organizationId },
          select: { id: true },
        });
        if (!existing) return { status: "missing" as const };
        if (data.barcodeValue) {
          const duplicate = await tx.product.findMany({
            where: { ...retailBarcodeDuplicateWhere(context.organizationId, data.barcodeValue, canonical.format, canonical.upcEAlias), id: { not: existing.id } },
            select: { id: true },
            take: 1,
          });
          if (duplicate.length > 0) return { status: "duplicate" as const };
        }
        const managedIdentifiers = managedBarcodeIdentifiers(context.organizationId, canonical);
        const product = await tx.product.update({
          where: { id: existing.id },
          data: {
            ...data,
            ...(productData.barcodeValue !== undefined
              ? {
                  identifiers: {
                    deleteMany: { source: { in: [...MANAGED_BARCODE_SOURCES] } },
                    ...(managedIdentifiers.length > 0
                      ? {
                          create: managedIdentifiers,
                        }
                      : {}),
                  },
                }
              : {}),
          },
        });
        return { status: "updated" as const, product };
      });
      if (result.status === "forbidden") return reply.code(403).send({ error: "active organization membership required" });
      if (result.status === "missing") return reply.code(404).send({ error: "product not found" });
      if (result.status === "duplicate") return reply.code(409).send({ error: "That barcode is already assigned to another product." });
      return result.product;
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({ error: "That barcode is already assigned to another product." });
      }
      throw err;
    }
  });

  app.delete("/:id", async (_request, reply) => {
    return reply.code(405).send({
      error: "Products cannot be hard-deleted because historical counts may reference them. Mark the product inactive instead.",
    });
  });
}
