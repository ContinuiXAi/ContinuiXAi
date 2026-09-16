import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../lib/prisma.js", () => ({ prisma: { $transaction: mocks.transaction } }));
import { inventoryTruthReviewRoutes } from "./inventoryTruthReview.js";

type Row = { id: string; sessionId: string; productId: string; expectedStoreQty: number; actualStoreQty: number; difference: number; status: string; reason: string; note: string; explainedById: string; explainedAt: Date };
type Event = { id: string; siteId: string; productId: string; quantity: number; createdAt: Date; occurredAt: Date };
let rows: Map<string, Row>;
let starts: Map<string, Date>;
let ledger: Event[];
let productLocks: number;
const initial = new Date("2026-09-15T00:00:00Z");
const started = new Date("2026-09-15T01:00:00Z");

async function request(sessionId: string, action = "review", reviewToken?: string) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => { Object.assign(req, { user: { sub: "manager" } }); });
  await app.register(inventoryTruthReviewRoutes);
  try { return await app.inject({ method: action === "review" ? "GET" : "POST", url: `/counts/${sessionId}/${action === "review" ? "review" : `discrepancies/${sessionId}/approve`}`, ...(reviewToken ? { payload: { reviewToken } } : {}) }); } finally { await app.close(); }
}
async function token(id: string) { const result = await request(id); expect(result.statusCode).toBe(200); return result.json().discrepancies[0].reviewToken as string; }

beforeEach(() => {
  rows = new Map(["a", "b"].map((id) => [id, { id, sessionId: id, productId: "product", expectedStoreQty: 15, actualStoreQty: 13, difference: -2, status: "OPEN", reason: "COULD_NOT_FIND", note: "Checked", explainedById: "employee", explainedAt: started }]));
  starts = new Map([["a", started], ["b", started]]);
  ledger = [{ id: "opening", siteId: "site", productId: "product", quantity: 15, createdAt: initial, occurredAt: initial }];
  productLocks = 0;
  // Models the emitted product lock, not real PostgreSQL scheduling.
  let tail = Promise.resolve();
  mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
    let release = () => {};
    return await work({
      $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const sql = parts.join(" ");
        if (sql.includes("missing_observation")) return [];
        if (sql.includes('FROM "StoreCountSession"')) return [{ id: values[0], siteId: "site", organizationId: "org", status: "COMPLETED", assignedToId: "employee", organizationRole: "MANAGER", startedAt: starts.get(String(values[0])) }];
        if (sql.includes('FROM "StoreCountDiscrepancy"')) return [rows.get(String(values[0]))];
        if (sql.includes('FROM "Product"') && sql.includes("FOR UPDATE")) {
          expect(values).toEqual(["product", "org"]);
          const previous = tail; tail = new Promise<void>((resolve) => { release = resolve; }); await previous; productLocks++; return [{ id: "product" }];
        }
        throw new Error(sql);
      },
      storeCountLocationVisit: { count: async () => 0 },
      storeCountDiscrepancy: {
        findMany: async ({ where }: { where: { sessionId: string } }) => [rows.get(where.sessionId)],
        update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => { const result = { ...rows.get(where.id)!, ...data }; rows.set(where.id, result); return result; },
      },
      storeCountEntry: { findMany: async ({ where }: { where: { sessionId: string } }) => [{ productId: "product", quantity: rows.get(where.sessionId)!.actualStoreQty, location: { id: "shelf", code: "A1", name: "Shelf" } }] },
      inventoryTransaction: {
        aggregate: async ({ where }: { where: { siteId: string; productId: string } }) => ({ _sum: { quantity: ledger.filter((event) => event.siteId === where.siteId && event.productId === where.productId).reduce((sum, event) => sum + event.quantity, 0) } }),
        findUnique: async ({ where }: { where: { id: string } }) => ledger.find((event) => event.id === where.id),
        findFirst: async ({ where }: { where: { siteId: string; productId: string; OR: Array<{ createdAt?: { gte: Date }; occurredAt?: { gte: Date } }> } }) => ledger.find((event) => event.siteId === where.siteId && event.productId === where.productId && where.OR.some((clause) => clause.createdAt ? event.createdAt >= clause.createdAt.gte : event.occurredAt >= clause.occurredAt!.gte)),
        create: async ({ data }: { data: Event }) => { const result = { ...data, quantity: Number(data.quantity), createdAt: data.createdAt ?? new Date(), occurredAt: data.occurredAt ?? new Date() }; ledger.push(result); return result; },
      },
    }).finally(() => release());
  });
});

describe("frozen count baseline fence", () => {
  it("rejects a changed ledger total even when a legacy transaction carries old timestamps", async () => {
    const reviewToken = await token("a");
    ledger.push({ id: "legacy", siteId: "site", productId: "product", quantity: 3, createdAt: initial, occurredAt: initial });
    expect((await request("a", "approve", reviewToken)).statusCode).toBe(409);
    expect(ledger.reduce((sum, event) => sum + event.quantity, 0)).toBe(18);
  });
  it.each([["a", "b"], ["b", "a"]])("rejects superseded session %s then %s without double shortage", async (first, second) => {
    const tokens = { a: await token("a"), b: await token("b") };
    expect((await request(first, "approve", tokens[first as "a"])).statusCode).toBe(200);
    expect((await request(second, "approve", tokens[second as "a"])).statusCode).toBe(409);
    expect((await request(first, "approve", tokens[first as "a"])).statusCode).toBe(200);
    expect(ledger.reduce((sum, event) => sum + event.quantity, 0)).toBe(13);
    expect(ledger).toHaveLength(2); expect(rows.get(second)?.status).toBe("OPEN");
    expect(productLocks).toBe(2);
  });
  it("serializes overlapping sessions and permits a later freshly started count", async () => {
    const tokens = [await token("a"), await token("b")];
    const responses = await Promise.all([request("a", "approve", tokens[0]), request("b", "approve", tokens[1])]);
    expect(responses.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(ledger.reduce((sum, event) => sum + event.quantity, 0)).toBe(13);
    const later = new Date(Date.now() + 1000);
    starts.set("c", later); rows.set("c", { ...rows.get("a")!, id: "c", sessionId: "c", status: "OPEN", expectedStoreQty: 13, actualStoreQty: 12, difference: -1 });
    expect((await request("c", "approve", await token("c"))).statusCode).toBe(200);
    expect(ledger.reduce((sum, event) => sum + event.quantity, 0)).toBe(12);
  });
  it.each(["sale", "receipt", "backdated"])("rejects a frozen count after a %s was recorded", async (kind) => {
    const reviewToken = await token("a");
    ledger.push({ id: kind, siteId: "site", productId: "product", quantity: kind === "receipt" ? 3 : -1, createdAt: new Date("2026-09-15T02:00:00Z"), occurredAt: kind === "backdated" ? initial : new Date("2026-09-15T02:00:00Z") });
    const before = ledger.reduce((sum, event) => sum + event.quantity, 0);
    expect((await request("a", "approve", reviewToken)).statusCode).toBe(409);
    expect(ledger.reduce((sum, event) => sum + event.quantity, 0)).toBe(before); expect(ledger).toHaveLength(2);
  });
});
