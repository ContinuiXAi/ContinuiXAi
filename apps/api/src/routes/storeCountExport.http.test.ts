import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCsv } from "../lib/csv.js";

const mocks = vi.hoisted(() => ({
  sessionFindFirst: vi.fn(),
  sessionFindUnique: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    storeCountSession: {
      findFirst: mocks.sessionFindFirst,
      findUnique: mocks.sessionFindUnique,
    },
  },
}));

import { storeCountExportRoutes } from "./storeCountExport.js";

type AuthenticatedUser = { id: string; role: string; organizationId: string };
type Session = {
  id: string;
  siteId: string | null;
  organizationId: string | null;
  startedById: string | null;
  name: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  startedBy: { id: string; name: string; email: string } | null;
  site: { id: string; code: string; name: string } | null;
  entries: Array<{
    barcodeValue: string;
    quantity: number;
    scannedAt: Date;
    updatedAt: Date;
    location: { code: string; name: string | null };
    product: { name: string; manufacturer: string | null; packageSize: string | null } | null;
  }>;
};

let authenticatedUser: AuthenticatedUser | undefined;
let activeUser: boolean;
let activeOrganizationMembership: boolean;
let activeSiteMembership: boolean;
let session: Session;

function authenticateAs(user: AuthenticatedUser) {
  authenticatedUser = user;
}

function mockSessionInOrganization(organizationId: string, siteId: string | null, startedById = "counter-b") {
  session = {
    id: "session-b",
    siteId,
    organizationId,
    startedById,
    name: "Tenant B, final",
    status: "COMPLETED",
    startedAt: new Date("2026-09-17T12:00:00.000Z"),
    completedAt: new Date("2026-09-17T12:30:00.000Z"),
    startedBy: { id: startedById, name: "Counter B", email: "counter-b@example.com" },
    site: siteId ? { id: siteId, code: "B", name: "Site B" } : null,
    entries: [
      {
        barcodeValue: "012345678905",
        quantity: 7,
        scannedAt: new Date("2026-09-17T12:05:00.000Z"),
        updatedAt: new Date("2026-09-17T12:06:00.000Z"),
        location: { code: "A1", name: "Front, Shelf" },
        product: { name: "Widget \"Large\"", manufacturer: "Acme", packageSize: "12 oz" },
      },
      {
        barcodeValue: "999999999999",
        quantity: 3,
        scannedAt: new Date("2026-09-17T12:10:00.000Z"),
        updatedAt: new Date("2026-09-17T12:10:00.000Z"),
        location: { code: "A2", name: null },
        product: null,
      },
    ],
  };
}

function isAuthorizedExportQuery(where: Record<string, unknown>): boolean {
  if (!authenticatedUser || where.id !== session.id) return false;
  const branches = where.OR as Array<Record<string, unknown>> | undefined;
  if (!branches) return false;

  const legacyBranch = branches.find((branch) => branch.siteId === null) as {
    startedById?: string;
    startedBy?: { isActive?: boolean };
  } | undefined;
  if (session.siteId === null) {
    return activeUser
      && legacyBranch?.startedById === authenticatedUser.id
      && legacyBranch.startedBy?.isActive === true
      && session.startedById === authenticatedUser.id;
  }

  const siteBranch = branches.find((branch) => branch.site) as {
    site?: {
      isActive?: boolean;
      memberships?: { some?: { userId?: string; isActive?: boolean } };
      organization?: {
        isActive?: boolean;
        memberships?: { some?: { userId?: string; isActive?: boolean; user?: { isActive?: boolean } } };
      };
    };
  } | undefined;
  const site = siteBranch?.site;
  return activeUser
    && activeOrganizationMembership
    && activeSiteMembership
    && authenticatedUser.organizationId === session.organizationId
    && site?.isActive === true
    && site.memberships?.some?.userId === authenticatedUser.id
    && site.memberships.some.isActive === true
    && site.organization?.isActive === true
    && site.organization.memberships?.some?.userId === authenticatedUser.id
    && site.organization.memberships.some.isActive === true
    && site.organization.memberships.some.user?.isActive === true;
}

