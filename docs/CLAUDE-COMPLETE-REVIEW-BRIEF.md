# Claude Adversarial Review Brief — Continuixai Ops

## September 2026 authenticator hardening review boundary

Review only the exact draft-PR head SHA supplied with this brief. SMS/Twilio is abandoned and must not be reintroduced. The candidate retains password → authenticator-app TOTP → revocable session, using OTPAuth for standards-based TOTP.

Explicitly attempt to defeat: production registration denial; populated multi-site membership backfill; cross-organization site administration; replayed setup challenges; reuse/concurrent reuse of an accepted TOTP counter or backup code; JWT and media-token reuse after logout, password reset, MFA reset, or deactivation; administrator cross-tenant/self MFA reset; sole-admin break-glass auditing; unknown-user timing equalization; and API/web build-SHA identification. Confirm migrations against fresh and representative populated PostgreSQL databases. A green CI result is necessary but not a security verdict.

## Mission

Treat this repository as hostile input and try to prove that Continuixai Ops is **not** ready for a controlled pilot. Do not optimize for politeness. Find reproducible failures, security weaknesses, data-integrity risks, race conditions, confusing frontline UX, and gaps between code and stated behavior.

Do not make broad refactors first. Reproduce findings, identify root cause, and cite exact files/routes/tests. Rank every finding **Critical / Important / Minor** and separate proven defects from hypotheses.

## Product identity

- Company: **Continuixai**
- Application: **Continuixai Ops**
- Employee workspace: **My Work**
- Manager workspace: **Team Work**
- Inventory counting capability: **Count**
- `Complete assigned Store Scan` is allowed only as an assignable daily operational task name. It is not the application/product/navigation/report identity.

Legacy route paths, migration names, storage keys, webhook header names, or repository slugs may remain when changing them would break compatibility. Flag any *user-visible* legacy product branding.

## Core architecture to challenge

Continuixai Ops is a tenant-scoped operational-work application with a separate counting subsystem. Authenticated organization/site membership is the authority for tenant scope. Client-supplied organization/site IDs must never be trusted to broaden access.

Task templates generate assignment snapshots. Historical assignments must not change when a template changes. Assignment status/reassignment history is append-only. Recurring assignment generation must be idempotent. Site-local timezone is authoritative for daily work, due times, overdue state, daily summaries, and reporting boundaries.

The count workflow must remain usable by phone camera and keyboard-wedge handheld scanners. Completed count sessions must not become silently editable through unrelated task work.

## Adversarial attack matrix

### 1. Tenant isolation

Attempt cross-organization and cross-site reads/writes for:

- products and barcodes;
- store locations;
- count sessions, entries, exceptions, and exports;
- task templates;
- task assignments and notes;
- task events;
- reports and CSV exports;
- employee job-title updates.

Try guessed IDs from another tenant in URL params and request bodies. Verify every write derives scope from authenticated membership. Look for `findUnique` / `update` / `delete` calls that skip organization/site qualification before mutation.

### 2. Authorization

Try employee credentials against every manager endpoint:

- `/api/tasks/employees`
- `/api/tasks/team`
- `/api/tasks/templates*`
- `/api/tasks/assignments*`
- `/api/tasks/users/:id/job-title`
- `/api/tasks/reports*`

Try a manager from Organization A against employee/task IDs from Organization B. Try a disabled membership and inactive user. Verify employees can modify only their own assignments and cannot reopen completed work.

### 3. Recurrence and idempotency

Hammer assignment materialization concurrently for the same employee/date/template. Confirm exactly one assignment exists. Repeat My Work and Team Work requests many times. Test daily, weekly, and monthly boundaries, end dates, February, leap years, monthly day 29/30/31, DST transitions, and site timezones far from UTC.

Verify manager Team Work materializes current/future recurring work for active employees even before those employees open My Work.

### 4. Rollover behavior

For stale OPEN and IN_PROGRESS tasks test:

- `REMAIN_OVERDUE` stays visible and keeps original scheduled date;
- `ROLL_FORWARD` remains actionable without rewriting historical scheduled date;
- `SKIP` becomes SKIPPED once and records one audit event.

Try repeated/concurrent auto-skip runs and check for duplicate or contradictory events.

### 5. Historical integrity

Edit/deactivate a template after assignments exist. Verify existing assignments preserve snapshotted title, instructions, job title, recurrence, priority, rollover policy, scheduled date, and due timestamp.

Complete, reopen, skip, cancel, note, and reassign tasks. Verify event history records actor and before/after status. For reassignment, verify previous and new assignee IDs are reconstructable. Attempt direct UPDATE/DELETE against `TaskAssignmentEvent`; database triggers should reject mutation.

### 6. Timezone correctness

Use at least America/New_York, America/Los_Angeles, Europe/London, Asia/Tokyo, and Pacific/Auckland. Test around local midnight and DST changes.

Verify:

- greeting matches site-local hour;
- My Work `date` matches site local date;
- dueAt is derived correctly;
- “Completed today” does not disappear because completedAt crosses a UTC date boundary;
- Daily Summary uses the same local day;
- daily/weekly/monthly reports use site-local boundaries;
- manager create/report forms initialize to the site date, not browser UTC date.

### 7. Race conditions

Use concurrent requests for:

- first admin/bootstrap;
- recurring assignment generation;
- starter-library install;
- employee completion vs manager cancellation/reassignment;
- two managers editing/reassigning the same task;
- count completion vs late count entry submission;
- offline queue replay after a retry/timeout.

