import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../lib/prisma.js", () => ({ prisma: { $transaction: mock.transaction } }));
import { inventoryTruthRoutes } from "./inventoryTruth.js";

const reasons = ["COULD_NOT_FIND", "WRONG_SHELF_OR_LOCATION", "RECEIVING_PROBLEM", "STOCKING_PROBLEM", "SALE_NOT_RECORDED", "DAMAGE_OR_EXPIRATION", "EMPTY_PACKAGE_POSSIBLE_THEFT", "PRODUCT_OR_PACKAGE_CHANGED", "OTHER_MANAGER_REVIEW"];
let session: { id: string; siteId: string; organizationId: string; status: string; assignedToId: string | null; startedById?: string; organizationRole: string };
let discrepancy: Record<string, unknown>;
let ledger: Array<Record<string, unknown>>;
let events: string[];
let authorized: boolean;
let unverified: number;
let actual: number;
let failUpdate: boolean;
let inactivePredicate: string | null;
let discrepancyOrganization: string;
let missingObservation: boolean;

async function appFor(userId = "employee") {
  const app = Fastify();
  app.decorate("authenticate", async (req) => { Object.assign(req, { user: { sub: userId, role: "ADMIN", tv: 0 } }); });
  await app.register(inventoryTruthRoutes, { prefix: "/api/inventory-truth" });
  return app;
}
const root = "/api/inventory-truth/counts/count";
async function request(method: "GET" | "PATCH" | "POST", path: string, payload?: object, user = "employee") {
  const app = await appFor(user);
  try { return await app.inject({ method, url: root + path, payload }); } finally { await app.close(); }
}
async function token() {
  const response = await request("GET", "/review");
  expect(response.statusCode).toBe(200);
  return response.json().discrepancies[0].reviewToken as string;
}

