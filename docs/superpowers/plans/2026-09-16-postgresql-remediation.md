# PostgreSQL Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three load-bearing PostgreSQL/integration defects established by the final scoped inventory-truth review without relaxing assignee-only count operations.

**Architecture:** Add one forward-only migration that replaces starter-based active-count uniqueness with current-assignee/site uniqueness and reconciles nullable store-total ledger events with the existing scope trigger. Retain a narrow session-locked starter fallback for cancelling legacy site-less sessions. Correct the disposable PostgreSQL validator so it obeys the full production migration chain and proves the post-handoff Start workflow.

**Tech Stack:** TypeScript, Fastify, Prisma 7, PostgreSQL 17, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-14-inventory-truth-and-reconciliation-design.md`

## Global Constraints

- Employees may change only work currently assigned to them; managers must use audited reassignment and receive no implicit operational-write override.
- Preserve `startedById` and all assignment events as immutable history.
- Start/resume is site-scoped; one employee may have at most one ACTIVE assigned count per site.
- Legacy site-less counts retain starter-only resume, Finish, and Cancel compatibility; they do not gain scanning or global-manager access.
- Nullable ledger location is allowed only for store-total adjustment events supported by the current enum. RECEIVE, SHIP, TRANSFER_IN, TRANSFER_OUT, DAMAGE, and RETURN_TO_VENDOR continue to require a valid location belonging to the transaction site.
- Inventory transactions remain append-only and non-zero; inbound quantities remain positive and outbound quantities remain negative.
- Use additive/forward-only migration changes. Do not rewrite starter identity, delete count history, weaken tenant/site relationships, disable constraints, or mutate production.
- Preserve PR #21. No push, merge, or deployment is part of this local task.

---

### Task 1: Reconcile count ownership, nullable ledger scope, and legacy cancellation

**Files:**
- Create: `apps/api/prisma/migrations/20260916090000_count_assignment_ledger_integrity/migration.sql`
- Modify: `apps/api/src/routes/storeCount.ts`
- Modify: `apps/api/src/routes/inventoryTruth.ts`
- Modify: `apps/api/src/routes/inventoryTruthFinal.http.test.ts`
- Modify: `apps/api/scripts/inventoryTruthFinalDbValidation.ts`
- Modify: `.github/workflows/ci.yml` only if the current final validator is not already executed after all migrations
- Test: `apps/api/src/routes/inventoryTruthFinal.http.test.ts`
- Test through disposable PostgreSQL: `apps/api/scripts/inventoryTruthFinalDbValidation.ts`

**Interfaces:**
- Consumes: `assignedCountWhere(userId)`, `isCurrentCountAssignee(scope, userId)`, `lockCountScope(tx, sessionId, userId)`, the existing Store Count Start/Reassign/Cancel routes, and the immutable `InventoryTransaction` ledger.
- Produces: constraint-safe A→B handoff followed by A starting new work; deterministic 409 handling when a target already owns ACTIVE work at that site; valid nullable `COUNT_ADJUSTMENT`/`MANUAL_ADJUSTMENT` ledger events; and starter-only cancellation of legacy site-less ACTIVE sessions.

- [ ] **Step 1: Add failing HTTP regressions before route changes**

Extend `inventoryTruthFinal.http.test.ts` with observable route cases that fail on the current head:

```ts
it("lets starter A begin new site work after the active count is handed to B", async () => {
  session.assignedToId = "b";
  const response = await inject("start", "a");
  expect(response.statusCode).toBe(201);
  expect(response.json().assignedToId).toBe("a");
  expect(session.startedById).toBe("a");
  expect(session.assignedToId).toBe("b");
});

it("lets the authorized starter cancel a legacy site-less active count", async () => {
  session.siteId = null;
  session.assignedToId = null;
  const response = await inject("cancel", "a");
  expect(response.statusCode).toBe(200);
  expect(session.status).toBe("CANCELLED");
});

it("denies a non-starter cancelling a legacy site-less count", async () => {
  session.siteId = null;
  session.assignedToId = null;
  expect((await inject("cancel", "b")).statusCode).toBe(404);
  expect(session.status).toBe("ACTIVE");
});
```

The test adapter must mirror the complete session shape and the relevant unique-index behavior. Do not make a permissive fake return success independently of route behavior.

- [ ] **Step 2: Run the focused HTTP suite and record RED**

Run:

```bash
npm --workspace @continuixai/api test -- inventoryTruthFinal.http.test.ts
```

Expected: the post-handoff Start case fails under starter-based active uniqueness, and legacy site-less Cancel returns 404/keeps ACTIVE.

- [ ] **Step 3: Add the forward-only constraint migration**

Create the migration with these semantics:

```sql
DROP INDEX IF EXISTS "StoreCountSession_one_active_per_user";

CREATE UNIQUE INDEX "StoreCountSession_one_active_per_assignee_site"
  ON "StoreCountSession"("assignedToId", "siteId")
  WHERE "status" = 'ACTIVE'
    AND "assignedToId" IS NOT NULL
    AND "siteId" IS NOT NULL;

