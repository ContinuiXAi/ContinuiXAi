# Retail Count MVP — Pilot Acceptance Contract

Physical-device acceptance is **NOT RUN**. Use the repository-tracked [physical pilot acceptance packet](PHYSICAL-PILOT-ACCEPTANCE.md) to record the controlled iPhone, Android, and keyboard-wedge scanner evidence; it replaces reliance on the external stale worksheet. Automated verification does not replace that hardware/manual acceptance.

## Objective
Ship a focused retail inventory-counting application that can be piloted in a real store before expanding the broader operations platform.

The same counting workflow must support:
1. Dedicated Android barcode handhelds that send scans as keyboard input.
2. Android phones using the device camera.
3. iPhones using the device camera.

Walgreens-style retail operations are the workflow reference only. Do not use proprietary Walgreens data or imply affiliation.

## Pilot workflow
Sign in → select site/store → start or resume count → select zone/location → scan UPC → increment quantity or enter quantity → handle unknown UPC → continue through zones → submit for review → supervisor reviews variances/exceptions → complete/lock count → export results.

## Scope lock
Until this contract passes, do not expand the pilot into purchasing, receiving, repacking, freight, EDI, QuickBooks, or other end-to-end modules.

## Required capabilities

### Catalog
- Import a retail test catalog by CSV.
- Required minimum fields: UPC, description, brand/manufacturer where available, package size, category/department.
- UPC is searchable/scannable but remains an identifier, not the database primary key.
- Unknown UPCs must be captured as exceptions without losing the scan.

### Count sessions
- Full physical count and cycle/zone count concepts must be distinguishable.
- Resume an active session after app/browser/device interruption.
- Multiple counters may work simultaneously without lost increments.
- Completed counts are immutable; corrections require an auditable follow-up action rather than silently editing history.

### Locations/zones
- Counts are tied to a site and a physical counting location/zone.
- The same product may be counted in multiple locations and rolled into a site total.
- Counter must always be able to see the active location before scanning.

### Scan behavior
- Hardware keyboard-wedge scanner input works without requiring a Zebra-specific SDK.
- Camera scanning is available for iOS/Android phone use.
- Each successful scan provides immediate visible feedback and, where supported, audible/haptic feedback.
- Repeated scans of the same UPC increment predictably.
- Manual quantity entry is available for facings/multiple identical units.
- Accidental retries/network retries cannot double-post the same logical scan.

### Offline/resilience
- A temporary loss of connectivity must not destroy already captured count work.
- Pending scans must have unique client-generated idempotency keys.
- Pending work must visibly show unsynced/syncing/failed state.
- Reconnection must safely retry without double counting.
- App refresh/restart must recover pending work from durable local storage where the platform permits it.

### Review and completion
- Review shows UPC, description, location, counted quantity and exceptions.
- If an expected/system quantity is supplied, show expected, counted and variance without biasing a blind count unless configured.
- Supervisor can require recount/review before completion.
- Completion is explicit and cannot happen accidentally.
- Completed session can be exported to CSV with site, session, counter/audit metadata, UPC, description, location, quantity and timestamps.

### Security/accountability
- Authenticated users only.
- Site/organization boundaries enforced server-side.
- Counter and supervisor actions are attributable to a user.
- No client-supplied organization/site identifier may bypass membership checks.

## Required automated verification
- Existing migration/schema-diff gate remains green.
- Existing Postgres Store Count atomic/idempotency validation remains green.
- Existing real HTTP Store Count route validation remains green.
- Add tests for simultaneous counters on the same UPC/location.
- Add tests for retrying the same idempotency key.
- Add tests for cross-site/cross-organization denial.
- Add tests that completed sessions reject further scans.
- Add tests for same UPC counted in multiple locations and correct roll-up.
- Add tests for unknown UPC exception capture.
- Add tests for export totals matching persisted count totals.

## Device acceptance matrix
Before calling the MVP pilot-ready, manually validate:

| Scenario | Dedicated Android handheld | Android phone | iPhone |
|---|---|---|---|
| Sign in/select site | required | required | required |
| Resume active count | required | required | required |
| Scan known UPC | required | required | required |
| Rapid repeated scans | required | required | required |
| Manual quantity | required | required | required |
| Unknown UPC | required | required | required |
| Change location | required | required | required |
| Network loss/recovery | required | required | required |
| Review/submit | required | required | required |

## Pilot usability targets
- A new counter should understand the core workflow with a short quick-start guide.
- Normal scan flow should require no keyboard typing.
- Active site, session and location must remain obvious.
- Successful scans and exceptions must be visually distinct.
- The UI must remain usable on phone-sized screens and dedicated handheld screens.

## Release gate
The MVP is **PILOT READY** only when:
1. CI is green.
2. All required automated tests above pass.
3. Claude independently reviews the current branch and no unresolved Critical issue remains in the counting path.
4. Manual Android/iPhone camera tests pass.
5. Manual dedicated-handheld test passes on the selected pilot scanner.
6. A controlled test catalog and scripted mock-store count reconcile exactly.

Anything not meeting these conditions is implemented/in test—not marketed as production-ready.
