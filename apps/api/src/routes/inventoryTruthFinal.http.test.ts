import Fastify from "fastify";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: {} as Record<string, unknown>, beforeTransaction: () => {} }));
vi.mock("../lib/prisma.js", () => ({ prisma: mocks.db }));
vi.mock("../lib/barcodeLookup/index.js", () => ({ resolveProduct: async () => ({ found: false }) }));
vi.mock("../lib/pilotSite.js", () => ({ ensurePilotSiteForUser: async () => null }));
import { storeCountRoutes } from "./storeCount.js";
import { inventoryTruthRoutes } from "./inventoryTruth.js";

const product = { id: "component", organizationId: "org", barcodeValue: "component-upc", name: "Component", packageSize: null, isActive: true };
const location = { id: "shelf", siteId: "site", code: "A1", name: "Shelf", sortOrder: 1, isActive: true };
const hint = (id: string) => ({ productId: id, locationId: "shelf", evidence: "ASSIGNED", isRequired: true, product: { ...product, id, barcodeValue: `${id}-upc` }, location });
type Entry = { id: string; sessionId: string; locationId: string; productId: string | null; barcodeValue: string; quantity: number };
type Session = {
  id: string;
  siteId: string | null;
  name: string | null;
  status: string;
  startedById: string;
  assignedToId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  routeSnapshot: ReturnType<typeof hint>[];
  updatedAt: Date;
};
let session: Session;
let entries: Entry[];
let logs: Array<{ idempotencyKey: string; sessionId: string; entryId: string; userId: string }>;
let authorized: boolean;
let verified: boolean;
let approved: boolean;
let currentProduct: typeof product;
let actor: string;
let actorRole: string;
let liveHints: ReturnType<typeof hint>[];
let createdSessions: Session[];
let assignmentEvents: Array<{ sessionId: string; fromUserId: string | null; toUserId: string; assignedById: string }>;
let reassignmentConflict: "active-assignee-adapter" | "active-assignee-target" | "other-unique" | null;

async function inject(operation: string, who = "a", barcode = "component-upc") {
  actor = who;
  const app = Fastify();
  app.decorate("authenticate", async (req) => { Object.assign(req, { user: { sub: who, role: "GENERAL" } }); });
  await app.register(storeCountRoutes, { prefix: "/count" });
  await app.register(inventoryTruthRoutes, { prefix: "/truth" });
  const options = operation === "scan" ? { method: "POST" as const, url: "/count/sessions/session/scan", payload: { barcodeValue: barcode, locationId: "shelf", quantityDelta: 2, clientScanId: `scan-${who}-${barcode}` } }
    : operation === "edit" ? { method: "PATCH" as const, url: "/count/sessions/session/entries/entry", payload: { quantity: 7 } }
      : operation === "verify" ? { method: "POST" as const, url: "/truth/counts/session/locations/shelf/verify", payload: { offlineQueueFlushed: true } }
        : operation === "active" ? { method: "GET" as const, url: "/count/sessions/active" }
          : operation === "start" ? { method: "POST" as const, url: "/count/sessions", payload: { siteId: "site" } }
            : operation === "reassign" ? { method: "POST" as const, url: "/truth/counts/session/reassign", payload: { toUserId: "b" } }
            : operation === "route" ? { method: "GET" as const, url: "/truth/counts/session/route" }
              : { method: "POST" as const, url: `/count/sessions/session/${operation}` };
  try { return await app.inject(options); } finally { await app.close(); }
}

