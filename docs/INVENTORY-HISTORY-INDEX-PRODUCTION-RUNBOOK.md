# Controlled production deployment: inventory-history index

This runbook applies only to the forward migration `20260917130000_inventory_history_index`, which creates `"InventoryTransaction_history_idx"` on `"InventoryTransaction" ("organizationId", "siteId", "productId", "occurredAt", "createdAt")`.

It is a production change with lock, elapsed-time, storage, and recovery risk. **Mitchell must explicitly approve the recorded preflight, chosen strategy, timeout values, and go/no-go decision before production.** CI is not that approval. Do not deploy from this document until all required evidence below is attached to the change record.

## What the validation does—and does not—establish

CI query validation ran against PostgreSQL 17 with 300,000 synthetic inventory events and 36 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans. The accepted query average was **7.829 ms**. This supports the selected query shape on that synthetic PostgreSQL 17 fixture; it does **not** predict production index-build duration, disk/WAL use, lock wait, or lock safety.

`docker-compose.prod.yml` declares PostgreSQL 16, while CI/render query validation uses PostgreSQL 17. The deployed database may differ from either declaration, so obtain the actual production version during preflight and have the DBA confirm that the chosen procedure is supported on it.

## Roles, change boundaries, and evidence

- A production DBA/operator runs database commands. The application deploy owner controls the write drain and the one migration runner. Mitchell supplies the required explicit approval.
- Record the target database identity, UTC timestamps, operator, deployment image/revision, migration output, every query result, backup/PITR evidence, and approval in the change record. Redact credentials and connection strings.
- Use an approved, least-privilege production connection. Read-only preflight queries must not be run through an application endpoint or copied into a migration.
- There must be exactly one migration runner. Disable or hold automatic/restarting application migration runners for the change so two processes cannot race.

## 1. Read-only preflight

Run the following against the production target, not a replica, and save the output. `-X` prevents a local `psqlrc` from changing the session. These queries are read-only except for the separate deployment action later.

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1
```

```sql
-- Confirm the actual target, server version, role, and recovery state.
SELECT current_database(), current_user, inet_server_addr(), inet_server_port(), version();
SHOW server_version_num;
SELECT pg_is_in_recovery();

-- The migration state must be clean before any deployment decision.
SELECT migration_name, finished_at, rolled_back_at, started_at, logs
FROM "_prisma_migrations"
ORDER BY started_at DESC
LIMIT 20;

-- Inspect every historical attempt of this target migration. Do not delete or
-- alter these rows manually.
SELECT migration_name, started_at, finished_at, rolled_back_at, logs
FROM "_prisma_migrations"
WHERE migration_name = '20260917130000_inventory_history_index'
ORDER BY started_at;
```

Also run the repository's normal status command with the production deployment image and its approved connection configuration:

```bash
npx prisma migrate status --schema apps/api/prisma/schema.prisma --config apps/api/prisma.config.ts
```

Before running this change, the target migration must be the **only** pending migration. `prisma migrate status` can therefore exit nonzero or say that migrations have not been applied; record its output rather than treating every nonzero exit as the same failure. Proceed only when all of the following are true:

- Every migration before `20260917130000_inventory_history_index` is applied exactly once and has `finished_at IS NOT NULL` and `rolled_back_at IS NULL`.
- `20260917130000_inventory_history_index` is the sole migration reported as pending.
- Its history is in exactly one of these two approved readiness states: **fresh first run** has no target row in `_prisma_migrations`; **authorized retry** has exactly one target row with `started_at IS NOT NULL`, `finished_at IS NULL`, and `rolled_back_at IS NOT NULL`, created by the documented `migrate resolve --rolled-back` action below.
- The status output reports no currently failed migration, missing local migration, checksum/history divergence, or database-connection error. The single authorized rolled-back target row is historical retry evidence, not a currently failed migration.

If the target is already applied, do not run this deployment: verify its index state and use the post-deployment checks. If the target has any other row pattern (including multiple attempts, an unfinished/unresolved attempt, or an applied-and-rolled-back mix), stop. If any earlier migration is pending, failed, rolled back, missing, or divergent, stop and resolve that separate migration state first. The recovery matrix below governs a partially recorded target migration; never edit `_prisma_migrations` by hand.

```sql
-- Table, indexes, and exact row count. Run the COUNT during a low-load period;
-- pg_stat estimates alone are not an exact count.
SELECT pg_size_pretty(pg_relation_size('"InventoryTransaction"'::regclass)) AS table_bytes,
       pg_size_pretty(pg_indexes_size('"InventoryTransaction"'::regclass)) AS indexes_bytes,
       pg_size_pretty(pg_total_relation_size('"InventoryTransaction"'::regclass)) AS total_bytes;
