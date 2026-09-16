# Authenticator Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the confirmed access-control and authenticator/session vulnerabilities without SMS or paid verification services, then produce an exact-SHA candidate for independent review.

**Architecture:** Production self-registration fails closed while administrators provision accounts. Corrective PostgreSQL migrations preserve existing multi-site access and add state for TOTP replay prevention and revocable server-side sessions. Authenticator enrollment and all protected routes validate versioned, revocable credentials; administrators receive scoped site-assignment and MFA-reset controls; API/web expose build identity.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, Next.js/React, Vitest, GitHub Actions, Railway.

**Spec:** `docs/superpowers/specs/2026-09-07-authenticator-security-hardening-design.md`

## Global Constraints

- Retain authenticator-app TOTP/QR MFA.
- Do not add or enable SMS, Twilio, SendGrid, or another paid verification dependency.
- Derive from `581ee3c277c3ce1b9580e6b5a6c3ab0fc2a3ee90`; closed PR #20 remains unmerged.
- Do not deploy or merge before full verification and independent Claude review.
- Preserve existing Store Count atomicity, idempotency, offline queue, and tenant/site boundaries.

---

### Task 1: Fail-closed production registration

**Files:**
- Modify: `.env.example`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/index.auth.test.ts`
- Modify: `apps/web/app/register/page.tsx`
- Create: `apps/web/lib/publicRegistration.test.ts`

**Interfaces:**
- Produces: `isPublicRegistrationEnabled(): boolean`, true only for explicit `PUBLIC_REGISTRATION_ENABLED=true` outside production or explicit production enablement.
- Produces: `GET /api/auth/registration-status -> { enabled: boolean }`.

- [ ] Add API tests that set `NODE_ENV=production`, omit the flag, and expect `POST /register` to return 403 without calling `prisma.user.create`.
- [ ] Add tests proving an explicit enabled test environment retains the existing registration behavior.
- [ ] Implement the shared flag resolver and status endpoint; gate `POST /register` before parsing or database access.
- [ ] Update the registration page to query registration status and show “Ask an administrator to create your account” when disabled.
- [ ] Run `npm test -w apps/api -- src/index.auth.test.ts` and `npm test -w apps/web -- publicRegistration.test.ts`.
- [ ] Commit with `fix: disable public registration by default`.

### Task 2: Preserve multi-site access and add scoped assignments

**Files:**
- Create: `apps/api/prisma/migrations/20260908100000_site_membership_backfill_remediation/migration.sql`
- Create: `apps/api/src/routes/siteMemberships.ts`
- Create: `apps/api/src/routes/siteMemberships.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/scripts/storeCountSiteAuthorizationValidation.ts`
- Modify: `apps/web/app/users/page.tsx`
- Modify: `apps/web/lib/types.ts`
- Modify: `apps/web/lib/i18n/translations.ts`
- Create: `apps/web/lib/siteAssignments.test.ts`

**Interfaces:**
- Produces: `GET /api/site-memberships/users/:userId` returning authorized sites within the administrator's organizations.
- Produces: `PUT /api/site-memberships/users/:userId` accepting `{ siteIds: string[] }` and idempotently activating/deactivating scoped memberships.

- [ ] Extend PostgreSQL validation with a populated organization containing two active sites and an active organization member with zero site memberships; expect two memberships after migration.
- [ ] Write route tests for listing, replacing, idempotent replacement, empty selection rejection, and cross-organization user/site rejection.
- [ ] Implement a corrective `INSERT ... SELECT` migration for every active organization membership × active site, after the already-shipped migration.
- [ ] Implement scoped membership routes using a transaction and unique `(siteId,userId)` upserts.
- [ ] Add administrator UI checkboxes for each user's scoped sites and a Save action; keep platform-admin access derived server-side.
- [ ] Run focused API/web tests and the PostgreSQL site-authorization validation.
- [ ] Commit with `fix: preserve and manage multi-site access`.

### Task 3: Make authenticator setup and TOTP codes non-replayable

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260908110000_totp_replay_state/migration.sql`
- Modify: `apps/api/src/lib/mfa.ts`
- Modify: `apps/api/src/lib/mfa.test.ts`
- Modify: `apps/api/src/routes/mfa.ts`
- Modify: `apps/api/src/routes/mfa.http.test.ts`

**Interfaces:**
- Produces: `findTotpCounter(secret: string, code: string, now?: number): number | null`.
- Adds: `User.mfaLastTotpCounter Int?`.

- [ ] Write unit tests returning the exact accepted counter for current and drifted codes and null for invalid codes.
- [ ] Write HTTP tests proving `/mfa/setup` rejects an already-enrolled user and a confirmed setup challenge cannot be reused.
- [ ] Write a transaction test proving the same TOTP counter cannot authenticate twice, including concurrent requests.
- [ ] Implement counter-returning verification with timing-safe comparisons.
- [ ] Update confirmation to atomically enable MFA, store the accepted counter, increment token version, and issue a session from the updated version.
- [ ] Update login verification to atomically accept only a counter greater than `mfaLastTotpCounter`.
- [ ] Run focused MFA tests.
- [ ] Commit with `fix: prevent authenticator challenge replay`.

