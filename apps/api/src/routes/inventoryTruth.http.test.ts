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
  sessionFindUnique: vi.fn(),
  sessionUpdate: vi.fn(),
  expectationFindMany: vi.fn(),
  visitFindMany: vi.fn(),
  entryCount: vi.fn(),
  transaction: vi.fn(),
  transactionQueryRaw: vi.fn(),
  transactionExecuteRaw: vi.fn(),
  transactionSessionFindFirst: vi.fn(),
  transactionSessionCreate: vi.fn(),
  transactionSessionUpdate: vi.fn(),
  transactionInventoryGroupBy: vi.fn(),
  transactionEntryGroupBy: vi.fn(),
  transactionEntryFindFirst: vi.fn(),
  transactionEntryUpdate: vi.fn(),
  transactionHintFindMany: vi.fn(),
  transactionExpectationFindMany: vi.fn(),
  transactionExpectationCreateMany: vi.fn(),
  transactionVisitCount: vi.fn(),
  transactionVisitUpsert: vi.fn(),
  transactionVisitCreateMany: vi.fn(),
  transactionDiscrepancyCount: vi.fn(),
  transactionDiscrepancyDeleteMany: vi.fn(),
  transactionDiscrepancyFindMany: vi.fn(),
  transactionDiscrepancyUpdate: vi.fn(),
  transactionDiscrepancyUpsert: vi.fn(),
  transactionOrganizationMembershipFindFirst: vi.fn(),
  transactionAssignmentCreate: vi.fn(),
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
    storeCountSession: {
      findFirst: mocks.sessionFindFirst,
      findUnique: mocks.sessionFindUnique,
      update: mocks.sessionUpdate,
    },
    storeCountExpectation: { findMany: mocks.expectationFindMany },
    storeCountLocationVisit: { findMany: mocks.visitFindMany },
    storeCountEntry: { count: mocks.entryCount },
    $transaction: mocks.transaction,
  },
}));

import { inventoryTruthRoutes } from "./inventoryTruth.js";
import { storeCountRoutes } from "./storeCount.js";

async function testApp(role = "GENERAL", userId = "user-a") {
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    Object.assign(request, { user: { sub: userId, role, tv: 0 } });
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
  assignedToId: "user-a",
};
const lockedCount = {
  id: "session-a",
  siteId: "site-a",
  organizationId: "org-a",
  status: "ACTIVE",
  startedById: "user-a",
  assignedToId: "user-a",
  organizationRole: "VIEWER",
};
const lockedVisit = {
  ...lockedCount,
  visitStatus: "PENDING",
  completedById: null,
  completedAt: null,
};

function normalizedSql(strings: TemplateStringsArray): string {
  return strings.join(" ").replace(/\s+/g, " ").trim();
}

function countAuthorizationRow(sql: string, role = "MANAGER") {
  if (sql.includes('FROM "User"')) return [{ id: "actor", role: "GENERAL", isActive: true }];
  if (sql.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role }];
  if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
  if (sql.includes('FROM "SiteMembership"')) return [{ siteId: "site-a" }];
  if (sql.includes('FROM "Site"')) return [activeSite];
  return null;
}

function hasExactJoin(sql: string, table: string, alias: string, condition: string): boolean {
  const marker = `INNER JOIN "${table}" AS ${alias} ON `;
  const start = sql.indexOf(marker);
  if (start < 0) return false;
  const conditionStart = start + marker.length;
  const remaining = sql.slice(conditionStart);
  const boundaries = [remaining.indexOf(" INNER JOIN "), remaining.indexOf(" WHERE ")]
    .filter((index) => index >= 0);
  const conditionEnd = boundaries.length > 0 ? Math.min(...boundaries) : remaining.length;
  return remaining.slice(0, conditionEnd) === condition;
}

function hasExactSessionAuthorization(
  strings: TemplateStringsArray,
  values: unknown[],
  expected: { sessionId: string; userId: string; locationId?: string; manager?: boolean },
): boolean {
  const sql = normalizedSql(strings);
  const expectedValues = expected.locationId
    ? [expected.sessionId, expected.locationId, expected.userId, expected.userId]
    : [expected.sessionId, expected.userId, expected.userId];
  return values.join("|") === expectedValues.join("|")
    && hasExactJoin(sql, "Site", "site", 'site."id" = session."siteId"')
    && hasExactJoin(sql, "Organization", "organization", 'organization."id" = site."organizationId"')
    && hasExactJoin(sql, "SiteMembership", "site_membership", 'site_membership."siteId" = site."id"')
    && hasExactJoin(sql, "OrganizationMembership", "organization_membership", 'organization_membership."organizationId" = organization."id"')
    && sql.includes('site_membership."userId" =')
    && sql.includes('organization_membership."userId" =')
    && sql.includes('site_membership."isActive" = TRUE')
    && sql.includes('organization_membership."isActive" = TRUE')
    && sql.includes('site."isActive" = TRUE')
    && sql.includes('organization."isActive" = TRUE')
    && (!expected.locationId || (
      hasExactJoin(sql, "StoreCountLocationVisit", "visit", 'visit."sessionId" = session."id"')
      && hasExactJoin(sql, "StoreLocation", "location", 'location."id" = visit."locationId" AND session."siteId" = location."siteId"')
      && sql.includes('visit."locationId" =')
      && sql.includes('location."isActive" = TRUE')
    ))
    && (!expected.manager || sql.includes('organization_membership."role" IN (\'OWNER\', \'ADMIN\', \'MANAGER\')'));
}

function locksExactSession(strings: TemplateStringsArray, values: unknown[], sessionId: string): boolean {
  const sql = normalizedSql(strings);
  return values[0] === sessionId
    && (
      (sql.includes('session."id" =') && /FOR UPDATE OF session(?:,|$)/.test(sql))
      || (
        sql.includes('FROM "StoreCountSession" WHERE "id" =')
        && /FOR UPDATE$/.test(sql)
      )
    );
}

