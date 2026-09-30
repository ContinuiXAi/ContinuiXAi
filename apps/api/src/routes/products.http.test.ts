import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberships: vi.fn(),
  organizations: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  compositionFindMany: vi.fn(),
  transaction: vi.fn(),
  transactionQueryRaw: vi.fn(),
  transactionExecuteRaw: vi.fn(),
  transactionPackagingFindFirst: vi.fn(),
  transactionProductFindMany: vi.fn(),
  transactionCompositionAggregate: vi.fn(),
  transactionCompositionUpdateMany: vi.fn(),
  transactionCompositionCreateMany: vi.fn(),
  transactionCompositionFindMany: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    organizationMembership: { findMany: mocks.memberships },
    organization: { findFirst: mocks.organizations },
    product: {
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      create: mocks.create,
      update: mocks.update,
    },
    productComposition: { findMany: mocks.compositionFindMany },
    $transaction: mocks.transaction,
  },
}));

import { productRoutes } from "./products.js";

async function testApp(role = "GENERAL") {
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    Object.assign(request, { user: { sub: "user-a", role, tv: 0 } });
  });
  await app.register(productRoutes, { prefix: "/api/products" });
  return app;
}

describe("product routes tenant isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberships.mockResolvedValue([{ organizationId: "org-a" }]);
    mocks.organizations.mockResolvedValue({ id: "org-a" });
    mocks.findMany.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work({
      $queryRaw: mocks.transactionQueryRaw,
      $executeRaw: mocks.transactionExecuteRaw,
      productPackaging: { findFirst: mocks.transactionPackagingFindFirst },
      product: {
        findMany: (...args: unknown[]) => mocks.transactionProductFindMany(...args),
        findFirst: (...args: unknown[]) => mocks.findFirst(...args),
        create: (...args: unknown[]) => mocks.create(...args),
        update: (...args: unknown[]) => mocks.update(...args),
      },
      productComposition: {
        aggregate: mocks.transactionCompositionAggregate,
        updateMany: mocks.transactionCompositionUpdateMany,
        createMany: mocks.transactionCompositionCreateMany,
        findMany: mocks.transactionCompositionFindMany,
      },
    }));
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join(" ");
      if (sql.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role: "MANAGER" }];
      if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
      if (sql.includes('FROM "User"')) return [{ id: "user-a", role: "GENERAL", isActive: true }];
      return [];
    });
    mocks.transactionExecuteRaw.mockResolvedValue(1);
    mocks.transactionProductFindMany.mockImplementation((args: { where?: { isActive?: boolean } }) => (
      args.where?.isActive === true
        ? Promise.resolve([{ id: "component-a" }, { id: "component-b" }])
        : mocks.findMany(args)
    ));
    mocks.transactionPackagingFindFirst.mockResolvedValue({ id: "packaging-a", productId: "parent-a" });
    mocks.transactionCompositionAggregate.mockResolvedValue({ _max: { version: 1 } });
    mocks.transactionCompositionUpdateMany.mockResolvedValue({ count: 2 });
    mocks.transactionCompositionCreateMany.mockResolvedValue({ count: 2 });
    mocks.transactionCompositionFindMany.mockResolvedValue([
      {
        id: "composition-a-v2",
        parentPackagingId: "packaging-a",
        componentProductId: "component-a",
        quantityPerParent: 5,
        version: 2,
        isActive: true,
      },
      {
        id: "composition-b-v2",
        parentPackagingId: "packaging-a",
        componentProductId: "component-b",
        quantityPerParent: 3,
        version: 2,
        isActive: true,
      },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("always scopes catalog lists to the user's only active organization", async () => {
    mocks.findMany.mockResolvedValue([]);
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/products?includeInactive=true" });
    expect(response.statusCode).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organizationId: "org-a" }),
    }));
    await app.close();
  });

  it("does not read or update a product outside that organization", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const app = await testApp();
    const read = await app.inject({ method: "GET", url: "/api/products/product-in-org-b" });
    const update = await app.inject({
      method: "PATCH",
      url: "/api/products/product-in-org-b",
      payload: { name: "Changed" },
    });
    expect(read.statusCode).toBe(404);
    expect(update.statusCode).toBe(404);
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "product-in-org-b", organizationId: "org-a" },
    }));
    expect(mocks.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("writes the resolved organization instead of accepting global products", async () => {
    mocks.create.mockResolvedValue({ id: "product-a", organizationId: "org-a", name: "Milk" });
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: { name: "Milk", barcodeValue: "123" },
    });
    expect(response.statusCode).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: "org-a", barcodeValue: "123" }),
    });
    await app.close();
  });

  it("rechecks an active platform administrator before writing an explicitly selected organization", async () => {
    mocks.memberships.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: "product-a", organizationId: "org-a", name: "Milk" });
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join(" ");
      if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
      if (sql.includes('FROM "User"')) return [{ id: "user-a", role: "ADMIN", isActive: true }];
      if (sql.includes('FROM "OrganizationMembership"')) throw new Error("Platform administrator must not require tenant membership");
      return [];
    });
    const app = await testApp("ADMIN");

    const response = await app.inject({
      method: "POST",
      url: "/api/products?organizationId=org-a",
      payload: { name: "Milk", barcodeValue: "123" },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: "org-a", barcodeValue: "123" }),
    });
    await app.close();
  });

  it("stores a safely compressible UPC-E input under the shared UPC-A identity", async () => {
    mocks.create.mockResolvedValue({ id: "product-a", organizationId: "org-a", name: "Compact cosmetic", barcodeValue: "042000001007" });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: { name: "Compact cosmetic", barcodeValue: "04210007" },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: "org-a", barcodeValue: "042000001007" }),
    });
    await app.close();
  });

  it("requires explicit symbology before creating a dual-valid 8-digit barcode", async () => {
    const app = await testApp();

    const ambiguous = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: { name: "Unknown eight-digit item", barcodeValue: "01234558" },
    });
    const upcE = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: { name: "UPC-E item", barcodeValue: "01234558", barcodeFormat: "UPC_E" },
    });

    expect(ambiguous.statusCode).toBe(422);
    expect(ambiguous.json().error).toMatch(/UPC-E.*EAN-8|EAN-8.*UPC-E/i);
    expect(upcE.statusCode).toBe(201);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        barcodeValue: "012345000058",
        identifiers: {
          create: [expect.objectContaining({ type: "UPC", value: "01234558", source: "CONTINUIXAI_BARCODE_ALIAS" })],
        },
      }),
    });
    expect(mocks.create.mock.calls[0][0].data).not.toHaveProperty("barcodeFormat");
    await app.close();
  });

  it("allows an explicitly identified EAN-8 even when its UPC-E expansion belongs to another product", async () => {
    mocks.findMany.mockImplementation(async ({ where }: { where: unknown }) => (
      JSON.stringify(where).includes("012345000058") ? [{ id: "upc-a-product", barcodeValue: "012345000058" }] : []
    ));
    mocks.create.mockResolvedValue({ id: "ean-8-product", organizationId: "org-a", name: "EAN-8 item", barcodeValue: "01234558" });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: { name: "EAN-8 item", barcodeValue: "01234558", barcodeFormat: "EAN_8" },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ barcodeValue: "01234558" }),
    });
    await app.close();
  });

  it("rejects a new UPC form when an equivalent legacy product already exists", async () => {
    mocks.findMany.mockResolvedValue([{ id: "legacy", organizationId: "org-a", barcodeValue: "04210007" }]);
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: { name: "Duplicate cosmetic", barcodeValue: "042000001007" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/already exists/i);
    expect(mocks.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not let a product update introduce an equivalent retail barcode", async () => {
    mocks.findFirst.mockResolvedValue({ id: "product-a" });
    mocks.findMany.mockResolvedValue([{ id: "legacy", organizationId: "org-a", barcodeValue: "04210007" }]);
    const app = await testApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/products/product-a",
      payload: { barcodeValue: "042000001007" },
    });

    expect(response.statusCode).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("finds a legacy compressed UPC product when a camera sends the expanded UPC-A", async () => {
    const legacyProduct = {
      id: "legacy-cosmetic",
      organizationId: "org-a",
      barcodeValue: "04210007",
      name: "Compact cosmetic",
      category: null,
    };
    mocks.findFirst.mockResolvedValue(null);
    mocks.findMany.mockResolvedValue([legacyProduct]);
    const app = await testApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/products/by-barcode/042000001007",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "legacy-cosmetic",
      barcodeValue: "04210007",
    });
    await app.close();
  });

  it("refuses an ambiguous catalog that already contains two equivalent UPC forms", async () => {
    mocks.findFirst.mockResolvedValue({ id: "compressed-product", barcodeValue: "04210007" });
    mocks.findMany.mockResolvedValue([
      { id: "compressed-product", barcodeValue: "04210007" },
      { id: "expanded-product", barcodeValue: "042000001007" },
    ]);
    const app = await testApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/products/by-barcode/04210007",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/more than one product/i);
    await app.close();
  });

  it("requires symbology when an unknown 8-digit value is valid as both EAN-8 and UPC-E", async () => {
    mocks.findMany.mockResolvedValue([]);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/products/by-barcode/01234558" });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatch(/UPC-E.*EAN-8|EAN-8.*UPC-E/i);
    await app.close();
  });

  it("returns the exact EAN-8 catalog match even when a distinct UPC-A alternate also exists", async () => {
    const ean8 = { id: "ean-8-product", organizationId: "org-a", barcodeValue: "01234558", name: "EAN-8 item", category: null };
    const upcA = { id: "upc-a-product", organizationId: "org-a", barcodeValue: "012345000058", name: "UPC-A item", category: null };
    mocks.findMany.mockImplementation(async ({ where }: { where: unknown }) => (
      JSON.stringify(where) === JSON.stringify({ organizationId: "org-a", barcodeValue: "01234558" })
        ? [ean8]
        : [ean8, upcA]
    ));
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/products/by-barcode/01234558" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "ean-8-product", barcodeValue: "01234558" });
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("canonicalizes a leading-zero EAN-13 as UPC-A and records its UPC-E alias", async () => {
    mocks.create.mockResolvedValue({ id: "product-a", organizationId: "org-a", barcodeValue: "012345000058", name: "Wrapped UPC" });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: { name: "Wrapped UPC", barcodeValue: "0012345000058", barcodeFormat: "EAN_13" },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        barcodeValue: "012345000058",
        identifiers: {
          create: [expect.objectContaining({ type: "UPC", value: "01234558", source: "CONTINUIXAI_BARCODE_ALIAS" })],
        },
      }),
    });
    await app.close();
  });

  it("records explicit EAN-8 identity metadata for lossless CSV export", async () => {
    mocks.create.mockResolvedValue({ id: "ean-8-product", organizationId: "org-a", barcodeValue: "01234558", name: "EAN-8 item" });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: { name: "EAN-8 item", barcodeValue: "01234558", barcodeFormat: "EAN_8" },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        barcodeValue: "01234558",
        identifiers: {
          create: [expect.objectContaining({ type: "EAN", value: "01234558", source: "CONTINUIXAI_BARCODE_PRIMARY" })],
        },
      }),
    });
    await app.close();
  });

  it("blocks a camera UPC-A from silently bypassing a dual-valid legacy 8-digit catalog row", async () => {
    mocks.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "legacy-ambiguous", organizationId: "org-a", barcodeValue: "01234558" }]);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/products/by-barcode/012345000058" });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/review the catalog/i);
    await app.close();
  });

  it("requires an explicit selection instead of guessing across memberships", async () => {
    mocks.memberships.mockResolvedValue([{ organizationId: "org-a" }, { organizationId: "org-b" }]);
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/products" });
    expect(response.statusCode).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns inactive historical composition versions within the selected organization", async () => {
    mocks.findFirst.mockResolvedValue({ id: "parent-a" });
    mocks.compositionFindMany.mockResolvedValue([
      { id: "a-v2", version: 2, isActive: true, componentProductId: "component-a", quantityPerParent: 5 },
      { id: "a-v1", version: 1, isActive: false, componentProductId: "component-a", quantityPerParent: 4 },
    ]);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/products/parent-a/compositions" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: "a-v2", version: 2, isActive: true, componentProductId: "component-a", quantityPerParent: 5 },
      { id: "a-v1", version: 1, isActive: false, componentProductId: "component-a", quantityPerParent: 4 },
    ]);
    expect(mocks.compositionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        parentPackaging: {
          productId: "parent-a",
          product: { organizationId: "org-a" },
        },
        componentProduct: { organizationId: "org-a" },
      },
    }));
    await app.close();
  });

  it("does not reveal compositions for a guessed cross-tenant parent product", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/products/parent-in-org-b/compositions" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "product not found" });
    expect(mocks.compositionFindMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates an aggregated immutable composition version in one authorized transaction", async () => {
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/products/parent-a/compositions",
      payload: {
        parentPackagingId: "packaging-a",
        components: [
          { componentProductId: "component-a", quantityPerParent: 2 },
          { componentProductId: "component-a", quantityPerParent: 3 },
          { componentProductId: "component-b", quantityPerParent: 3 },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual([
      expect.objectContaining({ componentProductId: "component-a", quantityPerParent: 5, version: 2, isActive: true }),
      expect.objectContaining({ componentProductId: "component-b", quantityPerParent: 3, version: 2, isActive: true }),
    ]);
    expect(mocks.transactionQueryRaw).toHaveBeenCalledTimes(3);
    expect(mocks.transactionExecuteRaw).toHaveBeenCalledTimes(1);
    const authorizationSql = mocks.transactionQueryRaw.mock.calls.map(([parts]) => parts.join(" "));
    expect(authorizationSql).toEqual([
      expect.stringContaining('FROM "Organization"'),
      expect.stringContaining('FROM "User"'),
      expect.stringContaining('FROM "OrganizationMembership"'),
    ]);
    expect(authorizationSql.every((sql) => sql.includes("FOR UPDATE"))).toBe(true);
    expect(mocks.transactionPackagingFindFirst).toHaveBeenCalledWith({
      where: {
        id: "packaging-a",
        productId: "parent-a",
        isActive: true,
        product: { organizationId: "org-a", isActive: true },
      },
      select: { id: true, productId: true },
    });
    expect(mocks.transactionProductFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["component-a", "component-b"] },
        organizationId: "org-a",
        isActive: true,
      },
      select: { id: true },
    });
    expect(mocks.transactionCompositionUpdateMany).toHaveBeenCalledWith({
      where: { parentPackagingId: "packaging-a", isActive: true },
      data: { isActive: false },
    });
    expect(mocks.transactionCompositionCreateMany).toHaveBeenCalledWith({
      data: [
        {
          parentPackagingId: "packaging-a",
          componentProductId: "component-a",
          quantityPerParent: 5,
          version: 2,
          isActive: true,
        },
        {
          parentPackagingId: "packaging-a",
          componentProductId: "component-b",
          quantityPerParent: 3,
          version: 2,
          isActive: true,
        },
      ],
    });
    await app.close();
  });

  it("does not grant composition writes from a global role without an active manager membership", async () => {
    mocks.transactionQueryRaw.mockResolvedValue([]);
    const app = await testApp("ADMIN");

    const response = await app.inject({
      method: "POST",
      url: "/api/products/parent-a/compositions?organizationId=org-a",
      payload: {
        parentPackagingId: "packaging-a",
        components: [{ componentProductId: "component-a", quantityPerParent: 1 }],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.transactionPackagingFindFirst).not.toHaveBeenCalled();
    expect(mocks.transactionCompositionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transactionCompositionCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an active but insufficient organization role before writing a composition", async () => {
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join(" ");
      if (sql.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role: "VIEWER" }];
      if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
      if (sql.includes('FROM "User"')) return [{ id: "user-a", role: "GENERAL", isActive: true }];
      return [];
    });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/products/parent-a/compositions?organizationId=org-a",
      payload: {
        parentPackagingId: "packaging-a",
        components: [{ componentProductId: "component-a", quantityPerParent: 1 }],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.transactionExecuteRaw).not.toHaveBeenCalled();
    expect(mocks.transactionCompositionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transactionCompositionCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a guessed parent packaging before any composition write", async () => {
    mocks.transactionPackagingFindFirst.mockResolvedValue(null);
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/products/parent-a/compositions",
      payload: {
        parentPackagingId: "packaging-in-org-b",
        components: [{ componentProductId: "component-a", quantityPerParent: 1 }],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "parent packaging not found" });
    expect(mocks.transactionCompositionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transactionCompositionCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a guessed or cross-tenant component before any composition write", async () => {
    mocks.transactionProductFindMany.mockResolvedValue([{ id: "component-a" }]);
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/products/parent-a/compositions",
      payload: {
        parentPackagingId: "packaging-a",
        components: [
          { componentProductId: "component-a", quantityPerParent: 1 },
          { componentProductId: "component-in-org-b", quantityPerParent: 1 },
        ],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "component product not found" });
    expect(mocks.transactionCompositionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transactionCompositionCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects mixed-organization context before opening a write transaction", async () => {
    mocks.organizations.mockResolvedValue(null);
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/products/parent-a/compositions?organizationId=org-b",
      payload: {
        parentPackagingId: "packaging-a",
        components: [{ componentProductId: "component-a", quantityPerParent: 1 }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.transactionCompositionCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a self-component before opening a write transaction", async () => {
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/products/parent-a/compositions",
      payload: {
        parentPackagingId: "packaging-a",
        components: [{ componentProductId: "parent-a", quantityPerParent: 1 }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.transactionCompositionCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a composition quantity above the PostgreSQL integer maximum before opening a write transaction", async () => {
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/products/parent-a/compositions",
      payload: {
        parentPackagingId: "packaging-a",
        components: [{ componentProductId: "component-a", quantityPerParent: 2_147_483_648 }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.transactionCompositionCreateMany).not.toHaveBeenCalled();
    await app.close();
  });
});
