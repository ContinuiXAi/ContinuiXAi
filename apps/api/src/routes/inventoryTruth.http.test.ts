import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensurePilotSiteForUser: vi.fn(),
  siteFindMany: vi.fn(),
  siteFindFirst: vi.fn(),
  productFindFirst: vi.fn(),
  locationFindFirst: vi.fn(),
  hintFindMany: vi.fn(),
  hintUpsert: vi.fn(),
  sessionFindFirst: vi.fn(),
  expectationFindMany: vi.fn(),
  visitFindMany: vi.fn(),
  transaction: vi.fn(),
  transactionQueryRaw: vi.fn(),
  transactionExecuteRaw: vi.fn(),
  transactionSessionFindFirst: vi.fn(),
  transactionSessionCreate: vi.fn(),
  transactionInventoryGroupBy: vi.fn(),
  transactionHintFindMany: vi.fn(),
  transactionExpectationCreateMany: vi.fn(),
  transactionVisitCreateMany: vi.fn(),
}));

vi.mock("../lib/pilotSite.js", () => ({
  ensurePilotSiteForUser: mocks.ensurePilotSiteForUser,
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    site: { findMany: mocks.siteFindMany, findFirst: mocks.siteFindFirst },
    product: { findFirst: mocks.productFindFirst },
    storeLocation: { findFirst: mocks.locationFindFirst },
    productLocationHint: { findMany: mocks.hintFindMany, upsert: mocks.hintUpsert },
    storeCountSession: { findFirst: mocks.sessionFindFirst },
    storeCountExpectation: { findMany: mocks.expectationFindMany },
    storeCountLocationVisit: { findMany: mocks.visitFindMany },
    $transaction: mocks.transaction,
  },
}));

import { inventoryTruthRoutes } from "./inventoryTruth.js";
import { storeCountRoutes } from "./storeCount.js";

async function testApp(role = "GENERAL") {
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    Object.assign(request, { user: { sub: "user-a", role, tv: 0 } });
  });
  await app.register(storeCountRoutes, { prefix: "/api/store-count" });
  await app.register(inventoryTruthRoutes, { prefix: "/api/inventory-truth" });
  return app;
}

const activeSite = { id: "site-a", organizationId: "org-a" };
const createdSession = {
  id: "session-a",
  siteId: "site-a",
  name: "Cycle count",
  status: "ACTIVE",
  startedById: "user-a",
};

