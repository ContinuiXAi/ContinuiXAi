# Task 1: Store Count Export Tenant Bypass

## Root cause

`GET /sessions/:id/export.csv` loaded a count session by ID before applying authorization. Its follow-up guard skipped all membership checks for `ADMIN`, allowing a global admin from another tenant to download a tenant's CSV. Other denials returned `403`, which also revealed that the session existed.

## Changes

- `apps/api/src/routes/storeCountExport.ts`
  - Replaced the unscoped `findUnique` plus role bypass with an authorization-scoped `findFirst`.
  - A site-backed session now requires an active user, organization, organization membership, site, and site membership for the authenticated user.
  - Legacy site-less sessions remain available only to their active owner.
  - Missing and unauthorized sessions both return `404 { error: "count session not found" }`.
- `apps/api/src/routes/storeCountExport.http.test.ts`
  - Added route-level HTTP coverage for unauthenticated, inactive-user, inactive-membership, cross-tenant, wrong-site, authorized counter/manager, and legacy owner/non-owner cases.
  - Retains CSV escaping and quantity-total assertions on authorized downloads.

## RED evidence

Command:

```sh
npm run test -w apps/api -- --run src/routes/storeCountExport.http.test.ts
```

Before the fix, the cross-tenant global-admin request returned `200`; the new regression expected `404` and failed with `expected 200 to be 404`.

## GREEN evidence

```sh
npm run test -w apps/api -- --run src/routes/storeCountExport.http.test.ts src/routes/storeCountExport.test.ts
# 2 files passed, 11 tests passed

npm run build -w apps/api
# passed

npm run lint -w apps/api
# passed
```

`git diff --check` also passed during self-review.

## Commit

`fix: enforce tenant scope on count exports` (the commit containing this report).

## Concerns

No known blockers. The authorization check is enforced in the database lookup, but these route-level tests use a Prisma mock rather than a live database.
