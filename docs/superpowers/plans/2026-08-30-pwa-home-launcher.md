# ContinuiXai PWA Home Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing ContinuiXai PWA into a simple authenticated Home launcher that users can open from an iPhone Home Screen, authenticate with existing MFA, and enter Count, My Work, Products, or Locations with one tap.

**Architecture:** Keep the existing Next.js PWA and authentication system. Replace the root redirect with an authenticated launcher page and change successful MFA redirects from `/store-count` to `/`; do not change Count, API, database, or authorization semantics.

**Tech Stack:** Next.js/React/TypeScript, existing AuthProvider, existing PWA service worker/metadata, Node 24 CI, PostgreSQL validation.

**Spec:** `docs/superpowers/specs/2026-08-30-pwa-home-launcher-design.md`

## Global Constraints
- Existing password + MFA security remains mandatory and unchanged.
- No new database schema or API endpoint is required.
- No second session/token store.
- Existing Count/scanner/offline behavior must not regress.
- Mobile-first, touch-friendly, and desktop-compatible.
- ContinuiXai branding only.
- Merge only after exact-head full CI is green; verify post-merge CI and production deployment.
- Claude independent review remains a completion gate.

---

### Task 1: Regression contract for Home and auth routing

**Files:**
- Create: `scripts/test-pwa-home-launcher.mjs`
- Modify: `package.json` only if a named script is needed by existing project conventions.

**Interfaces:**
- Consumes: `apps/web/app/page.tsx`, `apps/web/app/login/page.tsx`.
- Produces: deterministic source-level regression gate covering Home launcher routes, greeting implementation, and MFA redirect target.

- [ ] **Step 1: Write the failing regression test**

Create a Node script that reads the two source files and asserts:
- root page no longer contains `redirect("/my-work")`;
- root page contains routes `/store-count`, `/my-work`, `/products`, `/locations`;
- root page derives the greeting from the authenticated user's name and local hour rather than containing `Mitchell` as a literal;
- both successful login paths in `login/page.tsx` call `router.push("/")`;
- login no longer calls `router.push("/store-count")`.

- [ ] **Step 2: Run the regression test and verify RED**

Run: `node scripts/test-pwa-home-launcher.mjs`
Expected: FAIL because current root redirects to `/my-work` and login redirects to `/store-count`.

- [ ] **Step 3: Commit the RED test**

Commit message: `test: define PWA home launcher contract`

---

### Task 2: Implement authenticated Home launcher

**Files:**
- Modify: `apps/web/app/page.tsx`
- Test: `scripts/test-pwa-home-launcher.mjs`

**Interfaces:**
- Consumes: `useAuth()`, existing `BrandLockup`, Next.js `Link`, existing CSS variables.
- Produces: authenticated root Home page with personalized greeting and four launch routes.

- [ ] **Step 1: Implement minimal Home page**

Convert the root page to a client component. Resolve auth through `useAuth()`. While loading, render a branded connecting state. If unauthenticated, `router.replace("/login")`. For authenticated users, split the existing user display name on whitespace and use the first non-empty token. Derive daypart using `new Date().getHours()` with morning `< 12`, afternoon `< 17`, otherwise evening. Render `Good {daypart}, {firstName} — ready to start working?`.

Render four large links:
- Count → `/store-count`
- My Work → `/my-work`
- Products → `/products`
- Locations → `/locations`

Use existing design tokens and responsive CSS/grid behavior. Do not change feature pages.

- [ ] **Step 2: Run launcher regression test**

Run: `node scripts/test-pwa-home-launcher.mjs`
Expected: still FAIL only on auth redirect until Task 3, or PASS for Home-specific assertions.

- [ ] **Step 3: Run web type/build checks available locally/CI**

Expected: no TypeScript/Next.js errors introduced by Home.

- [ ] **Step 4: Commit**

Commit message: `feat: add personalized ContinuiXai home launcher`

---

### Task 3: Route successful MFA to Home

**Files:**
- Modify: `apps/web/app/login/page.tsx`
- Test: `scripts/test-pwa-home-launcher.mjs`

**Interfaces:**
- Consumes: existing `login(token)` and MFA challenge/enrollment flows.
- Produces: successful verification and enrollment both end at `/`.

- [ ] **Step 1: Change only the two successful redirect targets**

In `verifyMfa`, after `await login(data.token)`, change `router.push("/store-count")` to `router.push("/")`.
In `finishEnrollment`, after `await login(pendingToken)`, make the same change.
Do not alter MFA setup, verification, backup-code handling, API calls, or tokens.

- [ ] **Step 2: Run launcher regression test**

Run: `node scripts/test-pwa-home-launcher.mjs`
Expected: PASS.