SELECT reltuples::bigint AS estimated_rows
FROM pg_class WHERE oid = '"InventoryTransaction"'::regclass;
SELECT count(*) AS exact_rows FROM "InventoryTransaction";

-- Existing candidate or abandoned build state. Any pre-existing named candidate
-- (valid or invalid) is a stop condition until reconciled with migration history.
SELECT c.relname AS index_name, i.indisvalid, i.indisready, i.indislive,
       pg_size_pretty(pg_relation_size(c.oid)) AS index_bytes,
       pg_get_indexdef(c.oid) AS index_definition
FROM pg_index AS i
JOIN pg_class AS c ON c.oid = i.indexrelid
WHERE i.indrelid = '"InventoryTransaction"'::regclass
ORDER BY c.relname;

-- The named candidate must be absent while this migration is pending. A row,
-- whether valid or invalid, requires migration-history reconciliation before go.
SELECT index_schema.nspname AS index_schema, c.relname AS index_name,
       i.indisvalid, i.indisready, i.indislive, pg_get_indexdef(c.oid) AS index_definition
FROM pg_index AS i
JOIN pg_class AS c ON c.oid = i.indexrelid
JOIN pg_namespace AS index_schema ON index_schema.oid = c.relnamespace
JOIN pg_class AS table_class ON table_class.oid = i.indrelid
JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
WHERE index_schema.nspname = 'public'
  AND c.relname = 'InventoryTransaction_history_idx'
  AND table_schema.nspname = 'public'
  AND table_class.relname = 'InventoryTransaction';

-- First snapshot of table-write counters. Repeat after a representative five-minute
-- interval and calculate deltas / elapsed seconds for insert, update, and delete rates.
SELECT now() AS sampled_at, stats_reset, n_tup_ins, n_tup_upd, n_tup_del,
       n_live_tup, n_dead_tup
FROM pg_stat_user_tables
WHERE relid = '"InventoryTransaction"'::regclass;

-- Long-running or idle-in-transaction work can delay initial/final index locks.
SELECT pid, usename, application_name, state, wait_event_type, wait_event,
       xact_start, now() - xact_start AS transaction_age,
       query_start, left(query, 300) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND xact_start IS NOT NULL
