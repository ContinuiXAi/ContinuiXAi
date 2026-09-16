# Guided Count UX — Adversarial Review Brief

Date prepared: 2026-09-13

Local final-gate verification completed: 2026-09-13T19:53:10Z

Target branch: `design/store-inventory-ledger`

Implementation branch: `feature/guided-count-ux`

Base SHA: `ef0412cfab74d65055587e8d7fc03493a4987000`

Code-under-review SHA: `6888589eb4edd0409297d343ec2d02210edc4af5`

Evidence-only commit: the documentation-only child of the code-under-review SHA, titled `docs: refresh guided count final gate evidence`. Its exact SHA is recorded after commit in the final-gate-fixes handoff report. The code SHA above deliberately does not self-reference this evidence commit.

Required PR #21 candidate, unchanged locally: `b6bd6652415c6f0ec5ba9774215ca789074ff928`

## Release decision

**HOLD — not authorized for production merge or deployment.**

The automated local gates pass for the code-under-review SHA after running the same Prisma generation prerequisite used by CI. The isolated Railway preview, deployed build identity, and physical iPhone acceptance are still pending. These are release gates, not optional follow-up work.

No production deployment was attempted. PR #21 was not modified or merged.

## Automated verification evidence

Environment: Node `v24.19.0`; npm `11.9.0`.

Every npm command also emitted the environment warning `Unknown env config "http-proxy". This will stop working in the next major version of npm.` This did not change exit statuses. No dependency was added.

### Web tests

Command:

```text
npm --workspace @continuixai/web test
```

Exit status: `0`

Exact result:

```text
Test Files  22 passed (22)
     Tests  139 passed (139)
  Duration  5.71s (transform 2.74s, setup 0ms, import 4.22s, tests 4.34s, environment 20.53s)
```

### API tests and local prerequisite diagnosis

Historical Task 5 setup diagnosis (before this final fix round): its first test run exited `1` because generated Prisma Client was absent; its initial generation without `DATABASE_URL` also failed. Those historical failures remain documented in the Task 5 report and were not application regressions. The repository CI and API Dockerfile both run Prisma generation with a non-secret dummy URL before testing/building.

This final fix round freshly ran the CI-equivalent prerequisite before API verification:

```text
DATABASE_URL='postgresql://dummy:dummy@localhost:5432/dummy' npm run prisma:generate -w apps/api
```

Exit status: `0`

Exact result:

```text
Loaded Prisma config from prisma.config.ts.
Prisma schema loaded from prisma/schema.prisma.
✔ Generated Prisma Client (v7.10.0) to ./../../node_modules/@prisma/client in 338ms
```

The required API test command was then rerun:

```text
npm --workspace @continuixai/api test
```

Exit status: `0`

Exact result:

```text
Test Files  33 passed (33)
     Tests  165 passed (165)
  Duration  4.24s (transform 3.66s, setup 0ms, import 10.07s, tests 5.46s, environment 11ms)
```

This full suite includes the existing tenant-isolation, Store Count idempotency, session-revocation, and MFA replay-protection regressions.

### Production builds

Command:

```text
npm --workspace @continuixai/api run build
```

Exit status: `0`

Exact result:

```text
> @continuixai/api@0.7.4 build
> tsc -p tsconfig.json
```

Command:

```text
npm --workspace @continuixai/web run build
```

Exit status: `0`

Exact result:

```text
▲ Next.js 16.3.3 (Turbopack)
✓ Compiled successfully in 1209ms
  Finished TypeScript in 1370ms ...
✓ Generating static pages using 8 workers (31/31) in 526ms
```

The build emitted 31 application routes/pages and completed page optimization.

### Web lint

Command:

```text
npm --workspace @continuixai/web run lint
```

Exit status: `0`

Exact result:

```text
✖ 9 problems (0 errors, 9 warnings)
  0 errors and 3 warnings potentially fixable with the `--fix` option.
```

All nine warnings are the existing baseline outside the Guided Count implementation surface: four missing-hook-dependency findings, three unused disables, and two unoptimized-image findings across `my-work`, store administration pages, `team-work`, `BrandLockup`, and `auth-context`.

### Production dependency audit

Command:

```text
npm audit --omit=dev --audit-level=high
```

Exit status: `0`

Exact result:

```text
found 0 vulnerabilities
```

### Repository hygiene

Command: `git diff --check`

Exit status: `0`

Result: no whitespace errors.

## Final-gate fixes and focused regressions