- [ ] **Step 3: Run existing auth tests**

Run the repository's existing test command/CI test job.
Expected: PASS.

- [ ] **Step 4: Commit**

Commit message: `feat: land authenticated users on ContinuiXai home`

---

### Task 4: PWA and mobile regression verification

**Files:**
- Verify: `apps/web/app/layout.tsx`
- Verify: `apps/web/app/register-sw.tsx`
- Verify: manifest/icon/service-worker files already present in web public/app structure.
- Modify only if an existing PWA artifact incorrectly launches somewhere other than `/` or has stale non-ContinuiXai identity.

**Interfaces:**
- Consumes: existing PWA metadata/service worker.
- Produces: installed Home Screen app launches the root flow with current ContinuiXai identity.

- [ ] **Step 1: Inspect PWA metadata and start URL**

Confirm Apple web-app capability/title/icon, service-worker registration, manifest start URL `/`, display mode appropriate for standalone use, and ContinuiXai naming.

- [ ] **Step 2: Add a regression assertion for any corrected PWA artifact**

If a correction is required, add the failing assertion before the production edit and observe RED.

- [ ] **Step 3: Make only required PWA corrections**

No native wrapper, App Store dependency, or second build pipeline.

- [ ] **Step 4: Run launcher/PWA regression test**

Expected: PASS.

- [ ] **Step 5: Commit if files changed**

Commit message: `fix: align installed PWA with ContinuiXai home`

---

### Task 5: Full CI and security review

**Files:**
- No production files unless a test reveals a defect.

**Interfaces:**
- Consumes: exact feature branch head.
- Produces: durable verification evidence.

- [ ] **Step 1: Push/commit exact feature head and open PR to `chatgpt-development`**

PR body must list design/spec, security non-goals, test commands, and manual gates.

- [ ] **Step 2: Run full GitHub CI**

Required jobs: build, test, lint/security audit, database-validation.
Expected: all SUCCESS.

- [ ] **Step 3: Inspect exact PR diff**

Verify no database, Count persistence, tenant authorization, MFA API, token, or Railway configuration changes slipped into the PR.

- [ ] **Step 4: Re-run/retest if any correction is made**

Any correction creates a new exact head SHA and requires full CI again.

---

### Task 6: Merge, deploy verification, and physical iPhone acceptance

**Files:**
- No source changes unless acceptance exposes a defect; defects return to RED/GREEN workflow on a repair branch.

**Interfaces:**
- Consumes: exact green PR head.
- Produces: verified merged/deployed application and manual device evidence.

- [ ] **Step 1: Merge only the exact green PR head into `chatgpt-development`**

Use expected-head protection; no force push.

- [ ] **Step 2: Verify post-merge CI on the merge commit**

Expected: build, test, lint/security, database-validation all SUCCESS.

- [ ] **Step 3: Verify Railway deployment corresponds to the merged build**

Do not infer deployment from GitHub alone. Confirm production service deployment evidence.

- [ ] **Step 4: Install/open ContinuiXai from iPhone Home Screen**

Acceptance: app opens as the ContinuiXai installed experience without requiring the user to locate a Safari tab.

- [ ] **Step 5: Authenticate**

Acceptance: sign-in → MFA → personalized Home launcher.

- [ ] **Step 6: Verify all four launch buttons**

Acceptance: Count, My Work, Products, Locations each open the correct existing feature and allow return to Home/navigation without confusion.

- [ ] **Step 7: Re-run critical Count device path**

Acceptance: camera permission, known UPC scan, quantity behavior, unknown UPC, location context, offline/reconnect/resume, completion lock, and CSV reconciliation remain correct according to the existing retail Count acceptance contract.

---

### Task 7: Independent Claude adversarial gate

**Files:**
- Review: exact final merge SHA, design spec, implementation plan, PR diff, CI evidence, production/device evidence.

**Interfaces:**
- Consumes: final verified evidence bundle.
- Produces: independent GO/CONDITIONAL/NO-GO assessment.

- [ ] **Step 1: Provide Claude the exact evidence, not a stale archive**

Ask Claude specifically to challenge authentication/MFA routing, unauthorized Home access, tenant/site isolation, PWA install/launch behavior, Count regression risk, offline behavior, and mobile usability.

- [ ] **Step 2: Treat any Critical/High finding as a release blocker**

Fix through TDD, rerun full CI, redeploy, and repeat affected manual acceptance.

- [ ] **Step 3: Completion declaration**

Call the PWA Home experience complete only after exact-head CI, post-merge CI, production deployment, iPhone acceptance, Count regression acceptance, and Claude review have all produced supporting evidence.
