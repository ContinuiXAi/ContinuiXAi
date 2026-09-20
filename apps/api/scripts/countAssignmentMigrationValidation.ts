import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const connectionString = process.env.DATABASE_URL ?? "";
const url = new URL(connectionString);
assert(["localhost", "127.0.0.1", "postgres"].includes(url.hostname), "Use a disposable local database");
assert(url.pathname.endsWith("_ci"), "Database name must end in _ci; independently verify this is not a production tunnel");

const migration = await readFile(new URL("../prisma/migrations/20260916090000_count_assignment_ledger_integrity/migration.sql", import.meta.url), "utf8");
const suffix = randomUUID().replaceAll("-", "");
const duplicateSchema = `count_assignment_duplicate_${suffix}`;
const cleanSchema = `count_assignment_clean_${suffix}`;
const client = new pg.Client({ connectionString, application_name: "count-assignment-migration-validator" });

function quoted(identifier: string) {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

async function createLegacyShape(schema: string) {
  await client.query(`CREATE SCHEMA ${quoted(schema)}`);
  await client.query(`SET search_path TO ${quoted(schema)}, public`);
  await client.query(`
    CREATE TABLE "StoreCountSession" (
      "id" TEXT PRIMARY KEY,
      "status" TEXT NOT NULL,
      "startedById" TEXT,
      "assignedToId" TEXT,
      "siteId" TEXT
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX "StoreCountSession_one_active_per_user"
      ON "StoreCountSession"("startedById")
      WHERE "status" = 'ACTIVE'
  `);
}

async function indexNames(schema: string) {
  const result = await client.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname",
    [schema],
  );
  return result.rows.map((row) => row.indexname);
}

await client.connect();
try {
  await createLegacyShape(duplicateSchema);
  await client.query(`
    INSERT INTO "StoreCountSession" ("id", "status", "startedById", "assignedToId", "siteId")
    VALUES
      ('count-a', 'ACTIVE', 'starter-a', 'assignee-b', 'site-a'),
      ('count-b', 'ACTIVE', 'starter-b', 'assignee-b', 'site-a')
  `);
  await assert.rejects(
    client.query(migration),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /duplicate ACTIVE assignee\/site groups/);
      assert.match(error.message, /assignee-b/);
      assert.match(error.message, /site-a/);
      assert.match(error.message, /activeCount=2/);
      return true;
    },
  );
  assert((await indexNames(duplicateSchema)).includes("StoreCountSession_one_active_per_user"));
  assert(!(await indexNames(duplicateSchema)).includes("StoreCountSession_one_active_per_assignee_site"));

  await createLegacyShape(cleanSchema);
  await client.query(`
    INSERT INTO "StoreCountSession" ("id", "status", "startedById", "assignedToId", "siteId")
    VALUES ('count-clean', 'ACTIVE', 'starter-a', 'assignee-a', 'site-a')
  `);
  await client.query(migration);
  const migratedIndexes = await indexNames(cleanSchema);
  assert(!migratedIndexes.includes("StoreCountSession_one_active_per_user"));
  assert(migratedIndexes.includes("StoreCountSession_one_active_per_assignee_site"));
  assert(migratedIndexes.includes("StoreCountSession_one_active_unassigned_starter"));
  const replacementFunction = await client.query<{ count: number }>(`
    SELECT COUNT(*)::int AS count
    FROM pg_proc
    INNER JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
    WHERE pg_namespace.nspname = $1
      AND pg_proc.proname = 'validate_inventory_transaction_scope'
  `, [cleanSchema]);
  assert.equal(replacementFunction.rows[0].count, 1);
  console.log("Count assignment migration validation passed: duplicate populated upgrades fail with actionable group evidence, while conflict-free legacy data migrates to both intended indexes.");
} finally {
  await client.query("SET search_path TO public");
  await client.query(`DROP SCHEMA IF EXISTS ${quoted(duplicateSchema)} CASCADE`);
  await client.query(`DROP SCHEMA IF EXISTS ${quoted(cleanSchema)} CASCADE`);
  await client.end();
}