| Finding | Fix and automated behavior verified |
|---|---|
| Ambiguous save abandonment | Ordinary Cancel is disabled and guarded once an immutable submission exists. Cancellation/rescan cannot discard the retained quantity/key after response loss plus queue-storage failure; retry reconciles one quantity of 12, not two. |
| Page/decoder pause mismatch | Page-owned capture permission/generation stops new assist decodes while paused, ignores older in-flight results even after resume, and arms only page-accepted values. Cancel rearms immediately; confirmation preserves the one-second page guard. |
| Unbounded identification | Catalog lookup falls back after three seconds, aborts the request, and ignores late results without overwriting the unknown-item card or edited quantity. |
| Card hierarchy/layout/focus | Shrinkable three-column stepper, 48-pixel controls, secondary adjustment/cancel actions, one dominant submit action, and focused quantity with product/location context. CSS/DOM and Enter behavior are tested; actual narrow-screen rendering and native VoiceOver remain physical acceptance items. |
| Missing explicit rapid mode | Optional one-by-one checkbox defaults OFF. Opt-in adds quantity 1 through the same authenticated idempotent save/queue path. Mode changes are blocked during unresolved work. Both decoders require barcode removal before repeating, including ZXing-to-assist handoff. Offline and ambiguous rapid attempts retain their exact payload/key. |

Command:

```text
npm --workspace @continuixai/web test -- storeCountPageLifecycle.test.ts CountQuantityCard.test.tsx storeCountScanReliability.test.ts scannerEngine.test.ts barcodeScanner.test.ts cameraScanGuard.test.ts RetailScannerAssist.test.tsx countQuantityFlow.test.ts countScanPresentation.test.ts
```

Exit status: `0` — 9 test files, 86 tests passed. The real page and assist are mounted together for pause/rearm/handoff regressions; only external camera/decoder and API boundaries are simulated.

### Detection/fallback timing instrumentation — explicit deferral

Task 4's elapsed UI guidance is implemented, but exported detection/fallback timing telemetry is **not implemented**. This targeted safety fix does not add a new telemetry/logging contract without an agreed consumer or physical baseline. Collect manual timings in the required isolated iPhone test below; add non-sensitive elapsed-time/source-only instrumentation in a separately reviewed follow-up if automated collection is required. No physical speed improvement, native accessibility result, or timing-event evidence is claimed here.

## Task-level review record

| Task | Implementation and review fixes | Approved evidence before this release pass |
|---|---|---|
| 1 — quantity domain | `8454986`; fix `52f211d` closed the Important whole-unit invariant gap by rejecting fractional and non-finite quantities. | 16 focused tests, scoped lint, and `git diff --check`. |
| 2 — confirmation card | `804d3ef`; fix `00297c7` preserved invalid typed input, restored retry after async rejection, and proved one callback under rapid activation. | 27 focused tests and scoped lint. |
| 3 — integrated guided flow | `c00b57f`; fixes `fe3341e`, `daf20d7`, `58ccf1b` closed lookup/view/session races, save/cancel races, unstable idempotency retries, mutable retry payloads, transition races, and completed-summary recovery/navigation. | Final task gate: 115/115 web tests, scoped lint, production web build, and whitespace check. |
| 4 — scanner performance/guidance | `e9ccdfd`; fix `cab940f` aligned the visible guide with the intrinsic decode crop in portrait/landscape, bounded guidance timers, and replaced contradictory camera-error status with manual fallback guidance. | Final task gate: 127/127 web tests, production web build, lint with 0 errors/9 baseline warnings, and whitespace check. |

## Isolated PR and preview state

- Branch push: **BLOCKED / NOT ATTEMPTED**. `gh` is not installed, `railway` is not installed, and no GitHub/Railway credential variable is configured (only `GH_PAGER`). A noninteractive `git push --dry-run` was rejected by the execution environment before contacting GitHub because it could transmit repository metadata. No workaround was attempted.
- Draft PR URL/number: **PENDING — branch is not pushed and no authenticated PR CLI is available.**
- PR base: `design/store-inventory-ledger`.
- Railway isolated environment name/ID: **PENDING**.
- Railway web service status: **PENDING — must report Online before release.**
- Railway API service status: **PENDING — must report Online before release.**
- Preview web URL: **PENDING**.
- Preview API URL: **PENDING**.
- Preview API `/health` response `buildSha`: **PENDING**.
- Expected deployed SHA: the exact head SHA produced after this evidence-only commit, not merely the pre-evidence implementation SHA above.
- Web build marker SHA: **PENDING; must exactly equal the deployed API SHA and PR head SHA.**
- Remote CI checks: **PENDING; local command evidence above is not represented as remote CI.**

## Adversarial attack checklist

Run these against the isolated preview at its exact recorded SHA. Every item is currently **PENDING** unless explicitly backed by the automated evidence above.