describe("inventory truth HTTP routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensurePilotSiteForUser.mockResolvedValue(null);
    mocks.siteFindMany.mockResolvedValue([activeSite]);
    mocks.siteFindFirst.mockResolvedValue(activeSite);
    mocks.productFindFirst.mockResolvedValue({ id: "product-a", organizationId: "org-a", isActive: true });
    mocks.locationFindFirst.mockResolvedValue({ id: "shelf", siteId: "site-a", code: "A1", isActive: true });
    mocks.hintUpsert.mockResolvedValue({
      id: "hint-a",
      organizationId: "org-a",
      siteId: "site-a",
      productId: "product-a",
      locationId: "shelf",
      evidence: "ASSIGNED",
      isRequired: true,
    });
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work({
      $queryRaw: mocks.transactionQueryRaw,
      $executeRaw: mocks.transactionExecuteRaw,
      site: { findFirst: mocks.siteFindFirst },
      product: { findFirst: mocks.productFindFirst },
      storeLocation: { findFirst: mocks.locationFindFirst },
      storeCountSession: {
        findFirst: mocks.transactionSessionFindFirst,
        create: mocks.transactionSessionCreate,
      },
      inventoryTransaction: { groupBy: mocks.transactionInventoryGroupBy },
      productLocationHint: { findMany: mocks.transactionHintFindMany, upsert: mocks.hintUpsert },
      storeCountExpectation: { createMany: mocks.transactionExpectationCreateMany },
      storeCountLocationVisit: { createMany: mocks.transactionVisitCreateMany },
    }));
    mocks.transactionExecuteRaw.mockResolvedValue(1);
    mocks.transactionQueryRaw.mockResolvedValue([activeSite]);
    mocks.transactionSessionFindFirst.mockResolvedValue(null);
    mocks.transactionSessionCreate.mockResolvedValue(createdSession);
    mocks.transactionInventoryGroupBy.mockResolvedValue([
      { productId: "product-a", _sum: { quantity: 15 } },
      { productId: "product-b", _sum: { quantity: -2 } },
    ]);
    mocks.transactionHintFindMany.mockResolvedValue([
      { locationId: "shelf", location: { id: "shelf", sortOrder: 10, code: "A1" } },
      { locationId: "shelf", location: { id: "shelf", sortOrder: 10, code: "A1" } },
      { locationId: "back", location: { id: "back", sortOrder: 20, code: "BACK" } },
    ]);
    mocks.transactionExpectationCreateMany.mockResolvedValue({ count: 2 });
    mocks.transactionVisitCreateMany.mockResolvedValue({ count: 2 });
    mocks.expectationFindMany.mockResolvedValue([]);
    mocks.visitFindMany.mockResolvedValue([]);
    mocks.hintFindMany.mockResolvedValue([]);
  });

  it("snapshots signed site/product ledger totals and active required location visits when a session is created", async () => {
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      payload: { siteId: "site-a", name: "Cycle count" },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.transactionInventoryGroupBy).toHaveBeenCalledWith({
      by: ["productId"],
      where: {
        organizationId: "org-a",
        siteId: "site-a",
        product: { organizationId: "org-a" },
      },
      _sum: { quantity: true },
      orderBy: { productId: "asc" },
    });
    expect(mocks.transactionExpectationCreateMany).toHaveBeenCalledWith({
      data: [
        { sessionId: "session-a", productId: "product-a", expectedStoreQty: 15 },
        { sessionId: "session-a", productId: "product-b", expectedStoreQty: -2 },
      ],
    });
    expect(mocks.transactionHintFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        siteId: "site-a",
        isRequired: true,
        location: { siteId: "site-a", isActive: true },
        product: { organizationId: "org-a", isActive: true },
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
    expect(mocks.transactionVisitCreateMany).toHaveBeenCalledWith({
      data: [
        { sessionId: "session-a", locationId: "shelf" },
        { sessionId: "session-a", locationId: "back" },
      ],
    });
    await app.close();
  });

  it("reuses an active session without resnapshotting expectations or resetting visits", async () => {
    mocks.transactionSessionFindFirst.mockResolvedValue(createdSession);
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      payload: { siteId: "site-a" },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.transactionSessionCreate).not.toHaveBeenCalled();
    expect(mocks.transactionInventoryGroupBy).not.toHaveBeenCalled();
    expect(mocks.transactionExpectationCreateMany).not.toHaveBeenCalled();
    expect(mocks.transactionVisitCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns a location-first route with every evidence type and no per-location expected quantity", async () => {
    mocks.sessionFindFirst.mockResolvedValue({
      id: "session-a",
      siteId: "site-a",
      site: { organizationId: "org-a" },
    });
    mocks.expectationFindMany.mockResolvedValue([
      { productId: "product-a", expectedStoreQty: 15 },
      { productId: "product-b", expectedStoreQty: 4 },
    ]);
    mocks.visitFindMany.mockResolvedValue([
      { status: "VERIFIED", location: { id: "shelf", code: "A1", name: "Main shelf", sortOrder: 10 } },
      { status: "PENDING", location: { id: "back", code: "BACK", name: "Backstock", sortOrder: 20 } },
      { status: "PENDING", location: { id: "stock", code: "STK", name: "Stock room", sortOrder: 25 } },
      { status: "PENDING", location: { id: "receiving", code: "RCV", name: "Receiving", sortOrder: 30 } },
      { status: "PENDING", location: { id: "display", code: "DSP", name: "Display", sortOrder: 40 } },
    ]);
    mocks.hintFindMany.mockResolvedValue([
      { productId: "product-a", locationId: "shelf", evidence: "ASSIGNED", product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" }, location: { id: "shelf", code: "A1", sortOrder: 10 } },
      { productId: "product-b", locationId: "shelf", evidence: "ASSIGNED", product: { id: "product-b", barcodeValue: "222", name: "Berry Bar", packageSize: null }, location: { id: "shelf", code: "A1", sortOrder: 10 } },
      { productId: "product-a", locationId: "back", evidence: "PREVIOUSLY_COUNTED", product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" }, location: { id: "back", code: "BACK", sortOrder: 20 } },
      { productId: "product-a", locationId: "stock", evidence: "RECENTLY_STOCKED", product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" }, location: { id: "stock", code: "STK", sortOrder: 25 } },
      { productId: "product-a", locationId: "receiving", evidence: "RECEIVED", product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" }, location: { id: "receiving", code: "RCV", sortOrder: 30 } },
      { productId: "product-a", locationId: "display", evidence: "DISPLAY_COMPONENT", product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" }, location: { id: "display", code: "DSP", sortOrder: 40 } },
    ]);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/session-a/route" });

    expect(response.statusCode).toBe(200);
    const route = response.json();
    expect(route.sessionId).toBe("session-a");
    expect(route.expectedProducts).toBe(2);
    expect(route.locations.map((location: { id: string }) => location.id)).toEqual(["shelf", "back", "stock", "receiving", "display"]);
    expect(route.locations[0].products.map((product: { productId: string }) => product.productId)).toEqual(["product-a", "product-b"]);
    expect(route.locations[0].products[0]).toMatchObject({
      productId: "product-a",
      expectedStoreQty: 15,
      suspectedLocations: [
        { locationId: "shelf", code: "A1", verified: true, evidence: "ASSIGNED" },
        { locationId: "back", code: "BACK", verified: false, evidence: "PREVIOUSLY_COUNTED" },
        { locationId: "stock", code: "STK", verified: false, evidence: "RECENTLY_STOCKED" },
        { locationId: "receiving", code: "RCV", verified: false, evidence: "RECEIVED" },
        { locationId: "display", code: "DSP", verified: false, evidence: "DISPLAY_COMPONENT" },
      ],
    });
    expect(mocks.hintFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        organizationId: "org-a",
        siteId: "site-a",
        location: { siteId: "site-a", isActive: true },
        product: { organizationId: "org-a", isActive: true },
      },
    }));
    expect(JSON.stringify(route)).not.toContain("expectedLocationQty");
    await app.close();
  });

  it("includes optional assigned products and auxiliary evidence without adding an optional visit", async () => {
    mocks.sessionFindFirst.mockResolvedValue({
      id: "session-a",
      siteId: "site-a",
      site: { organizationId: "org-a" },
    });
    mocks.expectationFindMany.mockResolvedValue([
      { productId: "product-a", expectedStoreQty: 15 },
      { productId: "product-b", expectedStoreQty: 4 },
    ]);
    mocks.visitFindMany.mockResolvedValue([
      { status: "PENDING", location: { id: "shelf", code: "A1", name: "Main shelf", sortOrder: 10 } },
    ]);
    const requiredHint = {
      productId: "product-a",
      locationId: "shelf",
      evidence: "ASSIGNED",
      product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" },
      location: { id: "shelf", code: "A1", sortOrder: 10 },
    };
    const allHints = [
      requiredHint,
      {
        productId: "product-b",
        locationId: "shelf",
        evidence: "ASSIGNED",
        product: { id: "product-b", barcodeValue: "222", name: "Berry Bar", packageSize: null },
        location: { id: "shelf", code: "A1", sortOrder: 10 },
      },
      {
        productId: "product-a",
        locationId: "receiving",
        evidence: "RECEIVED",
        product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" },
        location: { id: "receiving", code: "RCV", sortOrder: 30 },
      },
    ];
    mocks.hintFindMany.mockImplementation(async (args: { where: { isRequired?: boolean } }) =>
      args.where.isRequired ? [requiredHint] : allHints,
    );
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/session-a/route" });

    expect(response.statusCode).toBe(200);
    const route = response.json();
    expect(route.locations.map((location: { id: string }) => location.id)).toEqual(["shelf"]);
    expect(route.locations[0].products.map((product: { productId: string }) => product.productId)).toEqual([
      "product-a",
      "product-b",
    ]);
    expect(route.locations[0].products[0].suspectedLocations).toEqual([
      { locationId: "shelf", code: "A1", verified: false, evidence: "ASSIGNED" },
      { locationId: "receiving", code: "RCV", verified: false, evidence: "RECEIVED" },
    ]);
    await app.close();
  });

  it("excludes mismatched expectation products and cross-site visits from an authorized route", async () => {
    const localExpectation = { productId: "product-a", expectedStoreQty: 15 };
    const foreignExpectation = { productId: "foreign-product", expectedStoreQty: 99 };
    const localVisit = {
      status: "PENDING",
      location: { id: "shelf", code: "A1", name: "Main shelf", sortOrder: 10 },
    };
    const foreignVisit = {
      status: "PENDING",
      location: { id: "foreign-location", code: "SECRET", name: "Other site stockroom", sortOrder: 20 },
    };
    mocks.sessionFindFirst.mockResolvedValue({
      id: "session-a",
      siteId: "site-a",
      site: { organizationId: "org-a" },
    });
    mocks.expectationFindMany.mockImplementation(async (args: { where: { product?: { organizationId?: string } } }) =>
      args.where.product?.organizationId === "org-a"
        ? [localExpectation]
        : [localExpectation, foreignExpectation],
    );
    mocks.visitFindMany.mockImplementation(async (args: { where: { location?: { siteId?: string; isActive?: boolean } } }) =>
      args.where.location?.siteId === "site-a" && args.where.location.isActive === true
        ? [localVisit]
        : [localVisit, foreignVisit],
    );
    mocks.hintFindMany.mockResolvedValue([
      {
        productId: "product-a",
        locationId: "shelf",
        evidence: "ASSIGNED",
        product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" },
        location: { id: "shelf", code: "A1", sortOrder: 10 },
      },
    ]);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/session-a/route" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      expectedProducts: 1,
      locations: [{ id: "shelf", code: "A1" }],
    });
    expect(JSON.stringify(response.json())).not.toContain("foreign-product");
    expect(JSON.stringify(response.json())).not.toContain("SECRET");
    expect(mocks.expectationFindMany).toHaveBeenCalledWith({
      where: { sessionId: "session-a", product: { organizationId: "org-a" } },
      select: { productId: true, expectedStoreQty: true },
      orderBy: { productId: "asc" },
    });
    expect(mocks.visitFindMany).toHaveBeenCalledWith({
      where: { sessionId: "session-a", location: { siteId: "site-a", isActive: true } },
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
    await app.close();
  });

  it("creates an authorized suspected-location hint for the current organization and site", async () => {
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/products/product-a/location-hints",
      payload: { siteId: "site-a", locationId: "shelf", evidence: "ASSIGNED", isRequired: true },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transactionQueryRaw).toHaveBeenCalledTimes(1);
    const [authorizationSql, ...authorizationValues] = mocks.transactionQueryRaw.mock.calls[0];
    expect(authorizationSql.join(" ")).toMatch(/SiteMembership/);
    expect(authorizationSql.join(" ")).toMatch(/OrganizationMembership/);
    expect(authorizationSql.join(" ")).toMatch(/FOR UPDATE/);
    expect(authorizationValues).toEqual(["user-a", "site-a", "user-a"]);
    expect(mocks.hintUpsert).toHaveBeenCalledWith({
      where: { siteId_productId_locationId: { siteId: "site-a", productId: "product-a", locationId: "shelf" } },
      update: { evidence: "ASSIGNED", isRequired: true, lastObservedAt: expect.any(Date) },
      create: {
        organizationId: "org-a",
        siteId: "site-a",
        productId: "product-a",
        locationId: "shelf",
        evidence: "ASSIGNED",
        isRequired: true,
        lastObservedAt: expect.any(Date),
      },
    });
    await app.close();
  });

  it("rejects a cross-tenant product only when the lookup enforces organization and activity", async () => {
    mocks.productFindFirst.mockImplementation(async (args: { where: { organizationId?: string; isActive?: boolean } }) =>
      args.where.organizationId === "org-a" && args.where.isActive === true
        ? null
        : { id: "product-from-org-b" },
    );
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/products/product-a/location-hints",
      payload: { siteId: "site-a", locationId: "guessed-location", evidence: "ASSIGNED" },
    });

    expect(response.statusCode).toBe(404);
    expect(mocks.locationFindFirst).not.toHaveBeenCalled();
    expect(mocks.hintUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a cross-site location only when the lookup enforces site ownership", async () => {
    mocks.locationFindFirst.mockImplementation(async (args: { where: { siteId?: string } }) =>
      args.where.siteId === "site-a" ? null : { id: "location-from-site-b" },
    );
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/products/product-a/location-hints",
      payload: { siteId: "site-a", locationId: "location-from-site-b", evidence: "ASSIGNED" },
    });

    expect(response.statusCode).toBe(404);
    expect(mocks.hintUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an inactive location only when the lookup enforces activity", async () => {
    mocks.locationFindFirst.mockImplementation(async (args: { where: { isActive?: boolean } }) =>
      args.where.isActive === true ? null : { id: "inactive-location" },
    );
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/products/product-a/location-hints",
      payload: { siteId: "site-a", locationId: "inactive-location", evidence: "ASSIGNED" },
    });

    expect(response.statusCode).toBe(404);
    expect(mocks.hintUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["inactive site membership", 'site_membership."isActive" = TRUE'],
    ["inactive organization membership", 'organization_membership."isActive" = TRUE'],
    ["inactive site", 'site."isActive" = TRUE'],
    ["inactive organization", 'organization."isActive" = TRUE'],
  ])("rejects %s before a hint write", async (_case, requiredSql) => {
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join(" ").includes(requiredSql) ? [] : [activeSite],
    );
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/products/product-a/location-hints",
      payload: { siteId: "site-a", locationId: "shelf", evidence: "ASSIGNED" },
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.productFindFirst).not.toHaveBeenCalled();
    expect(mocks.hintUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("rechecks session authority inside the snapshot transaction before any write", async () => {
    mocks.transactionQueryRaw.mockResolvedValue([]);
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      payload: { siteId: "site-a" },
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.transactionSessionFindFirst).not.toHaveBeenCalled();
    expect(mocks.transactionSessionCreate).not.toHaveBeenCalled();
    expect(mocks.transactionExpectationCreateMany).not.toHaveBeenCalled();
    expect(mocks.transactionVisitCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["active site", (site: { isActive?: boolean }) => site.isActive === true],
    ["active site membership", (site: { memberships?: { some?: { userId?: string; isActive?: boolean } } }) =>
      site.memberships?.some?.userId === "user-a" && site.memberships.some.isActive === true],
    ["active organization", (site: { organization?: { isActive?: boolean } }) =>
      site.organization?.isActive === true],
    ["active organization membership", (site: { organization?: { memberships?: { some?: { userId?: string; isActive?: boolean } } } }) =>
      site.organization?.memberships?.some?.userId === "user-a"
        && site.organization.memberships.some.isActive === true],
  ])("does not reveal a session unless its authorization query requires %s", async (_case, predicate) => {
    mocks.sessionFindFirst.mockImplementation(async (args: { where: { id?: string; site?: Record<string, unknown> } }) =>
      args.where.id === "session-in-site-b" && args.where.site && predicate(args.where.site)
        ? null
        : { id: "session-in-site-b", siteId: "site-b", site: { organizationId: "org-b" } },
    );
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/session-in-site-b/route" });

    expect(response.statusCode).toBe(404);
    expect(mocks.hintFindMany).not.toHaveBeenCalled();
    expect(mocks.hintUpsert).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects session creation without site membership before expectations or visits are written", async () => {
    mocks.siteFindMany.mockResolvedValue([]);
    mocks.ensurePilotSiteForUser.mockResolvedValue(activeSite);
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      payload: { siteId: "site-a" },
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.ensurePilotSiteForUser).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.transactionExpectationCreateMany).not.toHaveBeenCalled();
    expect(mocks.transactionVisitCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not let a global administrator bypass active site membership", async () => {
    mocks.siteFindMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.memberships ? [] : [activeSite],
    );
    const app = await testApp("ADMIN");
    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      payload: { siteId: "site-a" },
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });
});
