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
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work({
      $queryRaw: mocks.transactionQueryRaw,
      $executeRaw: mocks.transactionExecuteRaw,
      productPackaging: { findFirst: mocks.transactionPackagingFindFirst },
      product: { findMany: mocks.transactionProductFindMany },
      productComposition: {
        aggregate: mocks.transactionCompositionAggregate,
        updateMany: mocks.transactionCompositionUpdateMany,
        createMany: mocks.transactionCompositionCreateMany,
        findMany: mocks.transactionCompositionFindMany,
      },
    }));
    mocks.transactionQueryRaw.mockResolvedValue([{ organizationId: "org-a" }]);
    mocks.transactionExecuteRaw.mockResolvedValue(1);
    mocks.transactionPackagingFindFirst.mockResolvedValue({ id: "packaging-a", productId: "parent-a" });
    mocks.transactionProductFindMany.mockResolvedValue([
      { id: "component-a" },
      { id: "component-b" },
    ]);
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
    expect(mocks.transactionQueryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.transactionExecuteRaw).toHaveBeenCalledTimes(1);
    const [authorizationSql, ...authorizationValues] = mocks.transactionQueryRaw.mock.calls[0];
    expect(authorizationSql.join(" ")).toMatch(/membership\."isActive" = TRUE/);
    expect(authorizationSql.join(" ")).toMatch(/membership\."role" IN \('OWNER', 'ADMIN', 'MANAGER'\)/);
    expect(authorizationSql.join(" ")).toMatch(/organization\."isActive" = TRUE/);
    expect(authorizationValues).toEqual(["user-a", "org-a"]);
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
