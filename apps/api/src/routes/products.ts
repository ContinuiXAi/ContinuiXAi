import type { FastifyInstance } from "fastify";
import { productInputSchema, productUpdateSchema } from "@continuixai/shared";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isUniqueConstraintError } from "../lib/prismaErrors.js";
import { resolveOrganizationContext } from "../lib/organizationContext.js";
import { lockActorOrganizationAccess } from "../lib/accessLocking.js";
import {
  MAX_INVENTORY_QUANTITY,
  aggregateCompositionDefinition,
} from "../lib/packagingResolution.js";

type ProductQuery = { q?: string; includeInactive?: string; organizationId?: string };

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
    const product = await prisma.product.findFirst({
      where: { organizationId: context.organizationId, barcodeValue: barcode },
      include: { category: true },
    });
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

    try {
      const product = await prisma.product.create({
        data: { ...parsed.data, organizationId: context.organizationId },
      });
      return reply.code(201).send(product);
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

    try {
      const existing = await prisma.product.findFirst({
        where: { id, organizationId: context.organizationId },
        select: { id: true },
      });
      if (!existing) return reply.code(404).send({ error: "product not found" });
      return await prisma.product.update({ where: { id: existing.id }, data: parsed.data });
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