ORDER BY xact_start;
```

For storage headroom, obtain the actual free space and volume alert threshold from the production storage platform (or a read-only host/container `df` check on the PostgreSQL data volume). `pg_database_size` does not report free filesystem space. The DBA must reserve enough headroom for the expected index, build working space, WAL/archive growth, and recovery margin; no numeric estimate from CI substitutes for this check.

For backup/PITR readiness, attach proof of a recent successful backup, the latest successful restore exercise, retention that covers the change window, and WAL/PITR health. The following only reports configuration/state; it is not proof that a backup can be restored:

```sql
SHOW archive_mode;
SHOW archive_command;
SELECT pg_current_wal_lsn(), pg_last_wal_replay_lsn();
```

Stop before deployment if the target/version is uncertain, it is a standby, migration history does not match either approved readiness state (fresh first run or the single documented rolled-back retry), **any** existing `InventoryTransaction_history_idx` has not been reconciled with migration history, write rate or long transactions exceed the agreed change-window limits, storage/PITR evidence is missing, or the recorded Mitchell approval is absent.

## 2. Choose one deployment strategy

The production index build duration is unknown. Choose and record one of these paths after preflight; do not improvise a third path during the change.

### A. Approved maintenance window with a write drain (the current migration)

Use this path when a tested maintenance window can tolerate blocked writes. The checked-in migration uses ordinary `CREATE INDEX`, not `CREATE INDEX CONCURRENTLY`. Ordinary `CREATE INDEX` takes a lock that conflicts with `INSERT`, `UPDATE`, and `DELETE` on `InventoryTransaction`; it may wait for pre-existing writers and block new writers while it runs. It should therefore be deployed only after the application write drain is complete.

1. Announce the window; pause count scans, inventory imports/adjustments/transfers, background writers, and any other ledger writer. Put the application in approved maintenance/write-drain mode without changing data.
2. Verify the write-rate snapshot is flat for the agreed drain interval and that no relevant long transaction remains. Keep monitoring `pg_stat_activity` for new writers/lock waiters.
3. Configure timeouts for the **exact migration role and database** before it runs. Prisma CLI has no `SET` flag, and `SET` in an operator's separate `psql` session does not affect Prisma's new connection. Use PostgreSQL's supported role-in-database defaults instead. Set `MIGRATION_DB_ROLE` and `MIGRATION_DB_NAME` to the user and database shown by the preflight connection that the migration runner will actually use; have the DBA record any pre-existing defaults first.

   ```bash
   psql "$DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
     --set=migration_role="$MIGRATION_DB_ROLE" \
     --set=target_database="$MIGRATION_DB_NAME" <<'SQL'
   SELECT COALESCE(settings.setconfig, ARRAY[]::text[]) AS previous_role_database_settings
   FROM pg_roles AS role
   JOIN pg_database AS database ON database.datname = :'target_database'
   LEFT JOIN pg_db_role_setting AS settings
     ON settings.setrole = role.oid AND settings.setdatabase = database.oid
   WHERE role.rolname = :'migration_role';
   ALTER ROLE :"migration_role" IN DATABASE :"target_database" SET lock_timeout = '5s';
   ALTER ROLE :"migration_role" IN DATABASE :"target_database" SET statement_timeout = '30min';
   SQL
   ```

   `30min` is an example only: choose a finite approved value no longer than the remaining maintenance window. Verify the defaults through the same connection string that will be supplied to Prisma, then record the result:

   ```bash
   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c \
     "SELECT current_user, current_database(), current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout;"
   ```

4. Run exactly one approved deployment/migration runner with that same connection string; from the repository root, the current production command is:

   ```bash
   DATABASE_URL="$MIGRATION_DATABASE_URL" npx prisma migrate deploy --schema apps/api/prisma/schema.prisma --config apps/api/prisma.config.ts
   ```

   Do not manually run the SQL and do not manually insert migration-history rows. After the runner ends—successfully or unsuccessfully—restore the previously recorded role-in-database timeout settings before restarting application writers. If there were no previous values, use this command; otherwise restore the recorded values exactly.

   ```bash
   psql "$DBA_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
     --set=migration_role="$MIGRATION_DB_ROLE" \
     --set=target_database="$MIGRATION_DB_NAME" <<'SQL'
   ALTER ROLE :"migration_role" IN DATABASE :"target_database" RESET lock_timeout;
   ALTER ROLE :"migration_role" IN DATABASE :"target_database" RESET statement_timeout;
   SQL
   ```
5. If the lock timeout or statement timeout fires, treat it as an abort, not a signal to raise the timeout. Keep writes drained, collect the evidence, and follow the recovery section.

### B. Separately reviewed concurrent-build strategy

Do **not** replace the checked-in command with `CREATE INDEX CONCURRENTLY` ad hoc. A concurrent build is a different deployment design: it cannot run inside a transaction block, can take longer, has two lock-sensitive phases, needs its own migration-history/Prisma compatibility design, and can leave an invalid index after failure. It requires a separately reviewed migration and operational procedure, PostgreSQL-version-specific rehearsal at representative size/write rate, explicit timeout/monitoring/cleanup steps, and new Mitchell approval. This runbook authorizes neither a new migration nor a concurrent build.

## 3. Monitor the build and use explicit go/no-go criteria

During either approved strategy, a DBA observes the target database from a separate session:

```sql
SELECT now(), pid, datname, relid::regclass AS table_name,
       index_relid::regclass AS index_name, command, phase,
       lockers_total, lockers_done, blocks_total, blocks_done,
       tuples_total, tuples_done, partitions_total, partitions_done
FROM pg_stat_progress_create_index;

SELECT pid, usename, application_name, state, wait_event_type, wait_event,
       xact_start, now() - xact_start AS transaction_age,
       left(query, 300) AS query
FROM pg_stat_activity
WHERE datname = current_database()
ORDER BY xact_start NULLS LAST;
```

For PostgreSQL 16 and 17, `pg_stat_progress_create_index` is the correct progress view. It may be empty before the statement reaches a reportable phase; absence alone is not a success signal. Record samples and the migration runner's log.

Continue only while the drain holds (when using strategy A), the build progresses or remains within the agreed observation interval, storage/WAL health stays within the approved margin, and no user-visible error or unacceptable lock wait occurs. Abort on any timeout, loss of write drain, blocked critical workload, storage/PITR alert, failed migration, or lack of progress beyond the pre-agreed threshold. Do not kill a backend or terminate other users' transactions without the incident/change authority; capture the PID, query, and blocker evidence first.

## 4. Verify success and restore service

After the migration runner exits successfully, before reopening writes:

```bash
npx prisma migrate status --schema apps/api/prisma/schema.prisma --config apps/api/prisma.config.ts
```

```sql
SELECT c.relname AS index_name, i.indisvalid, i.indisready, i.indislive,
       pg_get_indexdef(c.oid) AS index_definition
FROM pg_index AS i
JOIN pg_class AS c ON c.oid = i.indexrelid
JOIN pg_namespace AS index_schema ON index_schema.oid = c.relnamespace
JOIN pg_class AS table_class ON table_class.oid = i.indrelid
JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
WHERE index_schema.nspname = 'public'
  AND c.relname = 'InventoryTransaction_history_idx'
  AND table_schema.nspname = 'public'
  AND table_class.relname = 'InventoryTransaction';