beforeEach(() => {
  session = {
    id: "session",
    siteId: "site",
    name: null,
    status: "ACTIVE",
    startedById: "a",
    assignedToId: "a",
    startedAt: new Date(0),
    completedAt: null,
    routeSnapshot: [hint("component"), hint("absent")],
    updatedAt: new Date(0),
  };
  entries = [{ id: "entry", sessionId: "session", locationId: "shelf", productId: "component", barcodeValue: "component-upc", quantity: 4 }];
  logs = []; authorized = true; verified = false; approved = false; currentProduct = product; actorRole = "INVENTORY"; liveHints = [...session.routeSnapshot]; createdSessions = [];
  assignmentEvents = [{ sessionId: session.id, fromUserId: null, toUserId: "a", assignedById: "a" }];
  reassignmentConflict = null;
  mocks.beforeTransaction = () => {};
  const scope = () => ({ ...session, organizationId: "org", organizationRole: actorRole, startedAt: new Date(0), visitStatus: verified ? "VERIFIED" : "PENDING" });
  const observed = () => session.routeSnapshot.every((h) => entries.some((e) => e.productId === h.productId && e.locationId === h.locationId));
  const db = {
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join(" ");
      if (sql.includes("missing_observation")) return observed() ? [] : [{ productId: "absent", locationId: "shelf" }];
      if (sql.includes('FROM "StoreCountSession"')) {
        if (sql.includes('INNER JOIN "Site"') && session.siteId === null) return [];
        if (sql.includes('actor."isActive"') && !authorized) return [];
        return [scope()];
      }
      if (sql.includes('FROM "StoreCountDiscrepancy"')) return approved ? [{ status: "APPROVED" }] : [];
      if (sql.includes('FROM "User"')) return authorized ? [{ id: actor }] : [];
      if (sql.includes('FROM "Site"')) return sql.includes('actor."isActive"') && !authorized ? [] : [{ id: "site", organizationId: "org" }];
      if (sql.includes('FROM "StoreLocation"')) return [location];
      if (sql.includes('FROM "ProductComposition"')) return currentProduct.id === "parent" ? [{ id: "recipe" }] : [];
      if (sql.includes('FROM "Product"')) return [currentProduct];
      if (sql.includes('FROM "ProductIdentifier"')) return [];
      if (sql.includes('INSERT INTO "StoreCountEntry"')) {
        let entry = entries.find((e) => e.barcodeValue === values[3]);
        if (entry) entry.quantity += Number(values[5]);
        else { entry = { id: String(values[0]), sessionId: String(values[1]), productId: String(values[2]), barcodeValue: String(values[3]), locationId: String(values[4]), quantity: Number(values[5]) }; entries.push(entry); }
        return [{ id: entry.id }];
      }
      throw new Error(sql);
    },
    $executeRaw: async () => 1,
    site: { findMany: async () => [{ id: "site", organizationId: "org" }], findUnique: async () => ({ organizationId: "org" }) },
    storeLocation: { findUnique: async () => location, findFirst: async () => location },
    product: { findFirst: async ({ where }: { where: { barcodeValue: string } }) => where.barcodeValue === currentProduct.barcodeValue ? currentProduct : null },
    productIdentifier: { findFirst: async ({ where }: { where: { value: string } }) => where.value === "display-alias" && currentProduct.id === "parent" ? { product: currentProduct } : null },
    productComposition: { findFirst: async () => currentProduct.id === "parent" ? { id: "recipe" } : null },
    storeCountSession: {
      findFirst: async ({ where }: { where: { id?: string; siteId?: string; status?: string; OR?: unknown; assignedToId?: string; startedById?: string } }) => {
        const sessions = [session, ...createdSessions];
        if (where.id) {
          const found = sessions.find((candidate) => candidate.id === where.id);
          if (!found || (found.siteId === null && found.startedById !== actor)) return null;
          return { ...found, site: found.siteId === null ? null : { organizationId: "org" } };
        }
        const filtered = where.assignedToId === actor || (JSON.stringify(where.OR ?? []).includes('"assignedToId"'));
        if (!filtered) return { ...session };
        return sessions.find((candidate) =>
          (where.status === undefined || candidate.status === where.status)
          && (where.siteId === undefined || candidate.siteId === where.siteId)
          && (candidate.assignedToId === actor || (candidate.assignedToId === null && candidate.startedById === actor)),
        ) ?? null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const found = [session, ...createdSessions].find((candidate) => candidate.id === where.id);
        return found ? { ...found } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Session> }) => {
        if (data.assignedToId && reassignmentConflict) {
          const fields = reassignmentConflict === "other-unique" ? ['"slug"'] : ['"assignedToId"', '"siteId"'];
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "7.0.0",
            meta: reassignmentConflict === "active-assignee-target"
              ? { target: "StoreCountSession_one_active_per_assignee_site" }
              : {
                  modelName: "StoreCountSession",
                  driverAdapterError: {
                    name: "DriverAdapterError",
                    cause: {
                      originalCode: "23505",
                      originalMessage: "duplicate key value violates unique constraint",
                      kind: "UniqueConstraintViolation",
                      constraint: { fields },
                    },
                  },
                },
          });
        }
        const target = [session, ...createdSessions].find((candidate) => candidate.id === where.id);
        if (!target) throw new Error("SESSION_NOT_FOUND");
        Object.assign(target, data, { updatedAt: new Date() });
        return { ...target };
      },
      create: async ({ data }: { data: { name?: string | null; siteId: string | null; startedById: string; assignedToId: string | null } }) => {
        const candidate: Session = {
          id: `new-session-${createdSessions.length + 1}`,
          siteId: data.siteId,
          name: data.name ?? null,
          status: "ACTIVE",
          startedById: data.startedById,
          assignedToId: data.assignedToId,
          startedAt: new Date(),
          completedAt: null,
          routeSnapshot: [],
          updatedAt: new Date(),
        };
        const conflicts = [session, ...createdSessions].some((existing) =>
          existing.status === "ACTIVE"
          && ((candidate.assignedToId !== null
            && candidate.siteId !== null
            && existing.assignedToId === candidate.assignedToId
            && existing.siteId === candidate.siteId)
            || (candidate.assignedToId === null
              && existing.assignedToId === null
              && existing.startedById === candidate.startedById)),
        );
        if (conflicts) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "7.0.0",
            meta: { target: "StoreCountSession_one_active_per_assignee_site" },
          });
        }
        createdSessions.push(candidate);
        return { ...candidate };
      },
    },
    organizationMembership: { findFirst: async () => ({ userId: "b" }) },
    productLocationHint: { findMany: async () => liveHints },
    storeCountAssignmentEvent: { create: async ({ data }: { data: (typeof assignmentEvents)[number] }) => { assignmentEvents.push(data); return data; } },
    storeCountExpectation: { findMany: async () => [], createMany: async () => ({}) },
    inventoryTransaction: { groupBy: async () => [] },
    storeCountLocationVisit: {
      count: async () => verified ? 0 : 1,
      findMany: async () => [{ status: verified ? "VERIFIED" : "PENDING", location }],
      createMany: async () => ({}),
      upsert: async () => { verified = true; return { status: "VERIFIED" }; },
    },
    storeCountEntry: {
      findMany: async () => entries,
      count: async () => entries.length,
      groupBy: async () => [],
      findFirst: async () => entries[0],
      findUnique: async ({ where }: { where: { sessionId_locationId_barcodeValue?: { barcodeValue: string } } }) => entries.find((e) => e.barcodeValue === where.sessionId_locationId_barcodeValue?.barcodeValue) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => entries.find((e) => e.id === where.id),
      update: async ({ data }: { data: { quantity: number } }) => { entries[0].quantity = data.quantity; return entries[0]; },
    },
    storeCountScanLog: {
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) => { const log = logs.find((l) => l.idempotencyKey === where.idempotencyKey); return log ? { ...log, entry: entries.find((e) => e.id === log.entryId) } : null; },
      create: async ({ data }: { data: (typeof logs)[number] }) => { logs.push(data); return data; },
    },
    storeCountDiscrepancy: { findMany: async () => [], count: async () => approved ? 1 : 0 },
  };
  Object.assign(mocks.db, db, { $transaction: async (work: (tx: typeof db) => unknown) => { mocks.beforeTransaction(); return work(db); } });
});