function hasSharedSessionAccessScope(where: Record<string, unknown>, sessionId: string, userId: string): boolean {
  const branches = Array.isArray(where.OR) ? where.OR as Array<Record<string, unknown>> : [];
  const siteBranch = branches.find((branch) => branch.site) as {
    site?: {
      isActive?: boolean;
      memberships?: { some?: { userId?: string; isActive?: boolean } };
      organization?: {
        isActive?: boolean;
        memberships?: { some?: { userId?: string; isActive?: boolean } };
      };
    };
  } | undefined;
  return where.id === sessionId
    && siteBranch?.site?.isActive === true
    && siteBranch.site.memberships?.some?.userId === userId
    && siteBranch.site.memberships.some.isActive === true
    && siteBranch.site.organization?.isActive === true
    && siteBranch.site.organization.memberships?.some?.userId === userId
    && siteBranch.site.organization.memberships.some.isActive === true;
}

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
      $queryRaw: (parts: TemplateStringsArray, ...values: unknown[]) => parts.join(" ").includes("missing_observation") ? Promise.resolve([]) : mocks.transactionQueryRaw(parts, ...values),
      $executeRaw: mocks.transactionExecuteRaw,
      site: { findFirst: mocks.siteFindFirst },
      product: { findFirst: mocks.productFindFirst },
      storeLocation: { findFirst: mocks.locationFindFirst },
      storeCountSession: {
        findFirst: mocks.transactionSessionFindFirst,
        create: mocks.transactionSessionCreate,
        update: mocks.transactionSessionUpdate,
      },
      inventoryTransaction: { groupBy: mocks.transactionInventoryGroupBy },
      storeCountEntry: {
        groupBy: mocks.transactionEntryGroupBy,
        count: mocks.entryCount,
        findFirst: mocks.transactionEntryFindFirst,
        update: mocks.transactionEntryUpdate,
      },
      productLocationHint: { findMany: mocks.transactionHintFindMany, upsert: mocks.hintUpsert },
      storeCountExpectation: {
        findMany: mocks.transactionExpectationFindMany,
        createMany: mocks.transactionExpectationCreateMany,
      },
      storeCountLocationVisit: {
        count: mocks.transactionVisitCount,
        upsert: mocks.transactionVisitUpsert,
        createMany: mocks.transactionVisitCreateMany,
      },
      storeCountDiscrepancy: {
        count: mocks.transactionDiscrepancyCount,
        deleteMany: mocks.transactionDiscrepancyDeleteMany,
        findMany: mocks.transactionDiscrepancyFindMany,
        update: mocks.transactionDiscrepancyUpdate,
        upsert: mocks.transactionDiscrepancyUpsert,
      },
      organizationMembership: { findFirst: mocks.transactionOrganizationMembershipFindFirst },
      storeCountAssignmentEvent: { create: mocks.transactionAssignmentCreate },
    }));
    mocks.transactionExecuteRaw.mockResolvedValue(1);
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = normalizedSql(strings);
      if (sql.includes('FROM "StoreCountSession"')) return [{ ...lockedCount, startedAt: new Date(0) }];
      if (sql.includes('FROM "User"')) return [{ id: "user-a", role: "GENERAL", isActive: true }];
      if (sql.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role: "MANAGER" }];
      if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
      if (sql.includes('FROM "SiteMembership"')) return [{ siteId: "site-a" }];
      if (sql.includes('FROM "Site"')) return [activeSite];
      return [activeSite];
    });
    mocks.transactionSessionFindFirst.mockResolvedValue(null);
    mocks.transactionSessionCreate.mockResolvedValue(createdSession);
    mocks.transactionSessionUpdate.mockResolvedValue(createdSession);
    mocks.transactionInventoryGroupBy.mockResolvedValue([
      { productId: "product-a", _sum: { quantity: 15 } },
      { productId: "product-b", _sum: { quantity: -2 } },
    ]);
    mocks.transactionHintFindMany.mockResolvedValue([
      { isRequired: true, locationId: "shelf", location: { id: "shelf", sortOrder: 10, code: "A1" } },
      { isRequired: true, locationId: "shelf", location: { id: "shelf", sortOrder: 10, code: "A1" } },
      { isRequired: true, locationId: "back", location: { id: "back", sortOrder: 20, code: "BACK" } },
    ]);
    mocks.transactionExpectationCreateMany.mockResolvedValue({ count: 2 });
    mocks.transactionVisitCreateMany.mockResolvedValue({ count: 2 });
    mocks.transactionVisitCount.mockResolvedValue(1);
    mocks.transactionVisitUpsert.mockResolvedValue({
      id: "visit-shelf",
      sessionId: "session-a",
      locationId: "shelf",
      status: "VERIFIED",
      completedById: "user-a",
      completedAt: new Date("2026-09-15T12:00:00.000Z"),
    });
    mocks.transactionExpectationFindMany.mockResolvedValue([]);
    mocks.transactionEntryGroupBy.mockResolvedValue([]);
    mocks.transactionEntryFindFirst.mockResolvedValue({ id: "entry-a", sessionId: "session-a" });
    mocks.transactionEntryUpdate.mockResolvedValue({ id: "entry-a", sessionId: "session-a", quantity: 2 });
    mocks.transactionDiscrepancyCount.mockResolvedValue(0);
    mocks.transactionDiscrepancyDeleteMany.mockResolvedValue({ count: 0 });
    mocks.transactionDiscrepancyFindMany.mockResolvedValue([]);
    mocks.transactionDiscrepancyUpdate.mockResolvedValue({ id: "discrepancy-a" });
    mocks.transactionDiscrepancyUpsert.mockImplementation(async (args: { create: Record<string, unknown> }) => ({
      id: `discrepancy-${String(args.create.productId)}`,
      status: "OPEN",
      reason: null,
      note: null,
      ...args.create,
    }));
    mocks.transactionOrganizationMembershipFindFirst.mockResolvedValue({ userId: "user-b" });
    mocks.transactionAssignmentCreate.mockResolvedValue({ id: "assignment-event-a" });
    mocks.entryCount.mockResolvedValue(1);
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
    expect(mocks.transactionSessionCreate).toHaveBeenCalledWith({
      data: {
        name: "Cycle count",
        startedById: "user-a",
        assignedToId: "user-a",
        siteId: "site-a",
        cycleCountClass: null,
      },
    });
    expect(mocks.transactionAssignmentCreate).toHaveBeenCalledWith({
      data: {
        sessionId: "session-a",
        fromUserId: null,
        toUserId: "user-a",
        assignedById: "user-a",
      },
    });
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
        location: { siteId: "site-a", isActive: true },
        product: { organizationId: "org-a", isActive: true },
      },
      select: {
        productId: true, evidence: true, isRequired: true,
        product: { select: { id: true, barcodeValue: true, name: true, packageSize: true } },
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

  it("scopes expectations and required-location hints to the requested cycle-count class, and records it on the session", async () => {
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      payload: { siteId: "site-a", cycleCountClass: "A" },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.transactionSessionCreate).toHaveBeenCalledWith({
      data: {
        name: null,
        startedById: "user-a",
        assignedToId: "user-a",
        siteId: "site-a",
        cycleCountClass: "A",
      },
    });
    expect(mocks.transactionInventoryGroupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        organizationId: "org-a",
        siteId: "site-a",
        product: { organizationId: "org-a", cycleCountClass: "A" },
      },
    }));
    expect(mocks.transactionHintFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        organizationId: "org-a",
        siteId: "site-a",
        location: { siteId: "site-a", isActive: true },
        product: { organizationId: "org-a", isActive: true, cycleCountClass: "A" },
      },
    }));
    await app.close();
  });

  it("rejects starting a cycle count for a class another user already has active at the site", async () => {
    mocks.transactionSessionFindFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.OR ? null : { id: "session-other-user", siteId: "site-a", cycleCountClass: "A", status: "ACTIVE" },
    );
    const app = await testApp("GENERAL", "user-b");

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      payload: { siteId: "site-a", cycleCountClass: "A" },
    });

    expect(response.statusCode).toBe(409);
    expect(mocks.transactionSessionCreate).not.toHaveBeenCalled();
    expect(mocks.transactionInventoryGroupBy).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not freeze a full (unscoped) count against an active class-scoped count at the same site", async () => {
    mocks.transactionSessionFindFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.OR ? null : { id: "session-other-user", siteId: "site-a", cycleCountClass: "A", status: "ACTIVE" },
    );
    const app = await testApp("GENERAL", "user-b");

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      payload: { siteId: "site-a" },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.transactionSessionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ cycleCountClass: null }),
    }));
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
    expect(mocks.transactionAssignmentCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("resumes the authorized active session with route progress, snapshots, entries, owner, and history intact", async () => {
    mocks.sessionFindFirst.mockResolvedValue({
      ...createdSession,
      assignedTo: { id: "user-a", name: "Alex" },
      expectations: [{ productId: "product-a", expectedStoreQty: 15 }],
      locationVisits: [{ locationId: "shelf", status: "VERIFIED" }, { locationId: "back", status: "PENDING" }],
      entries: [{ id: "entry-a", locationId: "shelf", quantity: 8 }],
      assignmentEvents: [{ fromUserId: null, toUserId: "user-a", assignedById: "user-a" }],
    });
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/store-count/sessions/active" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "session-a",
      assignedTo: { id: "user-a", name: "Alex" },
      expectations: [{ productId: "product-a", expectedStoreQty: 15 }],
      locationVisits: [{ locationId: "shelf", status: "VERIFIED" }, { locationId: "back", status: "PENDING" }],
      entries: [{ id: "entry-a", locationId: "shelf", quantity: 8 }],
      assignmentEvents: [{ fromUserId: null, toUserId: "user-a" }],
    });
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "ACTIVE", siteId: "site-a", OR: [{ assignedToId: "user-a" }, { assignedToId: null, startedById: "user-a" }] },
      include: expect.objectContaining({
        assignedTo: expect.any(Object),
        expectations: expect.any(Object),
        locationVisits: expect.any(Object),
        entries: expect.any(Object),
        assignmentEvents: expect.any(Object),
      }),
    }));
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns a location-first route with every evidence type and no per-location expected quantity", async () => {
    mocks.sessionFindFirst.mockResolvedValue({
      id: "session-a",
      siteId: "site-a",
      site: { organizationId: "org-a" },
      get routeSnapshot() { return routeSnapshot; },
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
    const routeSnapshot = [
      { productId: "product-a", locationId: "shelf", evidence: "ASSIGNED", product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" }, location: { id: "shelf", code: "A1", sortOrder: 10 } },
      { productId: "product-b", locationId: "shelf", evidence: "ASSIGNED", product: { id: "product-b", barcodeValue: "222", name: "Berry Bar", packageSize: null }, location: { id: "shelf", code: "A1", sortOrder: 10 } },
      { productId: "product-a", locationId: "back", evidence: "PREVIOUSLY_COUNTED", product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" }, location: { id: "back", code: "BACK", sortOrder: 20 } },
      { productId: "product-a", locationId: "stock", evidence: "RECENTLY_STOCKED", product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" }, location: { id: "stock", code: "STK", sortOrder: 25 } },
      { productId: "product-a", locationId: "receiving", evidence: "RECEIVED", product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" }, location: { id: "receiving", code: "RCV", sortOrder: 30 } },
      { productId: "product-a", locationId: "display", evidence: "DISPLAY_COMPONENT", product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" }, location: { id: "display", code: "DSP", sortOrder: 40 } },
    ];
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
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ routeSnapshot: true }) }));
    expect(JSON.stringify(route)).not.toContain("expectedLocationQty");
    await app.close();
  });

  it("includes optional assigned products and auxiliary evidence without adding an optional visit", async () => {
    mocks.sessionFindFirst.mockResolvedValue({
      id: "session-a",
      siteId: "site-a",
      site: { organizationId: "org-a" },
      get routeSnapshot() { return routeSnapshot; },
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
    const routeSnapshot = allHints;
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
      get routeSnapshot() { return routeSnapshot; },
    });
    mocks.expectationFindMany.mockImplementation(async (args: { where: { product?: { organizationId?: string } } }) =>
      args.where.product?.organizationId === "org-a"
        ? [localExpectation]
        : [localExpectation, foreignExpectation],
    );
    mocks.visitFindMany.mockImplementation(async (args: { where: { location?: { siteId?: string; isActive?: boolean } } }) =>
      args.where.location?.siteId === "site-a"
        ? [localVisit]
        : [localVisit, foreignVisit],
    );
    const routeSnapshot = [
      {
        productId: "product-a",
        locationId: "shelf",
        evidence: "ASSIGNED",
        product: { id: "product-a", barcodeValue: "111", name: "Apple Juice", packageSize: "12 oz" },
        location: { id: "shelf", code: "A1", sortOrder: 10 },
      },
    ];
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
      where: { sessionId: "session-a", location: { siteId: "site-a" } },
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
    expect(mocks.transactionQueryRaw).toHaveBeenCalledTimes(5);
    const authorizationSql = mocks.transactionQueryRaw.mock.calls.map(([parts]) => normalizedSql(parts));
    expect(authorizationSql.every((sql) => sql.includes("FOR UPDATE"))).toBe(true);
    expect(authorizationSql).toEqual([
      expect.stringContaining('FROM "Organization"'),
      expect.stringContaining('FROM "User"'),
      expect.stringContaining('FROM "OrganizationMembership"'),
      expect.stringContaining('FROM "Site"'),
      expect.stringContaining('FROM "SiteMembership"'),
    ]);
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

  it("rejects a location assignment from an active member without a manager role", async () => {
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = normalizedSql(strings);
      if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
      if (sql.includes('FROM "User"')) return [{ id: "user-a", role: "GENERAL", isActive: true }];
      if (sql.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role: "VIEWER" }];
      if (sql.includes('FROM "Site"')) return [activeSite];
      if (sql.includes('FROM "SiteMembership"')) return [{ siteId: "site-a" }];
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/products/product-a/location-hints",
      payload: { siteId: "site-a", locationId: "shelf", evidence: "ASSIGNED", isRequired: true },
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.hintUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("locks location-hint authorization in the global relation order", async () => {
    const lockOrder: string[] = [];
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = normalizedSql(strings);
      if (sql.includes('FROM "User"')) {
        lockOrder.push("user");
        return [{ id: "user-a", role: "GENERAL", isActive: true }];
      }
      if (sql.includes('FROM "OrganizationMembership"')) {
        lockOrder.push("organization-membership");
        return [{ organizationId: "org-a", role: "MANAGER" }];
      }
      if (sql.includes('FROM "Organization"')) {
        lockOrder.push("organization");
        return [{ id: "org-a" }];
      }
      if (sql.includes('FROM "SiteMembership"')) {
        lockOrder.push("site-membership");
        return [{ siteId: "site-a" }];
      }
      if (sql.includes('FROM "Site"')) {
        lockOrder.push("site");
        return [activeSite];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/products/product-a/location-hints",
      payload: { siteId: "site-a", locationId: "shelf", evidence: "ASSIGNED", isRequired: true },
    });

    expect(response.statusCode).toBe(201);
    expect(lockOrder).toEqual([
      "organization",
      "user",
      "organization-membership",
      "site",
      "site-membership",
    ]);
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
    ["inactive site membership", 'FROM "SiteMembership"', ["site-a", "user-a"]],
    ["inactive organization membership", 'FROM "OrganizationMembership"', ["org-a", "user-a"]],
    ["inactive site", 'FROM "Site"', ["site-a"]],
    ["inactive organization", 'FROM "Organization"', ["org-a"]],
  ])("rejects %s before a hint write", async (_case, rejectedLayer, expectedValues) => {
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = normalizedSql(strings);
      if (sql.includes(rejectedLayer)) {
        expect(sql).toContain('"isActive" = TRUE');
        expect(values).toEqual(expectedValues);
        return [];
      }
      return countAuthorizationRow(sql) ?? [activeSite];
    });
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

  // ADMIN role users may create a session on any active site within an
  // organization they belong to, without an individual per-site membership
  // record (see resolveAuthorizedSite in storeCount.ts). Org-scoping itself
  // is unconditional there — an ADMIN still cannot reach another org's
  // sites — so this only asserts the site-membership subclause is skipped.
  it("grants a global administrator access to an active site in their organization without requiring individual site membership", async () => {
    mocks.siteFindMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.memberships ? [] : [activeSite],
    );
    const app = await testApp("ADMIN");
    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      payload: { siteId: "site-a" },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.transactionSessionCreate).toHaveBeenCalled();
    await app.close();
  });

  it("keeps every shared session-access organization and site relationship predicate", async () => {
    mocks.sessionFindFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      hasSharedSessionAccessScope(args.where, "session-in-site-b", "user-a")
        ? null
        : { ...createdSession, id: "session-in-site-b", siteId: "site-b" },
    );
    const app = await testApp("ADMIN");

    const response = await app.inject({ method: "GET", url: "/api/store-count/sessions/session-in-site-b" });

    expect(response.statusCode).toBe(404);
    expect(mocks.sessionFindUnique).not.toHaveBeenCalled();
    await app.close();
  });

  it("verifies a required location once with the authenticated actor and time after the offline queue is flushed", async () => {
    mocks.transactionQueryRaw.mockResolvedValue([lockedVisit]);
    mocks.transactionVisitCount.mockResolvedValue(1);
    const completedAt = new Date("2026-09-15T12:00:00.000Z");
    mocks.transactionVisitUpsert.mockResolvedValue({
      id: "visit-shelf",
      sessionId: "session-a",
      locationId: "shelf",
      status: "VERIFIED",
      completedById: "user-a",
      completedAt,
    });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/locations/shelf/verify",
      payload: { offlineQueueFlushed: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      visit: {
        sessionId: "session-a",
        locationId: "shelf",
        status: "VERIFIED",
        completedById: "user-a",
        completedAt: completedAt.toISOString(),
      },
      discrepanciesFinalized: false,
    });
    expect(mocks.transactionVisitUpsert).toHaveBeenCalledWith({
      where: { sessionId_locationId: { sessionId: "session-a", locationId: "shelf" } },
      update: { status: "VERIFIED", completedById: "user-a", completedAt: expect.any(Date) },
      create: {
        sessionId: "session-a",
        locationId: "shelf",
        status: "VERIFIED",
        completedById: "user-a",
        completedAt: expect.any(Date),
      },
    });
    const [authorizationSql, ...authorizationValues] = mocks.transactionQueryRaw.mock.calls.find(([parts]) => (parts as TemplateStringsArray).join(" ").includes('AS visit'))!;
    expect(authorizationSql.join(" ")).toMatch(/FOR UPDATE/);
    expect(authorizationSql.join(" ")).toMatch(/session\."siteId" = location\."siteId"/);
    expect(authorizationSql.join(" ")).toMatch(/SiteMembership/);
    expect(authorizationSql.join(" ")).toMatch(/OrganizationMembership/);
    expect(authorizationValues).toEqual(["session-a", "shelf", "user-a", "user-a"]);
    await app.close();
  });

  it("keeps the first verification actor and time on an idempotent retry", async () => {
    const completedAt = new Date("2026-09-15T12:00:00.000Z");
    const verifiedVisit = {
      id: "visit-shelf",
      sessionId: "session-a",
      locationId: "shelf",
      status: "VERIFIED",
      completedById: "user-a",
      completedAt,
    };
    mocks.transactionQueryRaw.mockResolvedValue([{ ...lockedVisit, visitStatus: "VERIFIED", completedById: "user-a", completedAt }]);
    mocks.transactionVisitUpsert.mockResolvedValue(verifiedVisit);
    const app = await testApp();

    const first = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/locations/shelf/verify",
      payload: { offlineQueueFlushed: true },
    });
    const retry = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/locations/shelf/verify",
      payload: { offlineQueueFlushed: true },
    });

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(first.json().visit).toEqual(retry.json().visit);
    expect(mocks.transactionVisitUpsert).toHaveBeenNthCalledWith(1, expect.objectContaining({ update: {} }));
    expect(mocks.transactionVisitUpsert).toHaveBeenNthCalledWith(2, expect.objectContaining({ update: {} }));
    await app.close();
  });

  it("rejects location verification unless the client explicitly confirms its offline queue is flushed", async () => {
    const app = await testApp();

    const missing = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/locations/shelf/verify",
      payload: {},
    });
    const falseConfirmation = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/locations/shelf/verify",
      payload: { offlineQueueFlushed: false },
    });

    expect(missing.statusCode).toBe(400);
    expect(falseConfirmation.statusCode).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.transactionVisitUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not let a caller from another site verify a visit when any authorization predicate is removed", async () => {
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const fullyScoped = hasExactSessionAuthorization(strings, values, {
        sessionId: "session-in-site-b",
        locationId: "foreign-shelf",
        userId: "user-a",
      });
      return fullyScoped ? [] : [{ ...lockedVisit, id: "session-in-site-b", siteId: "site-b", organizationId: "org-b" }];
    });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-in-site-b/locations/foreign-shelf/verify",
      payload: { offlineQueueFlushed: true },
    });

    expect(response.statusCode).toBe(404);
    expect(mocks.transactionVisitUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["organization", "user", "organization-membership", "site", "site-membership"])("does not expose discrepancies when %s authorization is inactive", async (missing) => {
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = normalizedSql(strings);
      if (sql.includes('FROM "StoreCountSession"')) return [{ ...lockedCount, id: "session-in-site-b", siteId: "site-b", organizationId: "org-b", startedAt: new Date(0) }];
      if (sql.includes('FROM "OrganizationMembership"')) return missing === "organization-membership" ? [] : [{ organizationId: "org-b", role: "MANAGER" }];
      if (sql.includes('FROM "Organization"')) return missing === "organization" ? [] : [{ id: "org-b" }];
      if (sql.includes('FROM "User"')) return missing === "user" ? [] : [{ id: "user-a", role: "GENERAL", isActive: true }];
      if (sql.includes('FROM "SiteMembership"')) return missing === "site-membership" ? [] : [{ siteId: "site-b" }];
      if (sql.includes('FROM "Site"')) return missing === "site" ? [] : [{ id: "site-b", organizationId: "org-b" }];
      return [];
    });
    const app = await testApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/inventory-truth/counts/session-in-site-b/discrepancies",
    });

    expect(response.statusCode).toBe(404);
    expect(mocks.transactionDiscrepancyFindMany).not.toHaveBeenCalled();
    expect(mocks.transactionDiscrepancyUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not expose discrepancies to an inactive user with still-active memberships", async () => {
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = normalizedSql(strings);
      if (sql.includes('FROM "StoreCountSession"')) return [{ ...lockedCount, startedAt: new Date(0) }];
      if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
      if (sql.includes('FROM "User"')) return [];
      throw new Error(`authorization continued after inactive actor: ${sql}`);
    });
    const app = await testApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/inventory-truth/counts/session-a/discrepancies",
    });

    expect(response.statusCode).toBe(404);
    expect(mocks.transactionDiscrepancyFindMany).not.toHaveBeenCalled();
    expect(mocks.transactionDiscrepancyUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("holds the complete discrepancy authorization scope in the established lock order", async () => {
    const lockOrder: string[] = [];
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = normalizedSql(strings);
      if (sql.includes('FROM "StoreCountSession"')) { lockOrder.push("session"); return [{ ...lockedCount, startedAt: new Date(0) }]; }
      if (sql.includes('FROM "OrganizationMembership"')) { lockOrder.push("organization-membership"); return [{ organizationId: "org-a", role: "MANAGER" }]; }
      if (sql.includes('FROM "Organization"')) { lockOrder.push("organization"); return [{ id: "org-a" }]; }
      if (sql.includes('FROM "User"')) { lockOrder.push("user"); return [{ id: "user-a", role: "GENERAL", isActive: true }]; }
      if (sql.includes('FROM "SiteMembership"')) { lockOrder.push("site-membership"); return [{ siteId: "site-a" }]; }
      if (sql.includes('FROM "Site"')) { lockOrder.push("site"); return [activeSite]; }
      return [];
    });
    mocks.transactionVisitCount.mockResolvedValue(1);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/session-a/discrepancies" });

    expect(response.statusCode).toBe(200);
    expect(lockOrder).toEqual(["session", "organization", "user", "organization-membership", "site", "site-membership"]);
    await app.close();
  });

  it("does not finalize discrepancies while any required location remains unverified", async () => {
    mocks.transactionQueryRaw.mockResolvedValue([lockedCount]);
    mocks.transactionVisitCount.mockResolvedValue(1);
    const app = await testApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/inventory-truth/counts/session-a/discrepancies",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ finalized: false, discrepancies: [] });
    expect(mocks.transactionExpectationFindMany).not.toHaveBeenCalled();
    expect(mocks.transactionEntryGroupBy).not.toHaveBeenCalled();
    expect(mocks.transactionDiscrepancyUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects verification after completion without changing the recorded visit", async () => {
    mocks.transactionQueryRaw.mockResolvedValue([{ ...lockedVisit, status: "COMPLETED" }]);
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/locations/shelf/verify",
      payload: { offlineQueueFlushed: true },
    });

    expect(response.statusCode).toBe(409);
    expect(mocks.transactionVisitUpsert).not.toHaveBeenCalled();
    expect(mocks.transactionDiscrepancyUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns completed discrepancies as finalized without recalculating or mutating them", async () => {
    const recorded = {
      id: "discrepancy-a",
      sessionId: "session-a",
      productId: "short-product",
      expectedStoreQty: 10,
      actualStoreQty: 7,
      difference: -3,
      status: "OPEN",
      reason: "COULD_NOT_FIND",
      note: null,
    };
    mocks.transactionQueryRaw.mockResolvedValue([{ ...lockedCount, status: "COMPLETED", organizationRole: "MANAGER" }]);
    mocks.transactionDiscrepancyFindMany.mockResolvedValue([recorded]);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/session-a/discrepancies" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ finalized: true, discrepancies: [recorded] });
    expect(mocks.transactionVisitCount).not.toHaveBeenCalled();
    expect(mocks.transactionDiscrepancyUpdate).not.toHaveBeenCalled();
    expect(mocks.transactionDiscrepancyUpsert).not.toHaveBeenCalled();
    expect(mocks.transactionDiscrepancyDeleteMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports a cancelled count with unverified locations as unfinished without recalculating it", async () => {
    mocks.transactionQueryRaw.mockResolvedValue([{ ...lockedCount, status: "CANCELLED" }]);
    mocks.transactionVisitCount.mockResolvedValue(1);
    mocks.transactionDiscrepancyFindMany.mockResolvedValue([]);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/session-a/discrepancies" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ finalized: false, discrepancies: [] });
    expect(mocks.transactionVisitCount).toHaveBeenCalledWith({
      where: {
        sessionId: "session-a",
        status: { not: "VERIFIED" },
        location: { siteId: "site-a" },
      },
    });
    expect(mocks.transactionExpectationFindMany).not.toHaveBeenCalled();
    expect(mocks.transactionEntryGroupBy).not.toHaveBeenCalled();
    expect(mocks.transactionDiscrepancyUpdate).not.toHaveBeenCalled();
    expect(mocks.transactionDiscrepancyUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("preserves discrepancy identity and explanation while resolving and reopening the same row", async () => {
    mocks.transactionQueryRaw.mockResolvedValue([lockedCount]);
    mocks.transactionVisitCount.mockResolvedValue(0);
    mocks.transactionExpectationFindMany.mockResolvedValue([{ productId: "short-product", expectedStoreQty: 10 }]);
    let actualStoreQty = 7;
    mocks.transactionEntryGroupBy.mockImplementation(async (args: { where: Record<string, unknown>; by: string[] }) => {
      expect(args.by).toEqual(["productId"]);
      expect(args.where).toEqual({
        sessionId: "session-a",
        productId: { not: null },
        location: { siteId: "site-a" },
        product: { organizationId: "org-a" },
      });
      return [{ productId: "short-product", _sum: { quantity: actualStoreQty } }];
    });
    const discrepancyRows = new Map<string, Record<string, unknown>>();
    let nextId = 1;
    mocks.transactionDiscrepancyUpsert.mockImplementation(async (args: { where: { sessionId_productId: { productId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const productId = args.where.sessionId_productId.productId;
      const row = discrepancyRows.get(productId)
        ? { ...discrepancyRows.get(productId), ...args.update }
        : { id: `discrepancy-${nextId++}`, status: "OPEN", reason: null, note: null, ...args.create };
      discrepancyRows.set(productId, row);
      return row;
    });
    mocks.transactionDiscrepancyUpdate.mockImplementation(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const entry = [...discrepancyRows.entries()].find(([, row]) => row.id === args.where.id);
      if (!entry) throw new Error("missing discrepancy fixture");
      const [productId, row] = entry;
      const updated = { ...row, ...args.data };
      discrepancyRows.set(productId, updated);
      return updated;
    });
    mocks.transactionDiscrepancyDeleteMany.mockImplementation(async () => {
      discrepancyRows.clear();
      return { count: 1 };
    });
    mocks.transactionDiscrepancyFindMany.mockImplementation(async () => [...discrepancyRows.values()]);
    const app = await testApp();

    const shortage = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/session-a/discrepancies" });
    const originalId = shortage.json().discrepancies[0].id;
    discrepancyRows.set("short-product", {
      ...discrepancyRows.get("short-product"),
      reason: "COULD_NOT_FIND",
      note: "Checked shelf, display, and backstock",
    });
    actualStoreQty = 2 + 3 + 5;
    const resolved = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/session-a/discrepancies" });
    actualStoreQty = 8;
    const reopened = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/session-a/discrepancies" });

    expect(shortage.statusCode).toBe(200);
    expect(shortage.json().discrepancies[0]).toMatchObject({
      id: originalId,
      productId: "short-product",
      expectedStoreQty: 10,
      actualStoreQty: 7,
      difference: -3,
      status: "OPEN",
    });
    expect(resolved.json().discrepancies[0]).toMatchObject({
      id: originalId,
      actualStoreQty: 10,
      difference: 0,
      status: "RESOLVED",
      reason: "COULD_NOT_FIND",
      note: "Checked shelf, display, and backstock",
    });
    expect(reopened.json().discrepancies[0]).toMatchObject({
      id: originalId,
      actualStoreQty: 8,
      difference: -2,
      status: "OPEN",
      reason: "COULD_NOT_FIND",
      note: "Checked shelf, display, and backstock",
    });
    expect(mocks.transactionDiscrepancyDeleteMany).not.toHaveBeenCalled();
    expect(discrepancyRows.size).toBe(1);
    await app.close();
  });

  it.each(["APPROVED", "REJECTED"])("does not reopen or rewrite a manager-%s discrepancy", async (status) => {
    const reviewed = {
      id: "discrepancy-reviewed",
      sessionId: "session-a",
      productId: "short-product",
      expectedStoreQty: 10,
      actualStoreQty: 7,
      difference: -3,
      status,
      reason: "COULD_NOT_FIND",
      note: "Manager reviewed",
      reviewedById: "manager-a",
    };
    mocks.transactionQueryRaw.mockResolvedValue([lockedCount]);
    mocks.transactionVisitCount.mockResolvedValue(0);
    mocks.transactionExpectationFindMany.mockResolvedValue([{ productId: "short-product", expectedStoreQty: 10 }]);
    mocks.transactionEntryGroupBy.mockResolvedValue([{ productId: "short-product", _sum: { quantity: 8 } }]);
    mocks.transactionDiscrepancyFindMany.mockResolvedValue([reviewed]);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/inventory-truth/counts/session-a/discrepancies" });

    expect(response.statusCode).toBe(200);
    expect(response.json().discrepancies).toEqual([reviewed]);
    expect(mocks.transactionDiscrepancyUpdate).not.toHaveBeenCalled();
    expect(mocks.transactionDiscrepancyUpsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("blocks completion until required locations are verified", async () => {
    mocks.sessionFindFirst.mockResolvedValue(createdSession);
    mocks.transactionQueryRaw.mockResolvedValue([lockedCount]);
    mocks.transactionVisitCount.mockResolvedValue(1);
    const app = await testApp();

    const response = await app.inject({ method: "POST", url: "/api/store-count/sessions/session-a/complete" });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/location/i);
    expect(mocks.transactionSessionUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it("blocks completion when a finalized discrepancy lacks an employee explanation", async () => {
    mocks.sessionFindFirst.mockResolvedValue(createdSession);
    mocks.transactionQueryRaw.mockResolvedValue([lockedCount]);
    mocks.transactionVisitCount.mockResolvedValue(0);
    mocks.transactionExpectationFindMany.mockResolvedValue([{ productId: "short-product", expectedStoreQty: 10 }]);
    mocks.transactionEntryGroupBy.mockResolvedValue([{ productId: "short-product", _sum: { quantity: 7 } }]);
    mocks.transactionDiscrepancyCount.mockResolvedValue(1);
    const app = await testApp();

    const response = await app.inject({ method: "POST", url: "/api/store-count/sessions/session-a/complete" });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/explanation/i);
    expect(mocks.transactionDiscrepancyCount).toHaveBeenCalledWith({
      where: {
        sessionId: "session-a",
        status: "OPEN",
        reason: null,
        product: { organizationId: "org-a" },
      },
    });
    expect(mocks.transactionSessionUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it("completes when every open discrepancy has an employee explanation", async () => {
    const explainedOpenDiscrepancy = {
      id: "discrepancy-explained",
      sessionId: "session-a",
      productId: "short-product",
      expectedStoreQty: 10,
      actualStoreQty: 7,
      difference: -3,
      status: "OPEN",
      reason: "COULD_NOT_FIND",
      note: "Checked shelf, display, and backstock",
      reviewedById: null,
      reviewedAt: null,
      createdAt: new Date("2026-09-15T10:00:00.000Z"),
      updatedAt: new Date("2026-09-15T10:05:00.000Z"),
    };
    mocks.sessionFindFirst.mockResolvedValue(createdSession);
    mocks.transactionQueryRaw.mockResolvedValue([lockedCount]);
    mocks.transactionVisitCount.mockResolvedValue(0);
    mocks.transactionExpectationFindMany.mockResolvedValue([{ productId: "short-product", expectedStoreQty: 10 }]);
    mocks.transactionEntryGroupBy.mockResolvedValue([{ productId: "short-product", _sum: { quantity: 7 } }]);
    mocks.transactionDiscrepancyFindMany.mockResolvedValue([explainedOpenDiscrepancy]);
    mocks.transactionDiscrepancyCount.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      const where = args.where;
      const product = where.product as { organizationId?: string } | undefined;
      const selectsOnlyUnexplainedOpen = where.sessionId === "session-a"
        && where.status === "OPEN"
        && where.reason === null
        && product?.organizationId === "org-a";
      return selectsOnlyUnexplainedOpen ? 0 : 1;
    });
    mocks.transactionSessionUpdate.mockResolvedValue({
      ...createdSession,
      status: "COMPLETED",
      completedAt: new Date("2026-09-15T11:00:00.000Z"),
    });
    const app = await testApp();

    const response = await app.inject({ method: "POST", url: "/api/store-count/sessions/session-a/complete" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "session-a", status: "COMPLETED" });
    expect(mocks.transactionSessionUpdate).toHaveBeenCalledWith({
      where: { id: "session-a", siteId: "site-a" },
      data: { status: "COMPLETED", completedAt: expect.any(Date) },
    });
    await app.close();
  });

  it("creates for A, reassigns to B, and lets B complete without granting the former assignee ownership", async () => {
    let session: Record<string, unknown> | null = null;
    const events: Array<{ fromUserId: string | null; toUserId: string }> = [];
    mocks.sessionFindFirst.mockImplementation(async () => session);
    mocks.transaction.mockImplementation(async (work: (tx: Record<string, unknown>) => unknown) => {
      const tx = {
        $executeRaw: vi.fn(async () => 1),
        $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
          const sql = normalizedSql(strings);
          if (sql.includes("missing_observation")) return [];
          if (sql.includes('FROM "User"')) return [{ id: "actor", role: "GENERAL", isActive: true }];
          if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
          if (sql.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role: "MANAGER" }];
          if (sql.includes('FROM "SiteMembership"')) return [{ siteId: "site-a" }];
          if (sql.includes('FROM "Site"')) return [{ id: "site-a", organizationId: "org-a" }];
          if (!sql.includes('FROM "StoreCountSession" AS session')) return [activeSite];
          return [{
            ...lockedCount,
            ...session,
            organizationId: "org-a",
            organizationRole: "MANAGER",
          }];
        }),
        site: { findFirst: vi.fn(async () => ({ id: "site-a", organizationId: "org-a" })) },
        storeCountSession: {
          findFirst: vi.fn(async () => null),
          create: vi.fn(async (args: { data: Record<string, unknown> }) => {
            session = { ...createdSession, ...args.data };
            return session;
          }),
          update: vi.fn(async (args: { data: Record<string, unknown> }) => {
            session = { ...session, ...args.data };
            return session;
          }),
        },
        inventoryTransaction: { groupBy: vi.fn(async () => []) },
        productLocationHint: { findMany: vi.fn(async () => []) },
        storeCountExpectation: { createMany: vi.fn(async () => ({ count: 0 })), findMany: vi.fn(async () => []) },
        storeCountLocationVisit: { createMany: vi.fn(async () => ({ count: 0 })), count: vi.fn(async () => 0) },
        storeCountEntry: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 1) },
        storeCountDiscrepancy: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
        organizationMembership: {
          findFirst: vi.fn(async (args: { where: { userId: string } }) => ({ userId: args.where.userId })),
        },
        storeCountAssignmentEvent: {
          create: vi.fn(async (args: { data: { fromUserId: string | null; toUserId: string } }) => {
            events.push({ fromUserId: args.data.fromUserId, toUserId: args.data.toUserId });
            return args.data;
          }),
        },
      };
      return work(tx);
    });
    const starterApp = await testApp("GENERAL", "user-a");
    const managerApp = await testApp("GENERAL", "manager-a");
    const assigneeApp = await testApp("GENERAL", "user-b");

    const created = await starterApp.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      payload: { siteId: "site-a" },
    });
    const reassigned = await managerApp.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/reassign",
      payload: { toUserId: "user-b", reason: "Shift change" },
    });
    const completed = await assigneeApp.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/complete",
    });

    expect(created.statusCode).toBe(201);
    expect(reassigned.statusCode).toBe(200);
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ status: "COMPLETED", assignedToId: "user-b" });
    expect(events).toEqual([
      { fromUserId: null, toUserId: "user-a" },
      { fromUserId: "user-a", toUserId: "user-b" },
    ]);
    await starterApp.close();
    await managerApp.close();
    await assigneeApp.close();
  });

  it.each([
    ["organization manager", "GENERAL", "MANAGER"],
    ["platform administrator with site access", "ADMIN", "VIEWER"],
  ])("requires reassignment before an active scoped %s can complete another employee count", async (_case, platformRole, organizationRole) => {
    mocks.sessionFindFirst.mockResolvedValue({ ...createdSession, assignedToId: "user-b" });
    mocks.transactionQueryRaw.mockResolvedValue([{
      ...lockedCount,
      assignedToId: "user-b",
      organizationRole,
    }]);
    mocks.transactionVisitCount.mockResolvedValue(0);
    mocks.transactionDiscrepancyCount.mockResolvedValue(0);
    mocks.transactionSessionUpdate.mockResolvedValue({ ...createdSession, status: "COMPLETED" });
    const app = await testApp(platformRole, "manager-a");

    const response = await app.inject({ method: "POST", url: "/api/store-count/sessions/session-a/complete" });

    expect(response.statusCode).toBe(403);
    expect(mocks.transactionSessionUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it("preserves starter completion for a legacy site-less session with no assignee", async () => {
    const legacy = {
      ...createdSession,
      id: "legacy-session",
      siteId: null,
      assignedToId: null,
      startedById: "user-a",
    };
    mocks.sessionFindFirst.mockResolvedValue(legacy);
    mocks.transactionQueryRaw.mockResolvedValue([{
      status: "ACTIVE",
      assignedToId: null,
      startedById: "user-a",
    }]);
    mocks.transactionSessionUpdate.mockResolvedValue({ ...legacy, status: "COMPLETED" });
    const app = await testApp();

    const response = await app.inject({ method: "POST", url: "/api/store-count/sessions/legacy-session/complete" });

    expect(response.statusCode).toBe(200);
    expect(mocks.transactionSessionUpdate).toHaveBeenCalledWith({
      where: { id: "legacy-session", siteId: null },
      data: { status: "COMPLETED", completedAt: expect.any(Date) },
    });
    await app.close();
  });

  it("rechecks a legacy starter's active status after locking completion", async () => {
    mocks.sessionFindFirst.mockResolvedValue({ ...createdSession, siteId: null, assignedToId: null });
    mocks.transactionQueryRaw.mockImplementation(async (parts: TemplateStringsArray) =>
      parts.join(" ").includes('FROM "User"') ? [] : [{ ...lockedCount, siteId: null, assignedToId: null }]);
    const app = await testApp();
    expect((await app.inject({ method: "POST", url: "/api/store-count/sessions/session-a/complete" })).statusCode).toBe(403);
    expect(mocks.transactionSessionUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires the legacy starter even for a platform administrator", async () => {
    const legacy = {
      ...createdSession,
      id: "legacy-session",
      siteId: null,
      assignedToId: null,
      startedById: "former-user",
    };
    mocks.sessionFindFirst.mockImplementation(async (args: { where: { OR?: Array<Record<string, unknown>> } }) => {
      const legacyBranch = args.where.OR?.find((branch) => branch.siteId === null);
      return legacyBranch && !("startedById" in legacyBranch) ? legacy : null;
    });
    mocks.transactionQueryRaw.mockResolvedValue([{
      status: "ACTIVE",
      assignedToId: null,
      startedById: "former-user",
    }]);
    mocks.transactionSessionUpdate.mockResolvedValue({ ...legacy, status: "COMPLETED" });
    const app = await testApp("ADMIN", "admin-a");

    const response = await app.inject({ method: "POST", url: "/api/store-count/sessions/legacy-session/complete" });

    expect(response.statusCode).toBe(403);
    expect(mocks.transactionSessionUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it("serializes concurrent completion so exactly one request completes the session", async () => {
    mocks.sessionFindFirst.mockResolvedValue({ ...createdSession, assignedToId: "user-b" });
    let status = "ACTIVE";
    let writes = 0;
    let lockTail = Promise.resolve();
    mocks.transaction.mockImplementation(async (work: (tx: Record<string, unknown>) => unknown) => {
      let releaseLock: (() => void) | undefined;
      const tx = {
        $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join(" ").includes("missing_observation")) return [];
          if (releaseLock && strings.join(" ").includes('FROM "StoreCountSession"')) return [{ ...lockedCount, status, assignedToId: "user-b", organizationRole: "MANAGER" }];
          if (locksExactSession(strings, values, "session-a")) {
            const prior = lockTail;
            lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
            await prior;
            return [{ ...lockedCount, status, assignedToId: "user-b" }];
          }
          const access = countAuthorizationRow(normalizedSql(strings));
          if (access) return access;
          return [{ ...lockedCount, status, assignedToId: "user-b" }];
        }),
        storeCountLocationVisit: { count: vi.fn(async () => 0) },
        storeCountExpectation: { findMany: vi.fn(async () => []) },
        storeCountEntry: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 1) },
        storeCountDiscrepancy: {
          findMany: vi.fn(async () => []),
          count: vi.fn(async () => 0),
        },
        storeCountSession: {
          update: vi.fn(async () => {
            writes += 1;
            status = "COMPLETED";
            return { ...createdSession, assignedToId: "user-b", status };
          }),
        },
      };
      try {
        return await work(tx);
      } finally {
        releaseLock?.();
      }
    });
    const app = await testApp("GENERAL", "user-b");

    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/api/store-count/sessions/session-a/complete" }),
      app.inject({ method: "POST", url: "/api/store-count/sessions/session-a/complete" }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(writes).toBe(1);
    expect(status).toBe("COMPLETED");
    await app.close();
  });

  it("serializes completion against count-entry mutation so completed sessions remain immutable", async () => {
    mocks.sessionFindFirst.mockResolvedValue(createdSession);
    let status = "ACTIVE";
    let completionWrites = 0;
    let entryWrites = 0;
    let lockTail = Promise.resolve();
    mocks.transaction.mockImplementation(async (work: (tx: Record<string, unknown>) => unknown) => {
      let releaseLock: (() => void) | undefined;
      const tx = {
        $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join(" ").includes("missing_observation")) return [];
          if (releaseLock && strings.join(" ").includes('FROM "StoreCountSession"')) return [{ ...lockedCount, status, organizationRole: "MANAGER" }];
          if (locksExactSession(strings, values, "session-a")) {
            const prior = lockTail;
            lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
            await prior;
            return [{ ...lockedCount, status }];
          }
          const access = countAuthorizationRow(normalizedSql(strings));
          if (access) return access;
          return [{ ...lockedCount, status }];
        }),
        storeCountLocationVisit: { count: vi.fn(async () => 0) },
        storeCountExpectation: { findMany: vi.fn(async () => []) },
        storeCountEntry: {
          groupBy: vi.fn(async () => []),
          count: vi.fn(async () => 1),
          findFirst: vi.fn(async () => ({ id: "entry-a", sessionId: "session-a" })),
          update: vi.fn(async () => {
            entryWrites += 1;
            return { id: "entry-a", sessionId: "session-a", quantity: 2 };
          }),
        },
        storeCountDiscrepancy: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
        storeCountSession: {
          update: vi.fn(async () => {
            completionWrites += 1;
            status = "COMPLETED";
            return { ...createdSession, status };
          }),
        },
      };
      try {
        return await work(tx);
      } finally {
        releaseLock?.();
      }
    });
    const app = await testApp();

    const [complete, patch] = await Promise.all([
      app.inject({ method: "POST", url: "/api/store-count/sessions/session-a/complete" }),
      app.inject({
        method: "PATCH",
        url: "/api/store-count/sessions/session-a/entries/entry-a",
        payload: { quantity: 2, expectedQuantity: 1 },
      }),
    ]);

    expect(complete.statusCode).toBe(200);
    expect(patch.statusCode).toBe(409);
    expect(completionWrites).toBe(1);
    expect(entryWrites).toBe(0);
    await app.close();
  });

  it("reassigns an active count atomically for a scoped organization manager without changing progress", async () => {
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const access = countAuthorizationRow(normalizedSql(strings));
      return access ?? [{ ...lockedCount, organizationRole: "MANAGER" }];
    });
    mocks.transactionOrganizationMembershipFindFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      expect(args.where).toEqual({
        organizationId: "org-a",
        userId: "user-b",
        isActive: true,
        user: { isActive: true, siteMemberships: { some: { siteId: "site-a", isActive: true } } },
      });
      return { userId: "user-b" };
    });
    mocks.transactionSessionUpdate.mockResolvedValue({ ...createdSession, assignedToId: "user-b" });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/reassign",
      payload: { toUserId: "user-b", reason: "Shift ended" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().assignedToId).toBe("user-b");
    const [authorizationSql, ...authorizationValues] = mocks.transactionQueryRaw.mock.calls.find(([parts]) => (parts as TemplateStringsArray).join(" ").includes('organization_membership."role" IN'))!;
    expect(authorizationSql.join(" ")).toMatch(/organization_membership\."role" IN \('OWNER', 'ADMIN', 'MANAGER'\)/);
    expect(authorizationSql.join(" ")).toMatch(/SiteMembership/);
    expect(authorizationSql.join(" ")).toMatch(/FOR UPDATE/);
    expect(authorizationValues).toEqual(["session-a", "user-a", "user-a"]);
    expect(mocks.transactionSessionUpdate).toHaveBeenCalledWith({
      where: { id: "session-a", siteId: "site-a" },
      data: { assignedToId: "user-b" },
    });
    expect(mocks.transactionAssignmentCreate).toHaveBeenCalledWith({
      data: {
        sessionId: "session-a",
        fromUserId: "user-a",
        toUserId: "user-b",
        assignedById: "user-a",
        reason: "Shift ended",
      },
    });
    expect(mocks.transactionExpectationCreateMany).not.toHaveBeenCalled();
    expect(mocks.transactionVisitCreateMany).not.toHaveBeenCalled();
    expect(mocks.entryCount).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects reassignment when the manager scope query lacks any organization or site boundary", async () => {
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const fullyScoped = hasExactSessionAuthorization(strings, values, {
        sessionId: "session-a",
        userId: "user-a",
        manager: true,
      });
      return fullyScoped ? [] : [lockedCount];
    });
    const app = await testApp("ADMIN");

    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/reassign",
      payload: { toUserId: "user-b" },
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.transactionOrganizationMembershipFindFirst).not.toHaveBeenCalled();
    expect(mocks.transactionSessionUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["cross-tenant", (where: Record<string, unknown>) => where.organizationId === "org-a"],
    ["cross-site", (where: Record<string, unknown>) => JSON.stringify(where).includes('"siteId":"site-a"')],
  ])("rejects a %s reassignment recipient only when the recipient query keeps its scope", async (_case, hasScope) => {
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const access = countAuthorizationRow(normalizedSql(strings));
      return access ?? [{ ...lockedCount, organizationRole: "MANAGER" }];
    });
    mocks.transactionOrganizationMembershipFindFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      hasScope(args.where) ? null : { userId: "foreign-user" },
    );
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/reassign",
      payload: { toUserId: "foreign-user" },
    });

    expect(response.statusCode).toBe(404);
    expect(mocks.transactionSessionUpdate).not.toHaveBeenCalled();
    expect(mocks.transactionAssignmentCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects completed-session reassignment and reasons over 500 characters", async () => {
    const app = await testApp();
    const oversized = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/reassign",
      payload: { toUserId: "user-b", reason: "x".repeat(501) },
    });
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const access = countAuthorizationRow(normalizedSql(strings));
      return access ?? [{ ...lockedCount, status: "COMPLETED", organizationRole: "MANAGER" }];
    });
    const completed = await app.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/reassign",
      payload: { toUserId: "user-b" },
    });

    expect(oversized.statusCode).toBe(400);
    expect(completed.statusCode).toBe(409);
    expect(mocks.transactionSessionUpdate).not.toHaveBeenCalled();
    expect(mocks.transactionAssignmentCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("serializes two concurrent reassignments into a reconstructable ownership history", async () => {
    let assignedToId = "user-a";
    let lockTail = Promise.resolve();
    const events: Array<{ fromUserId: string | null; toUserId: string }> = [];
    mocks.transaction.mockImplementation(async (work: (tx: Record<string, unknown>) => unknown) => {
      let releaseLock: (() => void) | undefined;
      const tx = {
        $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join(" ").includes("missing_observation")) return [];
          if (releaseLock && strings.join(" ").includes('FROM "StoreCountSession"')) return [{ ...lockedCount, assignedToId, organizationRole: "MANAGER" }];
          if (locksExactSession(strings, values, "session-a")) {
            const prior = lockTail;
            lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
            await prior;
            return [{ ...lockedCount, assignedToId }];
          }
          const access = countAuthorizationRow(normalizedSql(strings));
          if (access) return access;
          return [{ ...lockedCount, assignedToId }];
        }),
        organizationMembership: {
          findFirst: vi.fn(async (args: { where: { userId: string } }) => ({ userId: args.where.userId })),
        },
        storeCountSession: {
          update: vi.fn(async (args: { data: { assignedToId: string } }) => {
            assignedToId = args.data.assignedToId;
            return { ...createdSession, assignedToId };
          }),
        },
        storeCountAssignmentEvent: {
          create: vi.fn(async (args: { data: { fromUserId: string | null; toUserId: string } }) => {
            events.push({ fromUserId: args.data.fromUserId, toUserId: args.data.toUserId });
            return args.data;
          }),
        },
      };
      try {
        return await work(tx);
      } finally {
        releaseLock?.();
      }
    });
    const app = await testApp();

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/api/inventory-truth/counts/session-a/reassign", payload: { toUserId: "user-b" } }),
      app.inject({ method: "POST", url: "/api/inventory-truth/counts/session-a/reassign", payload: { toUserId: "user-c" } }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(assignedToId).toBe("user-c");
    expect(events).toEqual([
      { fromUserId: "user-a", toUserId: "user-b" },
      { fromUserId: "user-b", toUserId: "user-c" },
    ]);
    await app.close();
  });

  it("serializes reassignment against completion and rejects the former assignee after the handoff", async () => {
    let assignedToId = "user-a";
    let status = "ACTIVE";
    let lockTail = Promise.resolve();
    const events: Array<{ fromUserId: string | null; toUserId: string }> = [];
    let completionWrites = 0;
    let signalReassignLockAttempt!: () => void;
    const reassignLockAttempted = new Promise<void>((resolve) => { signalReassignLockAttempt = resolve; });
    mocks.sessionFindFirst.mockResolvedValue(createdSession);
    mocks.transaction.mockImplementation(async (work: (tx: Record<string, unknown>) => unknown) => {
      let releaseLock: (() => void) | undefined;
      const tx = {
        $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join(" ").includes("missing_observation")) return [];
          if (releaseLock && strings.join(" ").includes('FROM "StoreCountSession"')) return [{ ...lockedCount, assignedToId, status, organizationRole: "MANAGER" }];
          if (locksExactSession(strings, values, "session-a")) {
            const prior = lockTail;
            lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
            await prior;
            signalReassignLockAttempt();
            return [{ ...lockedCount, assignedToId, status }];
          }
          const access = countAuthorizationRow(normalizedSql(strings));
          if (access) return access;
          return [{ ...lockedCount, assignedToId, status }];
        }),
        organizationMembership: {
          findFirst: vi.fn(async (args: { where: { userId: string } }) => ({ userId: args.where.userId })),
        },
        storeCountLocationVisit: { count: vi.fn(async () => 0) },
        storeCountExpectation: { findMany: vi.fn(async () => []) },
        storeCountEntry: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 1) },
        storeCountDiscrepancy: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
        storeCountSession: {
          update: vi.fn(async (args: { data: { assignedToId?: string; status?: string } }) => {
            if (args.data.assignedToId) assignedToId = args.data.assignedToId;
            if (args.data.status) {
              completionWrites += 1;
              status = args.data.status;
            }
            return { ...createdSession, assignedToId, status };
          }),
        },
        storeCountAssignmentEvent: {
          create: vi.fn(async (args: { data: { fromUserId: string | null; toUserId: string } }) => {
            events.push({ fromUserId: args.data.fromUserId, toUserId: args.data.toUserId });
            return args.data;
          }),
        },
      };
      try {
        return await work(tx);
      } finally {
        releaseLock?.();
      }
    });
    const managerApp = await testApp("GENERAL", "manager-a");
    const starterApp = await testApp("GENERAL", "user-a");

    const reassignPromise = managerApp.inject({
      method: "POST",
      url: "/api/inventory-truth/counts/session-a/reassign",
      payload: { toUserId: "user-b" },
    });
    await reassignLockAttempted;
    const completePromise = starterApp.inject({ method: "POST", url: "/api/store-count/sessions/session-a/complete" });
    const [reassign, complete] = await Promise.all([reassignPromise, completePromise]);

    expect(reassign.statusCode).toBe(200);
    expect(complete.statusCode).toBe(403);
    expect(assignedToId).toBe("user-b");
    expect(status).toBe("ACTIVE");
    expect(completionWrites).toBe(0);
    expect(events).toEqual([{ fromUserId: "user-a", toUserId: "user-b" }]);
    await managerApp.close();
    await starterApp.close();
  });
});
