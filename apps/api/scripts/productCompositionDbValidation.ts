import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { prisma } from "../src/lib/prisma.js";
import { productRoutes } from "../src/routes/products.js";

const ROLLBACK_MARKER_QUANTITY = 2_147_483_646;
const FAILURE_TRIGGER = "task2_reject_composition_insert";
const FAILURE_FUNCTION = "task2_reject_composition_insert";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T;
}

async function dropFailureInjection() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${FAILURE_TRIGGER}" ON "ProductComposition"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${FAILURE_FUNCTION}"()`);
}

async function main() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: "product-composition-db-validation-secret" });
  app.decorate("authenticate", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });
  await app.register(productRoutes, { prefix: "/api/products" });
  await app.ready();

  let managerId: string | null = null;
  let organizationId: string | null = null;
  let parentPackagingId: string | null = null;
  let failureInjectionInstalled = false;

  try {
    const manager = await prisma.user.create({
      data: {
        name: "Composition DB Validation Manager",
        email: `composition-manager-${suffix}@example.test`,
        passwordHash: "not-used-in-db-validation",
        role: "GENERAL",
      },
    });
    managerId = manager.id;
    const organization = await prisma.organization.create({
      data: { name: "Composition DB Validation", slug: `composition-db-${suffix}` },
    });
    organizationId = organization.id;
    await prisma.organizationMembership.create({
      data: { organizationId: organization.id, userId: manager.id, role: "MANAGER", isActive: true },
    });

    const [parent, componentA, componentB] = await Promise.all([
      prisma.product.create({
        data: { organizationId: organization.id, name: "Validation Display", barcodeValue: `display-${suffix}` },
      }),
      prisma.product.create({
        data: { organizationId: organization.id, name: "Validation Component A", barcodeValue: `component-a-${suffix}` },
      }),
      prisma.product.create({
        data: { organizationId: organization.id, name: "Validation Component B", barcodeValue: `component-b-${suffix}` },
      }),
    ]);
    const parentPackaging = await prisma.productPackaging.create({
      data: {
        productId: parent.id,
        level: "CASE",
        name: "Validation display shipper",
        unitsOfEach: 1,
        isOrderable: true,
        isReceivable: true,
      },
    });
    parentPackagingId = parentPackaging.id;

    const token = app.jwt.sign({ sub: manager.id, role: "GENERAL", tv: 0 });
    const globalAdminToken = app.jwt.sign({ sub: manager.id, role: "ADMIN", tv: 0 });
    const headers = { authorization: `Bearer ${token}` };
    const writeComposition = (quantityA: number, quantityB: number) => app.inject({
      method: "POST",
      url: `/api/products/${parent.id}/compositions`,
      headers,
      payload: {
        parentPackagingId: parentPackaging.id,
        components: [
          { componentProductId: componentA.id, quantityPerParent: quantityA },
          { componentProductId: componentB.id, quantityPerParent: quantityB },
        ],
      },
    });

    const concurrentResponses = await Promise.all([
      writeComposition(4, 6),
      writeComposition(5, 7),
    ]);
    for (const response of concurrentResponses) {
      assert(response.statusCode === 201, `concurrent composition write returned ${response.statusCode}: ${response.body}`);
    }
    const responseVersions = concurrentResponses.map((response) => {
      const rows = parseJson<Array<{ version: number }>>(response.body);
      const versions = new Set(rows.map((row) => row.version));
      assert(rows.length === 2 && versions.size === 1, "a concurrent response did not contain one complete two-row version");
      return rows[0]!.version;
    }).sort((left, right) => left - right);
    assert(responseVersions[0] === 1 && responseVersions[1] === 2, `concurrent writes returned versions ${responseVersions.join(", ")}, expected 1, 2`);

    const persistedRows = await prisma.productComposition.findMany({
      where: { parentPackagingId: parentPackaging.id },
      orderBy: [{ version: "asc" }, { componentProductId: "asc" }],
    });
    const persistedVersions = new Set(persistedRows.map((row) => row.version));
    const activeRows = persistedRows.filter((row) => row.isActive);
    const activeVersions = new Set(activeRows.map((row) => row.version));
    assert(persistedRows.length === 4, `expected four persisted component rows, found ${persistedRows.length}`);
    assert(persistedVersions.size === 2, `expected two persisted versions, found ${persistedVersions.size}`);
    assert(activeRows.length === 2 && activeVersions.size === 1, "database did not retain exactly one complete active version");
    assert(activeRows[0]!.version === 2, `active version was ${activeRows[0]!.version}, expected 2`);

    const historicalResponse = await app.inject({
      method: "GET",
      url: `/api/products/${parent.id}/compositions`,
      headers,
    });
    assert(historicalResponse.statusCode === 200, `historical GET returned ${historicalResponse.statusCode}: ${historicalResponse.body}`);
    const historicalRows = parseJson<Array<{ version: number; isActive: boolean }>>(historicalResponse.body);
    assert(historicalRows.length === 4, `historical GET returned ${historicalRows.length} rows, expected 4`);
    assert(historicalRows.some((row) => row.version === 1 && !row.isActive), "historical GET omitted inactive version 1");
    assert(historicalRows.some((row) => row.version === 2 && row.isActive), "historical GET omitted active version 2");

    await dropFailureInjection();
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${FAILURE_FUNCTION}"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced Task 2 composition insert failure';
      END;
      $$
    `);
    failureInjectionInstalled = true;
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${FAILURE_TRIGGER}"
      BEFORE INSERT ON "ProductComposition"
      FOR EACH ROW
      WHEN (NEW."quantityPerParent" = ${ROLLBACK_MARKER_QUANTITY})
      EXECUTE FUNCTION "${FAILURE_FUNCTION}"()
    `);

    const rowsBeforeFailure = await prisma.productComposition.findMany({
      where: { parentPackagingId: parentPackaging.id },
      orderBy: { id: "asc" },
    });
    const forcedFailure = await writeComposition(ROLLBACK_MARKER_QUANTITY, 1);
    assert(forcedFailure.statusCode === 500, `forced insert failure returned ${forcedFailure.statusCode}, expected 500`);
    const rowsAfterFailure = await prisma.productComposition.findMany({
      where: { parentPackagingId: parentPackaging.id },
      orderBy: { id: "asc" },
    });
    assert(rowsAfterFailure.length === rowsBeforeFailure.length, "failed insert left partial composition rows");
    assert(
      rowsAfterFailure.every((row, index) => row.id === rowsBeforeFailure[index]!.id && row.isActive === rowsBeforeFailure[index]!.isActive),
      "failed insert did not roll back prior-version deactivation",
    );

    await dropFailureInjection();
    failureInjectionInstalled = false;

    let releaseRevocation!: () => void;
    let reportMembershipLocked!: () => void;
    const revocationRelease = new Promise<void>((resolve) => { releaseRevocation = resolve; });
    const membershipLocked = new Promise<void>((resolve) => { reportMembershipLocked = resolve; });
    const revokeAuthority = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT membership."id"
        FROM "OrganizationMembership" AS membership
        WHERE membership."organizationId" = ${organization.id}
          AND membership."userId" = ${manager.id}
        FOR UPDATE OF membership
      `;
      reportMembershipLocked();
      await revocationRelease;
      await tx.organizationMembership.update({
        where: { organizationId_userId: { organizationId: organization.id, userId: manager.id } },
        data: { isActive: false },
      });
    });
    await membershipLocked;
    const rowCountBeforeRevocationRace = await prisma.productComposition.count({
      where: { parentPackagingId: parentPackaging.id },
    });
    const racingWrite = app.inject({
      method: "POST",
      url: `/api/products/${parent.id}/compositions?organizationId=${organization.id}`,
      headers: { authorization: `Bearer ${globalAdminToken}` },
      payload: {
        parentPackagingId: parentPackaging.id,
        components: [
          { componentProductId: componentA.id, quantityPerParent: 8 },
          { componentProductId: componentB.id, quantityPerParent: 9 },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseRevocation();
    await revokeAuthority;
    const revokedResponse = await racingWrite;
    assert(revokedResponse.statusCode === 403, `write racing authority revocation returned ${revokedResponse.statusCode}, expected 403`);
    const rowCountAfterRevocationRace = await prisma.productComposition.count({
      where: { parentPackagingId: parentPackaging.id },
    });
    assert(rowCountAfterRevocationRace === rowCountBeforeRevocationRace, "revoked racing write changed composition history");

    console.log("Product composition PostgreSQL validation passed:");
    console.log("- two concurrent HTTP writes => complete versions 1 and 2");
    console.log("- exactly one complete active version remains; inactive history stays readable");
    console.log("- forced PostgreSQL insert failure rolls back prior-version deactivation");
    console.log("- authority revocation racing a write => HTTP 403 and no composition mutation");
  } finally {
    if (failureInjectionInstalled) await dropFailureInjection();
    if (parentPackagingId) {
      await prisma.productComposition.deleteMany({ where: { parentPackagingId } });
      await prisma.productPackaging.deleteMany({ where: { id: parentPackagingId } });
    }
    if (organizationId) {
      await prisma.product.deleteMany({ where: { organizationId } });
      await prisma.organizationMembership.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    if (managerId) await prisma.user.deleteMany({ where: { id: managerId } });
    await app.close();
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