describe("whole-branch count counterexamples", () => {
  it("rechecks active actor at the session-start write boundary", async () => {
    mocks.beforeTransaction = () => { authorized = false; };
    expect((await inject("start")).statusCode).toBe(403);
  });
  it("lets starter A begin new site work after the active count is handed to B", async () => {
    session.assignedToId = "b";
    assignmentEvents.push({ sessionId: session.id, fromUserId: "a", toUserId: "b", assignedById: "manager" });
    const originalHistory = assignmentEvents.filter((event) => event.sessionId === session.id).map((event) => ({ ...event }));
    const response = await inject("start", "a");
    expect(response.statusCode).toBe(201);
    expect(response.json().siteId).toBe("site");
    expect(response.json().startedById).toBe("a");
    expect(response.json().assignedToId).toBe("a");
    expect(session.startedById).toBe("a");
    expect(session.assignedToId).toBe("b");
    expect(createdSessions).toHaveLength(1);
    expect(createdSessions[0]).toMatchObject({ id: response.json().id, siteId: "site", startedById: "a", assignedToId: "a" });
    expect(assignmentEvents.filter((event) => event.sessionId === session.id)).toEqual(originalHistory);
    expect(assignmentEvents.filter((event) => event.sessionId === response.json().id)).toEqual([
      { sessionId: response.json().id, fromUserId: null, toUserId: "a", assignedById: "a" },
    ]);
  });
  it.each(["active-assignee-adapter", "active-assignee-target"] as const)("returns actionable conflict for %s metadata when reassignment targets an employee with active work at the site", async (metadata) => {
    actorRole = "MANAGER";
    reassignmentConflict = metadata;
    const response = await inject("reassign", "manager");
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/finish or reassign/i);
    expect(session.assignedToId).toBe("a");
  });
  it("does not mask unrelated uniqueness failures as reassignment conflicts", async () => {
    actorRole = "MANAGER";
    reassignmentConflict = "other-unique";
    expect((await inject("reassign", "manager")).statusCode).toBe(500);
    expect(session.assignedToId).toBe("a");
  });
  it("lets the authorized starter cancel a legacy site-less active count", async () => {
    session.siteId = null;
    session.assignedToId = null;
    const response = await inject("cancel", "a");
    expect(response.statusCode).toBe(200);
    expect(session.status).toBe("CANCELLED");
  });
  it("lets the authorized starter cancel an empty legacy site-less active count", async () => {
    session.siteId = null;
    session.assignedToId = null;
    entries = [];
    expect((await inject("cancel", "a")).statusCode).toBe(200);
    expect(session.status).toBe("CANCELLED");
  });
  it("denies a non-starter cancelling a legacy site-less count", async () => {
    session.siteId = null;
    session.assignedToId = null;
    expect((await inject("cancel", "b")).statusCode).toBe(404);
    expect(session.status).toBe("ACTIVE");
  });
  it("cannot stale-cancel a legacy site-less count after completion", async () => {
    session.siteId = null;
    session.assignedToId = null;
    mocks.beforeTransaction = () => { session.status = "COMPLETED"; };
    expect((await inject("cancel", "a")).statusCode).toBe(409);
    expect(session.status).toBe("COMPLETED");
  });
  it.each(["scan", "edit", "verify", "cancel", "complete"])("allows current assignee B to %s after handoff", async (operation) => {
    session.assignedToId = "b";
    entries.push({ id: "zero", sessionId: "session", locationId: "shelf", productId: "absent", barcodeValue: "absent-upc", quantity: 0 });
    verified = operation === "complete";
    expect((await inject(operation, "b")).statusCode).toBe(200);
  });
  it.each(["scan", "edit", "verify", "cancel", "complete"])("retains explicit null-assignment starter fallback for %s", async (operation) => {
    session.assignedToId = null;
    entries.push({ id: "zero", sessionId: "session", locationId: "shelf", productId: "absent", barcodeValue: "absent-upc", quantity: 0 });
    verified = operation === "complete";
    expect((await inject(operation)).statusCode).toBe(200);
  });
  it.each(["scan", "edit", "verify", "cancel", "complete"])("denies former-owner %s after A to B handoff without changing evidence", async (operation) => {
    session.assignedToId = "b";
    const response = await inject(operation);
    expect(response.statusCode).toBe(403);
    expect(entries[0].quantity).toBe(4); expect(logs).toHaveLength(0); expect(verified).toBe(false); expect(session.status).toBe("ACTIVE");
  });
  it.each(["scan", "edit", "verify", "cancel", "complete"])("does not let a manager bypass reassignment for %s", async (operation) => {
    actorRole = "MANAGER";
    expect((await inject(operation, "manager")).statusCode).toBe(403);
  });
  it("blocks a former-owner queued retry even when its original scan identity was already committed", async () => {
    session.assignedToId = "b";
    logs.push({ idempotencyKey: "scan-a-component-upc", sessionId: session.id, entryId: entries[0].id, userId: "a" });
    expect((await inject("scan")).statusCode).toBe(403);
    expect(entries[0].quantity).toBe(4); expect(logs).toHaveLength(1); expect(logs[0].userId).toBe("a");
  });
  it.each(["scan", "edit", "verify", "cancel", "complete"])("rechecks revoked authority inside %s transaction", async (operation) => {
    mocks.beforeTransaction = () => { authorized = false; };
    expect((await inject(operation)).statusCode).toBe(404);
    expect(entries[0].quantity).toBe(4); expect(logs).toHaveLength(0); expect(session.status).toBe("ACTIVE");
  });
  it("blocks omitted product verification even with one positive observation, then accepts explicit zero", async () => {
    expect((await inject("verify")).statusCode).toBe(409); expect(verified).toBe(false);
    entries.push({ id: "zero", sessionId: "session", locationId: "shelf", productId: "absent", barcodeValue: "absent-upc", quantity: 0 });
    expect((await inject("verify")).statusCode).toBe(200); expect(verified).toBe(true);
  });
  it("refuses Finish when a stale VERIFIED visit still lacks its required product evidence", async () => {
    verified = true;
    expect((await inject("complete")).statusCode).toBe(409); expect(session.status).toBe("ACTIVE");
  });
  it.each(["COMPLETED", "CANCELLED"])("cannot stale-cancel over %s", async (status) => {
    mocks.beforeTransaction = () => { session.status = status; };
    expect((await inject("cancel")).statusCode).toBe(409); expect(session.status).toBe(status);
  });
  it("cannot cancel a still-active session with approved adjustments", async () => {
    approved = true;
    expect((await inject("cancel")).statusCode).toBe(409); expect(session.status).toBe("ACTIVE");
  });
  it.each(["parent-upc", "display-alias"])("rejects display parent identifier %s while preserving component quantity and scan identity", async (barcode) => {
    currentProduct = { ...product, id: "parent", barcodeValue: "parent-upc" };
    expect((await inject("scan", "a", barcode)).statusCode).toBe(409);
    expect(entries).toHaveLength(1); expect(entries[0].quantity).toBe(4); expect(logs).toHaveLength(0);
  });
  it("resumes only current assigned work, not a newer count owned by someone else", async () => {
    session.assignedToId = "b";
    expect((await inject("active")).json()).toBeNull();
    expect((await inject("active", "b")).json().id).toBe("session");
    expect((await inject("start", "b")).json().id).toBe("session");
    const started = (await inject("start", "a")).json();
    expect(started.id).not.toBe("session");
    expect(started.assignedToId).toBe("a");
  });
  it("keeps the required route unchanged after a live hint is removed", async () => {
    liveHints = [hint("component")];
    const response = await inject("route");
    expect(response.statusCode).toBe(200);
    expect(response.json().locations[0].products.map((p: { productId: string }) => p.productId).sort()).toEqual(["absent", "component"]);
  });
});