Look for lost updates, duplicate assignments, duplicate count entries, and audit events that claim a state transition that did not actually win.

### 8. Count correctness

Try duplicate scans, rapid scans, same UPC in different locations, unknown UPCs, reconnect/retry, simultaneous employees, and completed-session mutation. Confirm quantities reconcile exactly with the source scan actions and that retries do not duplicate committed work.

Test both camera-style sequential scanning and keyboard-wedge input. Validate barcode normalization does not merge distinct valid codes.

### 9. Offline/retry behavior

Simulate network failure:

- before request dispatch;
- after server commit but before response reaches client;
- during a burst of scans;
- while navigating away/reloading;
- during service-worker update.

Replay queued operations repeatedly. The system must not lose or duplicate count work. Verify user-specific cached API data is cleared on logout.

### 10. Frontline usability

Use a narrow phone viewport and a tablet/desktop viewport. Attempt the full employee flow with one hand:

sign in → My Work → start task → note → complete → Count when assigned → Daily Summary → sign out.

Try long task titles/instructions, 50+ tasks, urgent overdue work, slow network, API errors, no job title, no starter library, and no count task. Buttons must remain reachable and state changes must provide understandable feedback.

### 11. Manager usability

Test Team Work on phone, tablet, and desktop. Create/edit/deactivate templates, assign job titles, create one-time work, reassign/complete/reopen/skip/cancel, review history, change report period/date, and export CSV.

Check that no control silently changes another employee/site and that date forms use the site-local date.

### 12. Pharmacy privacy

Verify pharmacy starter work and My Work UI warn users not to enter patient names, prescriptions, diagnoses, dates of birth, or other PHI in task notes. Search for any new feature that encourages PHI storage. Do not use real patient data during testing.

### 13. Authentication and recovery

Attack Employee Number/email login, password policy, recovery flows, MFA/TOTP, backup codes, JWT/session invalidation, logout-everywhere, production secret validation, rate limits, and account enumeration. Confirm MFA issuer is Continuixai Ops and secrets are never logged or returned.

### 14. Branding and compatibility

Search user-facing source and generated metadata for obsolete product identity. Navigation, manifest, page metadata, auth copy, service-worker notification defaults, manager reports, and errors should say Continuixai Ops or Count as appropriate.

Do **not** recommend renaming a legacy route/storage/header solely for aesthetics if that would break installed clients. Distinguish compatibility identifiers from visible branding.

### 15. Migration safety

Apply all migrations to:

1. a fresh empty database;
2. a representative pre-task database;
3. a database containing legacy task assignments.

Verify backfills, nullability assumptions, foreign keys, tenant-scope triggers, append-only task-event triggers, indexes, and Prisma schema match. Test rollback/recovery strategy even if migrations are forward-only.

## Required verification commands

Run in a network-enabled clean checkout:

```bash
npm ci
npm run prisma:generate
npm test
npm run lint
npm run build
node scripts/test-task-workflow-pure.cjs
node scripts/test-task-schedule-pure.cjs
node scripts/verify-task-route-contract.cjs
node scripts/test-starter-task-catalog.cjs
node scripts/test-task-presentation-pure.cjs
node scripts/verify-work-ui-contract.cjs
node scripts/verify-continuixai-branding.cjs
node scripts/verify-continuixai-readiness.cjs
node scripts/transpile-check.cjs
```

Also run any existing tenant-integrity, count-integrity, security, and migration verification scripts in `scripts/` and the repository CI workflow.

## Pilot stop conditions

Recommend **NO-GO** if any of these remain:

- cross-tenant data exposure or mutation;
- employee access to manager-only actions;
- duplicate/lost count operations under normal retry behavior;
- duplicate recurring assignments;
- historical task events can be edited/deleted;
- completed count records can be silently altered;
- migration failure on supported upgrade path;
- timezone bug changes which day work belongs to;
- critical mobile flow is unusable;
- production build/tests are not green.

## Deliverable format

Return:

1. **Verdict:** GO / CONDITIONAL GO / NO-GO.
2. **Critical findings** with exact reproduction and code location.
3. **Important findings** with exact reproduction and code location.
4. **Minor findings**.
5. **Tests you added** and why they fail/pass.
6. **Security/tenant isolation assessment**.
7. **Data-integrity/race assessment**.
8. **Mobile/manager UX assessment**.
9. **Migration assessment**.
10. **Exact conditions required before pilot**.

Do not give a GO because the code “looks good.” Require evidence.

## Round 2 remediation-specific attacks

Round 1 found deployment failures, one-time assignment retry duplication, unsynced Count loss on auth invalidation, inherited non-pilot routes, site-isolation fragility, skipped-task invisibility, UTC manager date seeding, missing reassignment UI, nonportable verification scripts, and a manager-nav heuristic. The current archive claims to address those findings. Re-test each claim from first principles; do not accept source-contract scripts as substitutes for HTTP/DB/browser evidence.

The supported pilot surface is auth/MFA, My Work, Team Work, Daily Summary/reporting, Products, Store Locations, Count, and basic account settings. Non-pilot inherited routes must be unreachable with the default environment. If enabling `ENABLE_LEGACY_INVENTORY_FEATURES=true` changes that, treat those features as explicitly out of pilot scope rather than silently approved.