### Task 4: Add revocable sessions and complete logout/media revocation

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260908120000_user_sessions/migration.sql`
- Create: `apps/api/src/lib/sessionService.ts`
- Create: `apps/api/src/lib/sessionService.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/mfa.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/lib/mediaAuth.ts`
- Modify: `apps/api/src/lib/mediaAuth.test.ts`
- Modify: `apps/api/src/types/fastify.d.ts`

**Interfaces:**
- Adds: `UserSession { id, userId, tokenVersion, createdAt, expiresAt, revokedAt }`.
- Produces: `createUserSession(userId, tokenVersion, expiresAt): Promise<UserSession>`.
- Produces: `isSessionActive(sessionId, userId, tokenVersion): Promise<boolean>`.
- Produces: `revokeSession(sessionId): Promise<void>` and `revokeAllUserSessions(userId): Promise<void>`.
- JWTs carry `sid`; media tokens carry `sid` and `tv`.

- [ ] Write tests for session creation, expiry, single-session revocation, all-session revocation, and mismatched user/version.
- [ ] Write auth tests proving logout invalidates the current JWT and logout-all/password/MFA reset invalidate all JWTs.
- [ ] Write media tests proving stale cookie and Bearer tokens fail after token-version/session revocation.
- [ ] Add the session model and migration with indexes on `(userId, revokedAt)` and `expiresAt`.
- [ ] Require `sid`, current token version, and active session in `app.authenticate`.
- [ ] Issue sessions only after successful MFA; revoke the current session on logout and all sessions on global security changes.
- [ ] Include and validate `sid`/`tv` in media cookies and Bearer fallback.
- [ ] Run focused auth/session/media tests.
- [ ] Commit with `fix: revoke authenticated sessions reliably`.

### Task 5: Add administrator recovery controls and auditability

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/index.auth.test.ts`
- Create: `apps/api/scripts/resetBootstrapAdminMfa.ts`
- Create: `apps/api/scripts/resetBootstrapAdminMfa.test.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/web/app/users/page.tsx`
- Modify: `apps/web/lib/i18n/translations.ts`
- Create: `apps/web/lib/adminMfaReset.test.ts`
- Modify: `docs/CLAUDE-READY-HANDOFF.md`

**Interfaces:**
- Existing: `POST /api/auth/users/:id/reset-mfa` becomes organization-scoped and returns `{ ok: true }` after session revocation.
- Produces: `npm run admin:mfa-reset -- --email <email> --reason <text>` requiring an explicit reason and writing a security audit event.

- [ ] Add route tests for successful scoped reset, self-reset refusal, foreign-organization refusal, session revocation, and cleared replay counter.
- [ ] Add script tests for unique administrator resolution, reason requirement, secret/code clearing, session revocation, and audit event creation.
- [ ] Harden the existing endpoint and add a clearly labeled Reset Authenticator button with confirmation.
- [ ] Implement the operator-only break-glass script without printing credentials or secrets.
- [ ] Document recovery-code retention and the break-glass command.
- [ ] Run focused API/web/script tests.
- [ ] Commit with `feat: add safe authenticator recovery`.

### Task 6: Remove timing enumeration and recovery nuisance amplification

**Files:**
- Create: `apps/api/src/lib/credentialTiming.ts`
- Create: `apps/api/src/lib/credentialTiming.test.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/index.auth.test.ts`

**Interfaces:**
- Produces: `comparePasswordOrDummy(value: string, hash?: string | null): Promise<boolean>`.
- Produces: `compareRecoveryPinOrDummy(value: string, hash?: string | null): Promise<boolean>`.

- [ ] Add mocked-path tests proving bcrypt comparison executes exactly once for found and missing identifiers.
- [ ] Add tests proving unknown identifiers never update another user's recovery lockout counters.
- [ ] Implement process-lifetime dummy hashes generated at startup and constant-work comparison helpers.
- [ ] Use the helpers in login and recovery routes while preserving generic responses and rate limits.
- [ ] Run focused timing/auth tests.
- [ ] Commit with `fix: equalize authentication failure work`.

### Task 7: Expose verifiable build identity

**Files:**
- Create: `apps/api/src/lib/buildInfo.ts`
- Create: `apps/api/src/lib/buildInfo.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/Dockerfile`
- Create: `apps/web/components/BuildMarker.tsx`
- Create: `apps/web/lib/buildMarker.test.ts`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/Dockerfile`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/docker-release.yml`

**Interfaces:**
- Produces: `resolveBuildSha(env): string` preferring `BUILD_SHA`, then `RAILWAY_GIT_COMMIT_SHA`, else `unknown`.
- Changes: `GET /health -> { status: "ok", buildSha: string }`.
- Web displays `NEXT_PUBLIC_BUILD_SHA` in an unobtrusive build marker.

- [ ] Write resolver and rendering tests for known and unknown SHA values.
- [ ] Add API health response and web build marker.
- [ ] Pass exact GitHub SHA into both Docker builds and record it in CI output.
- [ ] Run focused tests and both production builds.
- [ ] Commit with `feat: expose exact deployment build`.

### Task 8: Full verification and review candidate

**Files:**
- Modify: `docs/CLAUDE-COMPLETE-REVIEW-BRIEF.md`
- Modify: `docs/RETAIL_COUNT_MVP_ACCEPTANCE.md`

**Interfaces:**
- Produces one exact commit SHA and a review brief that excludes SMS and targets every fixed regression.

- [ ] Run `npm ci` from a clean dependency state.
- [ ] Run `DATABASE_URL=postgresql://continuixai_ops:continuixai_ops@localhost:5432/continuixai_ops npm run prisma:generate -w apps/api`.
- [ ] Run `npm test`, `npm run lint`, `npm run build`, and `npm audit --omit=dev --audit-level=high`.
- [ ] Run fresh and populated PostgreSQL migration/schema validation, including multi-site upgrade, Store Count route, tenant/site rejection, atomicity, and idempotency scripts.
- [ ] Update acceptance and Claude-review documents with exact commands, remaining physical iPhone/Windows tests, and no unsupported completion claims.
- [ ] Confirm `git status --short` is clean and record `git rev-parse HEAD`.
- [ ] Push the branch and open a draft PR against `chatgpt-development`; do not merge or deploy.
- [ ] Submit the exact SHA and evidence to Claude for adversarial review.