describe("inventory truth explanation and approval", () => {
  beforeEach(() => {
    session = { id: "count", siteId: "site", organizationId: "org", status: "ACTIVE", assignedToId: "employee", organizationRole: "MANAGER" };
    discrepancy = { id: "difference", sessionId: "count", productId: "product", expectedStoreQty: 15, actualStoreQty: 13, difference: -2, status: "OPEN", reason: "COULD_NOT_FIND", note: "Checked every location", explainedById: "employee", explainedAt: new Date("2026-09-15T00:00:00Z"), reviewedById: null, reviewedAt: null, product: { name: "B12", barcodeValue: "0123", packageSize: "60 tablets" } };
    ledger = []; events = []; authorized = true; unverified = 0; actual = 13; failUpdate = false;
    inactivePredicate = null; discrepancyOrganization = "org"; missingObservation = false;
    // This is a lock-sensitive transactional in-memory double, not PostgreSQL evidence.
    let tail = Promise.resolve();
    mock.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      let release = () => {};
      let locked = false;
      let snapshot: { discrepancy: Record<string, unknown>; ledger: Array<Record<string, unknown>> } | undefined;
      const tx = {
        $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
          const sql = parts.join(" ? ").replace(/\s+/g, " ");
          if (sql.includes("missing_observation")) return missingObservation ? [{ productId: "omitted", locationId: "shelf" }] : [];
          if (sql.includes('FROM "StoreCountSession" WHERE') && sql.endsWith("FOR UPDATE")) {
            const previous = tail;
            tail = new Promise<void>((resolve) => { release = resolve; });
            await previous; locked = true;
            snapshot = { discrepancy: { ...discrepancy }, ledger: [...ledger] };
            events.push("session-lock");
            return [session];
          }
          if (sql.includes('FROM "StoreCountSession"')) {
            if (inactivePredicate && sql.includes(inactivePredicate)) return [];
            for (const required of ['site."id" = session."siteId"', 'organization."id" = site."organizationId"', 'site_membership."siteId" = site."id"', 'organization_membership."organizationId" = organization."id"', 'site_membership."isActive" = TRUE', 'organization_membership."isActive" = TRUE', 'site."isActive" = TRUE', 'organization."isActive" = TRUE', 'site_membership."userId" =', 'organization_membership."userId" =']) {
              if (!sql.includes(required)) return [];
            }
            if (values[0] !== "count" || values[1] !== values[2] || !authorized) return [];
            if (sql.includes("FOR UPDATE OF session")) {
              const previous = tail;
              tail = new Promise<void>((resolve) => { release = resolve; });
              await previous; locked = true;
              snapshot = { discrepancy: { ...discrepancy }, ledger: [...ledger] };
              events.push("session-lock");
            }
            return [{ ...session, startedAt: new Date("2026-09-15T00:00:00Z") }];
          }
          if (sql.includes('FROM "StoreCountDiscrepancy"')) {
            if (!locked || !sql.includes("FOR UPDATE")) throw new Error("discrepancy lock must follow session lock");
            events.push("discrepancy-lock");
            if (sql.includes('product."organizationId" =') && !values.includes(discrepancyOrganization)) return [];
            return values.includes("difference") && values.includes("count") ? [discrepancy] : [];
          }
          if (sql.includes('FROM "Product"') && sql.includes("FOR UPDATE")) return [{ id: "product" }];
          throw new Error(`Unexpected SQL ${sql}`);
        },
        storeCountLocationVisit: { count: async () => unverified },
        storeCountDiscrepancy: {
          upsert: async ({ create }: { create: Record<string, unknown> }) => { discrepancy = { ...discrepancy, ...create }; return discrepancy; },
          findMany: async ({ where }: { where: { sessionId: string; product: { organizationId: string } } }) => where.sessionId === "count" && where.product.organizationId === "org" ? [discrepancy] : [],
          update: async ({ data }: { data: Record<string, unknown> }) => { if (failUpdate) throw new Error("simulated storage failure"); events.push("update"); discrepancy = { ...discrepancy, ...data }; return discrepancy; },
        },
        storeCountExpectation: { findMany: async () => [{ productId: "product", expectedStoreQty: 15 }] },
        storeCountEntry: {
          groupBy: async () => [{ productId: "product", _sum: { quantity: actual } }],
          findMany: async ({ where }: { where: { sessionId: string; location: { siteId: string }; product: { organizationId: string } } }) => where.sessionId === "count" && where.location.siteId === "site" && where.product.organizationId === "org" ? [
            { productId: "product", quantity: 8, location: { id: "shelf", code: "A1", name: "Vitamins" } },
            { productId: "product", quantity: actual - 8, location: { id: "back", code: "BACK", name: "Stockroom" } },
          ] : [],
        },
        inventoryTransaction: {
          aggregate: async () => ({ _sum: { quantity: 15 + ledger.reduce((sum, event) => sum + Number(event.quantity), 0) } }),
          findFirst: async () => null,
          findUnique: async ({ where }: { where: { id: string } }) => ledger.find((row) => row.id === where.id) ?? null,
          create: async ({ data }: { data: Record<string, unknown> }) => { if (!locked) throw new Error("unlocked write"); if (ledger.some((row) => row.id === data.id)) throw new Error("duplicate ledger identity"); events.push("ledger"); ledger.push(data); return data; },
        },
      };
      try { return await work(tx); } catch (error) { if (snapshot) { discrepancy = snapshot.discrepancy; ledger = snapshot.ledger; } throw error; } finally { release(); }
    });
  });

  it.each(reasons)("records authorized employee reason %s with retained evidence and actor", async (reason) => {
    const result = await request("PATCH", "/discrepancies/difference/explain", { reason, note: "x".repeat(500) });
    expect(result.statusCode).toBe(200);
    expect(discrepancy).toMatchObject({ expectedStoreQty: 15, actualStoreQty: 13, difference: -2, reason, note: "x".repeat(500), explainedById: "employee" });
    expect(discrepancy.explainedAt).toBeInstanceOf(Date);
    expect(ledger).toHaveLength(0);
  });
  it.each([{ reason: "bad" }, { reason: "COULD_NOT_FIND", note: "x".repeat(501) }, { reason: "COULD_NOT_FIND", quantity: 3 }])("rejects invalid explanation %j", async (body) => {
    expect((await request("PATCH", "/discrepancies/difference/explain", body)).statusCode).toBe(400);
    expect(events).not.toContain("update");
  });
  it("accepts empty note but requires a reason", async () => {
    expect((await request("PATCH", "/discrepancies/difference/explain", { reason: "OTHER_MANAGER_REVIEW", note: "" })).statusCode).toBe(200);
    expect((await request("PATCH", "/discrepancies/difference/explain", { note: "" })).statusCode).toBe(400);
  });
  it("rejects explanation from anyone except the current assignee even a JWT administrator", async () => {
    expect((await request("PATCH", "/discrepancies/difference/explain", { reason: "COULD_NOT_FIND" }, "other")).statusCode).toBe(403);
    expect(events).not.toContain("update");
  });
  it("allows only the legacy starter to explain when assignment is explicitly null", async () => {
    session.assignedToId = null; session.startedById = "employee";
    expect((await request("GET", "/review")).json().canExplain).toBe(true);
    expect((await request("PATCH", "/discrepancies/difference/explain", { reason: "COULD_NOT_FIND" })).statusCode).toBe(200);
    expect((await request("PATCH", "/discrepancies/difference/explain", { reason: "COULD_NOT_FIND" }, "other")).statusCode).toBe(403);
  });
  it.each(["COMPLETED", "CANCELLED"])("keeps %s explanation immutable", async (status) => {
    session.status = status;
    expect((await request("PATCH", "/discrepancies/difference/explain", { reason: "COULD_NOT_FIND" })).statusCode).toBe(409);
  });
  it.each(["APPROVED", "REJECTED", "RESOLVED"])("keeps %s explanation immutable", async (status) => {
    discrepancy.status = status;
    expect((await request("PATCH", "/discrepancies/difference/explain", { reason: "COULD_NOT_FIND" })).statusCode).toBe(409);
  });
  it("returns scoped counted locations and permissions, without guessed shelf expectations", async () => {
    const response = await request("GET", "/review");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ canExplain: true, canApprove: true, sessionStatus: "ACTIVE", finalized: true, discrepancies: [{ expectedStoreQty: 15, actualStoreQty: 13, difference: -2, countedLocations: [{ code: "A1", quantity: 8 }, { code: "BACK", quantity: 5 }] }] });
    expect(response.body).not.toContain("expectedLocationQty");
  });
  it("refreshes active discrepancy totals under the review lock after a recount", async () => {
    actual = 12;
    const response = await request("GET", "/review");
    expect(response.statusCode).toBe(200);
    expect(response.json().discrepancies[0]).toMatchObject({ expectedStoreQty: 15, actualStoreQty: 12, difference: -3 });
  });
  it.each(["OWNER", "ADMIN", "MANAGER"])("allows organization %s approval and exactly one immutable store-total ledger event", async (role) => {
    session.organizationRole = role;
    const reviewToken = await token();
    const response = await request("POST", "/discrepancies/difference/approve", { reviewToken });
    expect(response.statusCode).toBe(200);
    expect(discrepancy).toMatchObject({ status: "APPROVED", expectedStoreQty: 15, actualStoreQty: 13, difference: -2, reason: "COULD_NOT_FIND", reviewedById: "employee" });
    expect(ledger).toEqual([expect.objectContaining({ id: "store-count-discrepancy:difference", organizationId: "org", siteId: "site", locationId: null, productId: "product", type: "COUNT_ADJUSTMENT", quantity: -2, referenceType: "STORE_COUNT_DISCREPANCY", referenceId: "difference", actorUserId: "employee" })]);
    expect(events.indexOf("session-lock")).toBeLessThan(events.indexOf("discrepancy-lock"));
    expect(events.indexOf("discrepancy-lock")).toBeLessThan(events.indexOf("ledger"));
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken })).statusCode).toBe(200);
    expect(ledger).toHaveLength(1);
  });
  it("allows completed count approval without editing count evidence", async () => {
    session.status = "COMPLETED";
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken: await token() })).statusCode).toBe(200);
    expect(session.status).toBe("COMPLETED");
    expect(discrepancy.actualStoreQty).toBe(13);
  });
  it.each(["VIEWER", "INVENTORY"])("rejects %s organization role despite admin JWT", async (role) => {
    const reviewToken = await token(); session.organizationRole = role;
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken })).statusCode).toBe(403);
    expect(ledger).toHaveLength(0);
  });
  it.each(["/review", "/discrepancies/difference/explain", "/discrepancies/difference/approve"])("denies a missing current scope at %s", async (path) => {
    authorized = false;
    const response = await request(path === "/review" ? "GET" : path.endsWith("explain") ? "PATCH" : "POST", path, path === "/review" ? undefined : path.endsWith("explain") ? { reason: "COULD_NOT_FIND" } : { reviewToken: "a".repeat(64) });
    expect(response.statusCode).toBe(404); expect(ledger).toHaveLength(0); expect(events).not.toContain("update");
  });
  it.each(['actor."isActive" = TRUE', 'site."isActive" = TRUE', 'organization."isActive" = TRUE', 'site_membership."isActive" = TRUE', 'organization_membership."isActive" = TRUE'])("revalidates %s after review before approving", async (predicate) => {
    const reviewToken = await token(); inactivePredicate = predicate;
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken })).statusCode).toBe(404);
    expect(ledger).toHaveLength(0); expect(discrepancy.status).toBe("OPEN");
  });
  it("rejects an otherwise matching discrepancy whose product belongs to another organization", async () => {
    const reviewToken = await token(); discrepancyOrganization = "foreign-org";
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken })).statusCode).toBe(404);
    expect(ledger).toHaveLength(0); expect(discrepancy.status).toBe("OPEN");
  });
  it("requires reason and all locations verified", async () => {
    const reviewToken = await token(); discrepancy.reason = null;
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken })).statusCode).toBe(409);
    discrepancy.reason = "COULD_NOT_FIND"; unverified = 1;
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken })).statusCode).toBe(409);
    expect(ledger).toHaveLength(0);
  });
  it("rejects approval of stale verified evidence that omitted an assigned product", async () => {
    session.status = "COMPLETED";
    const reviewToken = await token(); missingObservation = true;
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken })).statusCode).toBe(409);
    expect(ledger).toHaveLength(0); expect(discrepancy.status).toBe("OPEN");
  });
  it("rejects stale quantity or explanation review and unknown discrepancy", async () => {
    const reviewToken = await token(); actual = 12;
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken })).statusCode).toBe(409);
    actual = 13; discrepancy.note = "new explanation";
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken })).statusCode).toBe(409);
    expect((await request("POST", "/discrepancies/other/approve", { reviewToken })).statusCode).toBe(404);
    expect(ledger).toHaveLength(0);
  });
  it.each(["RESOLVED", "REJECTED"])("cannot approve %s", async (status) => {
    const reviewToken = await token(); discrepancy.status = status;
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken })).statusCode).toBe(409);
    expect(ledger).toHaveLength(0);
  });
  it("rejects cancelled session", async () => {
    const reviewToken = await token(); session.status = "CANCELLED";
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken })).statusCode).toBe(409);
  });
  it("serializes simultaneous approvals and rolls back ledger on failed review write", async () => {
    const reviewToken = await token(); failUpdate = true;
    expect((await request("POST", "/discrepancies/difference/approve", { reviewToken })).statusCode).toBe(500);
    expect(ledger).toHaveLength(0); expect(discrepancy.status).toBe("OPEN");
    failUpdate = false;
    const responses = await Promise.all([request("POST", "/discrepancies/difference/approve", { reviewToken }), request("POST", "/discrepancies/difference/approve", { reviewToken })]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]); expect(ledger).toHaveLength(1);
  });
});