```

Success requires a clean migration status and exactly one candidate index whose definition matches the five documented columns in order and whose `indisvalid`, `indisready`, and `indislive` values are all `true`. Then reopen writers gradually and check application/database error rates and lock waits through the agreed observation period.

Perform these production smoke checks with authorized, non-destructive requests after writers reopen:

- In Store Count, open an existing active Count or the Count landing page for the approved site and confirm its saved state loads. Do not create, scan, complete, cancel, approve, or alter a production Count solely for this deployment.
- Call `GET /api/inventory-history/sites/<approved-site-id>/as-of?asOfExclusive=<recorded-UTC-time>&limit=1` as an authorized site member. Confirm HTTP 200, `valuationStatus: "unavailable"`, and a response consistent with the known site/cutoff. A 401/404/400 is a failed smoke check unless it was deliberately exercised with that identity/input.

## 5. Abort, invalid-index cleanup, and recovery

An index build is not a data migration: this migration does not change inventory history rows. The safe first rollback is to keep/return the application to its prior release, keep writes paused if correctness or availability is uncertain, and involve the DBA/change authority. Do not restore a database backup merely to remove this index; reserve backup/PITR recovery for a broader verified incident.

For a failed **ordinary** current migration, keep writers drained, inspect `prisma migrate status`, `_prisma_migrations`, and the schema-qualified index-state query before doing anything else. The following matrix is the only retry path for this migration. Every `migrate resolve` action needs DBA review, a recorded root cause, and fresh explicit Mitchell authorization; it changes migration history but does not run SQL.

| Prisma state for `20260917130000_inventory_history_index` | Named index state on `public."InventoryTransaction"` | Required action |
| --- | --- | --- |
| No target row; all earlier migrations applied; target is the only pending migration | Absent | Expected pre-deployment state. Continue only after the full preflight and Mitchell approval. |
| Exactly one target row with `started_at IS NOT NULL`, `finished_at IS NULL`, and `rolled_back_at IS NOT NULL`; all earlier migrations applied; target is the only pending migration | Absent | Authorized retry readiness state, but only after the `migrate resolve --rolled-back` action below, complete index-state reconciliation, a fresh full preflight, and fresh Mitchell approval. Run one new `migrate deploy` attempt only after those gates pass. |
| No target row; target pending | Valid and exactly the documented definition | Stop. This is an out-of-band build/history mismatch. Do not run `migrate deploy`. A DBA must prove how the index was created; only then may a separately approved `npx prisma migrate resolve --applied 20260917130000_inventory_history_index --schema apps/api/prisma/schema.prisma --config apps/api/prisma.config.ts` record that already-completed exact migration. |
| No target row; target pending | Invalid, not-ready, or different definition | Stop. Do not resolve it as applied. The DBA must first determine its owner/cause; for an abandoned concurrent build, use the separately approved cleanup below only after proving no build is active. Re-run all preflight and obtain fresh Mitchell approval before a retry. |
| Failed target row (`started_at` set, `finished_at IS NULL`, and `rolled_back_at IS NULL`) | Absent | After confirming no other failed/divergent migration and recording the failure cause, the DBA may run `npx prisma migrate resolve --rolled-back 20260917130000_inventory_history_index --schema apps/api/prisma/schema.prisma --config apps/api/prisma.config.ts`. Then confirm the target-row query now shows the single authorized rolled-back retry state above, re-check that the named index is absent, re-run the full preflight, and obtain fresh Mitchell approval before one new `migrate deploy` attempt. |
| Failed target row | Valid and exactly the documented definition | Stop. Do not re-run or mark rolled back, because re-running would collide with the index. After DBA evidence establishes the exact migration completed despite the failed record, a separately approved `migrate resolve --applied` command may record it as applied; otherwise escalate as a migration incident. |
| Failed target row | Invalid, not-ready, or different definition | Stop and escalate as a migration incident. Do not use `migrate resolve --applied`. A cleanup/rebuild plan must be reviewed, then complete preflight and receive fresh Mitchell approval before any retry. |

Never delete migration records by hand and never use `migrate resolve` to conceal an unverified database state.

For a separately approved concurrent-build failure, only after confirming no build session is active and the named index is invalid/not-ready, the DBA may use this non-transactional cleanup command in its own session:

```sql
DROP INDEX CONCURRENTLY IF EXISTS "InventoryTransaction_history_idx";
```

Do not drop a valid index, do not run that command inside `BEGIN`/`COMMIT`, and do not retry until the root cause, storage/WAL condition, blockers, revised schedule, and fresh Mitchell approval are recorded. Re-run the complete preflight before any retry.

## Closeout

Attach the final migration output, progress samples, index-state result, smoke-check evidence, restored-service timestamp, and any incident notes to the change record. State explicitly whether a maintenance-window build or a separately reviewed concurrent strategy was used. Mitchell closes the deployment record only after reviewing that evidence.