- [ ] Rapidly tap **Confirm & Continue** and prove one inventory mutation, one client scan ID, and one completion announcement.
- [ ] Keep the same barcode in-frame during quantity confirmation and prove no background duplicate is captured.
- [ ] Attempt location changes between detection and confirmation, including during lookup/save; prove the original location remains visible and the saved payload cannot silently move.
- [ ] Force a lost/ambiguous response plus offline queue replay; prove the complete immutable payload and idempotency key are reused and quantity is not doubled.
- [ ] After an ambiguous accepted response plus local-storage failure, attempt **Wrong item / Scan again**, another scan, and mode changes; prove the immutable retry remains visible until reconciled or safely queued.
- [ ] Stall catalog lookup beyond three seconds, then resolve it late; prove the unknown-item fallback stays countable and late details do not overwrite its quantity.
- [ ] Enable rapid one-by-one explicitly; verify quantity 1, offline replay, duplicate removal/rearm in both engines and during handoff, and return to default quantity confirmation without pending payload changes.
- [ ] Attempt Summary, Finish, Cancel, and location transition while lookup, confirmation, save, or queued work is pending; prove unresolved work cannot disappear or allow completion.
- [ ] Scan an unknown UPC, enter quantities `1` and greater than `1`, and prove it remains countable with explicit “needs review” feedback.
- [ ] Use a user from another tenant and a location from another site; prove lookup, count submission, summary, and completion deny access without revealing data.
- [ ] Within the completed session view, navigate Summary → Count → Summary and attempt scan, manual entry, retry, cancel, and finish; prove the ledger remains immutable while read-only summary stays reachable.
- [ ] Leave/reopen Count through navigation, use Summary → Count, cancel an unsubmitted card, encounter camera permission failure, and unmount the screen; prove video tracks/ZXing controls release, paused Quagga work stops, and stale callbacks cannot enter resumed capture. There is no Pause or Resume button.
- [ ] Exercise authenticator setup/recovery and prove it remains TOTP authenticator enrollment; no QR product-scan restriction may regress MFA QR setup or replay protection.
- [ ] Present merchandise QR codes to Store Count and prove they are rejected while EAN-13, EAN-8, UPC-A, UPC-E, and Code 128 continue to work.
- [ ] Hold a barcode at the visible guide edges in portrait and landscape; prove the rendered guide matches the actual decoder crop.

## Physical iPhone acceptance script — REQUIRED, NOT YET RUN

Use one supported physical iPhone against the isolated preview. Record device model, iOS version, browser/version, network, preview URLs, Railway environment, and exact API/web/PR SHA before starting.

1. Grant camera permission and start a new Count. Confirm “Counting at,” the current location code and name (when present), and the products/units counted here stay visible, and the guide aligns in portrait and landscape.
2. Scan two easy flat barcodes, one known and one unknown UPC. For each, record time from camera-ready to detection, product/UPC accuracy, instruction shown, quantity entered (`1` for one and greater than `1` for the other), tap count, and duplicate behavior while the code remains in-frame.
3. Scan two difficult curved or reflective packages under normal lighting. Record time-to-detection, any 2-second/5-second guidance reached, fallback decoder use if observable, retries, and whether torch/manual fallback was needed.
4. With a detected item awaiting confirmation, try changing location and scanning again. Confirm both are blocked and the visible location cannot change. Cancel once and prove the same UPC can be freshly rescanned.
5. Change location after the card closes, scan another item, and confirm the item is saved only to the newly visible location.
6. First reconcile any **Retry Save** whose local retention failed; do not reload while that only-in-memory attempt is unresolved. After work is saved or safely queued, leave Count through navigation and reopen it with the same account (the active session loads automatically), then repeat with a reload. Verify persisted counts, location totals, queued/unsynced state, and duplicate behavior. There is no Pause/Resume control, and an unconfirmed quantity card is not durable across reload.
7. Exercise **Barcode won’t scan?** with a UPC and confirm it opens the same quantity card and save path.
8. Open Summary and Finish. Prove Finish is unavailable with pending/unsynced work, then finish only after all work is resolved. Without leaving the completed session, navigate Summary → Count → Summary and prove Count is locked against mutation.
9. Leave the Count screen and confirm the camera indicator turns off. Re-enter and confirm the camera can start cleanly again.
10. At a narrow viewport, use quantity controls and Enter, then enable VoiceOver and verify quantity/product/location context and readable focus order. Enable rapid one-by-one, verify one unit per intentional scan (remove a repeated barcode for at least 1.5 seconds), attempt a mode change during a save, then switch it off and verify the quantity card returns.

Record at minimum for each package: barcode/known state, shape/finish, location, quantity intended/saved, detection milliseconds, duplicate count, guidance text, fallback used, and pass/fail. Attach screenshots or a short screen recording without exposing credentials or sensitive data.

### Physical acceptance evidence

- Tester: **PENDING**
- Device/iOS/browser: **PENDING**
- Preview environment and URLs: **PENDING**
- Exact deployed SHA: **PENDING**
- Test timestamp: **PENDING**
- Per-package timing/accuracy table: **PENDING**
- Leave/reopen and Summary → Count result: **PENDING**
- Narrow-screen/keyboard/VoiceOver and rapid-mode result: **PENDING**
- Finish/lock result: **PENDING**
- Camera cleanup result: **PENDING**
- Overall physical acceptance: **NOT COMPLETE — RELEASE BLOCKED**

## Reviewer response format

For every finding, report severity (`Critical`, `Important`, or `Minor`), exact SHA/environment, preconditions, numbered reproduction steps, expected versus actual result, inventory/security impact, and supporting request IDs/screenshots/logs. Do not approve release from code inspection or automated tests alone; isolated preview identity and the physical iPhone gate must both be complete.