CREATE UNIQUE INDEX "StoreCountSession_one_active_unassigned_starter"
  ON "StoreCountSession"("startedById")
  WHERE "status" = 'ACTIVE'
    AND "assignedToId" IS NULL
    AND "startedById" IS NOT NULL;
```

Replace `validate_inventory_transaction_scope()` without dropping its trigger. Keep organization/site/product/packaging/actor checks and every quantity-sign rule. Validate `locationId` when non-null. When it is null, permit only `COUNT_ADJUSTMENT` and `MANUAL_ADJUSTMENT`; reject all current physical-movement types.

- [ ] **Step 4: Make Start/Reassign constraint outcomes deterministic**

Keep Start's transaction/advisory lock and site-scoped assigned lookup. After A→B reassignment, A creates a new A-assigned session without changing the old row's starter or events. If reassignment targets an employee who already owns ACTIVE work at the same site, catch only the expected active-assignee uniqueness violation and return HTTP 409 with novice-friendly direction to finish or reassign that existing count. Do not convert unrelated uniqueness failures into this response.

- [ ] **Step 5: Restore narrow legacy site-less Cancel**

Before the site-scoped `requireCountWriter` path, handle `siteId === null` in a transaction mirroring legacy Finish:

1. Lock the exact site-less session row `FOR UPDATE`.
2. Require current status ACTIVE.
3. Require `isCurrentCountAssignee` (explicit assignee or null-assignment starter fallback).
4. Recheck that the actor is active under a SHARE lock.
5. Reject approved discrepancy adjustments if any.
6. Update only `{ id, siteId: null, status: "ACTIVE" }` to CANCELLED.

Return 404 for an inaccessible/non-starter preflight, 403 for an authorized preflight actor who is not the current legacy assignee, and 409 for stale terminal state. Do not enable site-less scanning.

- [ ] **Step 6: Run focused HTTP tests and record GREEN**

Run:

```bash
npm --workspace @continuixai/api test -- inventoryTruthFinal.http.test.ts inventoryTruthDiscovery.http.test.ts inventoryTruth.http.test.ts
```

Expected: all pass with the new Start, reassignment-conflict, and legacy Cancel cases.

- [ ] **Step 7: Correct the PostgreSQL validator fixtures**

In `inventoryTruthFinalDbValidation.ts`:

- For positive opening stock, create RECEIVE with the real fixture `locationId`.
- For a zero-baseline composition parent, create the Product but no zero-quantity ledger event.
- Do not create two ACTIVE sessions with the same assigned employee at one site unless the assertion is explicitly testing rejection.
- Add a real migrated-database A→B handoff followed by A Start. Assert both sessions remain, the original starter/history is unchanged, and the new session is assigned to A.
- Exercise one accepted null-location COUNT_ADJUSTMENT and one rejected null-location RECEIVE without weakening the trigger.
- Use a genuinely changed PATCH quantity and assert both stored quantity and actor.
- Ensure every fixture that is no longer needed is completed/cancelled before reusing its employee/site, or provision an independent employee/site for a simultaneous schedule.

- [ ] **Step 8: Run local schema and validator gates**

Run:

```bash
npx prisma validate --schema apps/api/prisma/schema.prisma
npx prisma generate --schema apps/api/prisma/schema.prisma
npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck --types @fastify/jwt apps/api/scripts/inventoryTruthFinalDbValidation.ts apps/api/src/types/fastify.d.ts
npm --workspace @continuixai/api test -- inventoryTruthFinal.http.test.ts inventoryTruthDiscovery.http.test.ts inventoryTruth.http.test.ts inventoryTruthReview.http.test.ts
npm --workspace @continuixai/api run build
npm --workspace @continuixai/api run lint
```

Expected: every command exits 0. If a disposable local PostgreSQL 17 service is unavailable, record that as an external execution gate; do not describe type-checking or PGlite as equivalent concurrency evidence.

- [ ] **Step 9: Run complete local regression gates**

Run:

```bash
npm test
npm run build
npm run lint
npm audit --omit=dev --audit-level=high
git diff --check
```

Expected: all tests/builds/lints pass, audit reports zero high-or-greater vulnerabilities, and the diff check is clean.

- [ ] **Step 10: Commit the verified remediation**

```bash
git add .github/workflows/ci.yml apps/api/prisma/migrations/20260916090000_count_assignment_ledger_integrity/migration.sql apps/api/src/routes/storeCount.ts apps/api/src/routes/inventoryTruth.ts apps/api/src/routes/inventoryTruthFinal.http.test.ts apps/api/scripts/inventoryTruthFinalDbValidation.ts docs/superpowers/plans/2026-09-16-postgresql-remediation.md
git commit -m "fix: close inventory truth PostgreSQL gates"
```

Do not add unchanged files. Report the exact RED/GREEN commands, counts, commit, unresolved PostgreSQL execution gate, and concerns.