async function testApp() {
  const app = Fastify();
  app.decorate("authenticate", async (request, reply) => {
    if (!authenticatedUser) return reply.code(401).send({ error: "unauthorized" });
    Object.assign(request, { user: { sub: authenticatedUser.id, role: authenticatedUser.role, tv: 0 } });
  });
  await app.register(storeCountExportRoutes);
  return app;
}

async function getExport() {
  const app = await testApp();
  try {
    return await app.inject({ method: "GET", url: "/sessions/session-b/export.csv" });
  } finally {
    await app.close();
  }
}

function expectNotFound(response: { statusCode: number; json: () => unknown }) {
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ error: "count session not found" });
}

describe("store count export authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticatedUser = undefined;
    activeUser = true;
    activeOrganizationMembership = true;
    activeSiteMembership = true;
    mockSessionInOrganization("org-a", "site-a", "counter-a");
    mocks.sessionFindUnique.mockResolvedValue(session);
    mocks.sessionFindFirst.mockImplementation(async ({ where }) => isAuthorizedExportQuery(where) ? session : null);
  });

  it("hides another tenant's count export from a global admin", async () => {
    mockSessionInOrganization("org-b", "site-b");
    mocks.sessionFindUnique.mockResolvedValue(session);
    authenticateAs({ id: "admin-a", role: "ADMIN", organizationId: "org-a" });

    expectNotFound(await getExport());
  });

  it("exports an organization Count for an active ADMIN without site membership", async () => {
    authenticateAs({ id: "admin-a", role: "ADMIN", organizationId: "org-a" });
    activeSiteMembership = false;
    mocks.sessionFindFirst.mockImplementation(async ({ where }) => {
      const branches = where.OR as Array<Record<string, unknown>>;
      const site = (branches.find((branch) => branch.site) as {
        site?: {
          memberships?: unknown;
          organization?: {
            memberships?: { some?: { userId?: string; isActive?: boolean; user?: { isActive?: boolean; role?: string } } };
          };
        };
      } | undefined)?.site;
      const membership = site?.organization?.memberships?.some;
      return where.id === session.id
        && site?.memberships === undefined
        && membership?.userId === "admin-a"
        && membership.isActive === true
        && membership.user?.isActive === true
        && membership.user.role === "ADMIN"
        ? session
        : null;
    });

    expect((await getExport()).statusCode).toBe(200);
  });

  it("rejects an unauthenticated export request", async () => {
    const response = await getExport();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.sessionFindFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["inactive user", () => { activeUser = false; }],
    ["inactive organization membership", () => { activeOrganizationMembership = false; }],
    ["inactive site membership", () => { activeSiteMembership = false; }],
  ])("hides the export from an %s", async (_reason, makeInactive) => {
    authenticateAs({ id: "counter-a", role: "GENERAL", organizationId: "org-a" });
    makeInactive();

    expectNotFound(await getExport());
  });

  it("hides a same-organization export from a member of the wrong site", async () => {
    authenticateAs({ id: "counter-a", role: "GENERAL", organizationId: "org-a" });
    activeSiteMembership = false;

    expectNotFound(await getExport());
  });

  it.each(["GENERAL", "MANAGER"])("exports for an authorized %s", async (role) => {
    authenticateAs({ id: "counter-a", role, organizationId: "org-a" });

    const response = await getExport();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    const rows = parseCsv(response.body);
    const header = rows[0];
    const quantity = header.indexOf("quantity");
    const description = header.indexOf("description");
    expect(rows[1][description]).toBe('Widget "Large"');
    expect(rows.slice(1).reduce((sum, row) => sum + Number(row[quantity]), 0)).toBe(10);
  });

  it("allows only the owner to export a legacy site-less session", async () => {
    mockSessionInOrganization("org-a", null, "owner-a");
    authenticateAs({ id: "owner-a", role: "GENERAL", organizationId: "org-a" });

    expect((await getExport()).statusCode).toBe(200);
  });

  it("hides a legacy site-less session from a non-owner admin", async () => {
    mockSessionInOrganization("org-a", null, "owner-a");
    authenticateAs({ id: "admin-a", role: "ADMIN", organizationId: "org-a" });

    expectNotFound(await getExport());
  });
});
