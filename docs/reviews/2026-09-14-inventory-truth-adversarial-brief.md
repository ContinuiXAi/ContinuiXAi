# Inventory truth: adversarial review and acceptance packet

Prepared and locally verified **2026-09-15**. This is an evidence packet, not permission to publish or a production release approval.

## Candidate identity and verdict

- Exact locally verified final-fix implementation commit: `4f88b72abe27ca4f42f6b230c050333b84ade9d2`.
- Implementation tree: `2a2cd014dfaf7afec6bb31f7aa60eee9ef25db31`.
- Isolated branch: `feature/inventory-truth-reconciliation`.
- This packet and its documentation-only corrections follow that implementation commit. Its latest commit can be obtained with `git log -1 --format=%H -- docs/reviews/2026-09-14-inventory-truth-adversarial-brief.md`; they do not change the tested application, dependency lockfile, migrations, tests, or workflow.
- Binding design: [inventory truth and reconciliation](../superpowers/specs/2026-09-14-inventory-truth-and-reconciliation-design.md); implementation scope: [seven-task plan](../superpowers/plans/2026-09-14-inventory-truth-and-reconciliation.md). The September 14 design supersedes the earlier design's per-location expected quantities: **only the store total is an expectation; locations are suspected places to check**.
- **Local automated gates passed. This final-fix candidate still requires independent whole-branch re-review and exact-revision PostgreSQL evidence. Release additionally remains blocked on isolated-preview identity, physical iPhone acceptance, and explicit release authorization.** No Claude review was executed in preparing this packet.
- No push, PR alteration, merge, deployment, account change, or production database access was performed. Preserve PR #21. Do not interpret this packet as authority for any external action.

## Fresh local evidence

Commands ran on the final implementation source above on September 15, 2026; the focused API suite was repeated after the implementation commit. Recovery began with 11 inherited modified/untracked paths at `8adf15767d783890ca74e8ae3de8b8cbc53e8923`; those changes were inspected and preserved, not discarded. Node `v24.19.0`, npm `11.9.0`; existing installed dependencies were used, not a fresh `npm ci`. The dependency lockfile is unchanged; SHA-256: `692904fe157974a21526586c4bbda52a1a675fac609aeaeb2c426133bbb3ebec`.

| Gate | Exact command/result | What it does not prove |
| --- | --- | --- |
| Complete tests | `npm test`: exit 0; PWA Home launcher passed; shared build passed; API **344/344**, **40 files**; web **189/189**, **25 files** | API persistence doubles and JSDOM are not PostgreSQL or physical-device evidence |
| Focused tests | Inventory/Count/composition API: **195/195**, 10 files; Count/review web: **72/72**, 4 files; exit 0 | Includes current-owner, zero-evidence, parent identifier, stale-cancel and revoked-authority HTTP regressions, not live database schedules |
| All builds | `npm run build`: exit 0; shared/API TypeScript and web production compilation/type-check passed; **32/32** static pages generated, including `/store-count/review` | Build success does not establish a deployed identity or usability |
| All lint | `npm run lint`: exit 0; **zero errors, nine existing web warnings** | Not warning-free; warnings remain in my-work, store-categories, store-locations, store-products, team-work, BrandLockup, auth-context |
| Production dependency audit | `npm audit --omit=dev --audit-level=high --fetch-retries=0 --fetch-timeout=20000`: exit 0, **found 0 vulnerabilities** | Registry advisory snapshot at execution time; excludes dev dependencies; not a source-code security audit |
| Schema | `DATABASE_URL='postgresql://dummy:dummy@localhost:5432/dummy' npx prisma validate --schema apps/api/prisma/schema.prisma`: exit 0, valid schema | Dummy URL; no connection or migration application |
| Client generation | `DATABASE_URL='postgresql://dummy:dummy@localhost:5432/dummy' npm run prisma:generate -w apps/api`: exit 0, Prisma Client **7.10.0** | No database evidence |
| SQL rendering | From `apps/api`, with the same dummy URL: `npx prisma migrate diff --from-empty --to-schema=prisma/schema.prisma --script`: rendered SQL successfully; summary below | Rendering target-schema SQL does not execute or validate migration history |
| PostgreSQL validators type-check | Strict command below, including both truth validators and all four changed lifecycle fixtures: exit 0 | Compiles scripts; does not run assertions against PostgreSQL |
| CI wiring | Parsed `.github/workflows/ci.yml` with installed `js-yaml`; asserted bootstrap, Count, empty Count, both truth validators, task/atomic downstream steps and `workflow_dispatch` exist: exit 0 | No workflow was triggered |
| Whitespace | `git diff --check`: exit 0, rerun before documentation commit | Not a correctness/security test |

Validator type-check command from repository root:

```sh
npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck --types @fastify/jwt apps/api/scripts/freshPilotBootstrapValidation.ts apps/api/scripts/storeCountRouteValidation.ts apps/api/scripts/storeCountSiteAuthorizationValidation.ts apps/api/scripts/emptyCountCompletionValidation.ts apps/api/scripts/productCompositionDbValidation.ts apps/api/scripts/inventoryTruthReviewDbValidation.ts apps/api/scripts/inventoryTruthFinalDbValidation.ts apps/api/src/types/fastify.d.ts
```

The rendered SQL was consumed by a Node assertion checking `StoreCountSession`, `routeSnapshot`, `JSONB`, `StoreCountDiscrepancy`, `RESOLVED`, `ProductComposition`, and `StoreCountAssignmentEvent`. It was **44,213 bytes**, SHA-256 `a25e2a558f537854c5445b8917d6f2c541883c707f51ad8d82e04998498d4568`. This fingerprint is for the generated SQL stream, not a database dump. Existing npm `http-proxy` configuration warnings did not fail commands. No dependency upgrade was made.

## Final whole-branch findings: implementation corrections, review still pending

The whole-branch review at `8adf157` reported six Important findings despite earlier task-scoped approvals. Final-fix commit `4f88b72` supplies these corrections; this packet does not independently accept them:

- I1: current assignment now governs scan, quantity edit, verification, Finish, Cancel and active/start discovery. Supervisors use audited reassignment, with no implicit operational-write override. Explicit null assignment falls back to the starter. Former-owner offline retries, including committed scan identities, are denied without replay/relabeling; original queue/history is retained for supervised reconciliation. No emergency manager-cancel path was added.
- I2: the server requires a persisted positive or zero observation for every frozen assigned product at required visits before verification, finalized discrepancy calculation, Finish or new approval. Frozen route snapshots make later hint edits apply to future counts, not silently remove current obligations. Optional locations remain evidence, not mandatory visits.
- I3: Count rejects composition parent products and identifier aliases, including historical/inactive recipes, with component-count guidance. It does not expand a Count scan, change ordinary case semantics, or claim that the standalone expansion helper is an integrated receiving API.
- I4: Count writes lock the session first and then revalidate/hold current active actor, organization, site and memberships; scan/PATCH additionally validate current product and location scope. Start and legacy completion recheck actor activity. Verify, reassignment and review share the session-first boundary.
- I5: Cancel rechecks assignment and ACTIVE status under the shared lock and an ACTIVE update predicate. Completed/cancelled state cannot be overwritten, and any already-approved adjustment blocks cancellation. Evidence and original actors remain unchanged.
- I6: disposable bootstrap/route/empty-count/site fixtures remove only their scoped assignment events before deleting their sessions. Production RESTRICT/append-only protections are unchanged. The real route fixture now uses scoped products, denies non-assignee capture and proves unexplained overages reject Finish before employee explanations permit it.

Fresh RED checks used a detached scratch checkout of `8adf157`: the 34-test final-counterexample suite failed 23 expected behavioral assertions; later committed-retry/parent-alias probes failed all three targeted assertions. On recovered current source, tests separately exposed inactive-actor Start, legacy explanation permission, and inactive-actor legacy Finish before their fixes. The final 36-test counterexample suite and full suite passed. These are regression/control-flow evidence, not PostgreSQL evidence; no earlier worker's unrecorded RED run is claimed.

## Historical evidence: attribution and limits

The local SDD progress ledger and Task 6 independent re-review report record scoped approval at older commit `7b90e7b`. That approval did not cover the six subsequent whole-branch findings and does not accept this final-fix candidate. This packet did not commission a new independent review. Remaining Minor M1 concerns incomplete relationship-mutation and mixed concurrency evidence.

The ledger attributes successful PostgreSQL CI run #345 to an older exact-tree remote commit, `6d94d11d5b1b1b434903a1fe466488c2237bdd2e`, corresponding to local Task 3 commit `51dc67bb410b832fd1054e1bb8366f213765b6c2`. **That result is historical and cannot accept Tasks 4–6 or this candidate.** The same ledger records draft PR #23 as the isolated CI vehicle and the requirement to protect PR #21. Remote refs and PR state were not freshly queried for this packet; no current PR SHA or unchanged-remote-state claim is made. Recheck them before any authorized publication.

## Database and migration acceptance: NOT COMPLETED

No `psql`, `postgres`, `pg_ctl`, or `docker` executable was found in PATH or the inspected standard installation locations. The direct final-validator attempt using `DATABASE_URL=postgresql://continuixai_ops:continuixai_ops@127.0.0.1:5432/continuixai_ops_ci node --import tsx scripts/inventoryTruthFinalDbValidation.ts` exited 1 with **ECONNREFUSED 127.0.0.1:5432**, before any assertions ran. The `npx tsx` launcher first encountered an IPC-pipe EPERM; the direct Node import avoided that launcher issue and established the absent server. No real PostgreSQL migrations, lock scheduling, rollback, populated-data upgrade, or entire DB job ran here. No durable/external database was substituted. This is an environmental execution blocker, not a PostgreSQL test pass or observed assertion failure.

Relevant additive migrations:

1. `20260914190000_inventory_truth_reconciliation`: adds truth/route/composition/discrepancy persistence, optional assignee, and permits nullable `InventoryTransaction.locationId`.
2. `20260915120000_store_count_discrepancy_resolved`: preserves closed zero-difference history through `RESOLVED`.
3. `20260915130000_frozen_count_route`: adds JSONB route snapshot and backfills existing counts from site/organization-scoped hints without deleting visits, counts, expectations or history.
4. `20260915230000_count_explanation_actor`: nullable explanation author/time plus index/FK.

Compared with the historical Task 3 commit, the latter three migration files are added; no already-existing migration file differs. Snapshot backfill cannot reconstruct historical hints that were deleted before migration; it freezes the valid scoped hints available at upgrade. This is static diff evidence, not proof that populated rows survive an upgrade.

Required disposable PostgreSQL 17 execution:

- [ ] Verify host/database identity independently. A localhost address could be a tunnel to production; the validator host guard alone is insufficient. Use synthetic fixtures and an expendable database with no production secrets or volumes.
- [ ] Follow the current `database-validation` job: clean dependency installation, shared build, Prisma generation, `prisma migrate deploy`, `prisma migrate status`, and `prisma migrate diff --exit-code --from-config-datasource --to-schema=prisma/schema.prisma`.
- [ ] Execute every existing CI validator, including actual Store Count routes, same-organization cross-site denial, empty-count prevention, commercial append-only ledger, composition concurrency/rollback, `inventoryTruthReviewDbValidation.ts`, task recurrence and atomic scan retries. Archive exact revision, commands, exit codes and assertion output.
- [ ] Run an additional **populated upgrade**: create a disposable pre-inventory-truth schema from a separate old-revision checkout; populate active/completed Store Count sessions, entries, scan identities, actors, sites and ledger events; record IDs/counts/quantities/checksums; apply candidate migrations; compare all pre-existing records. Do not run an old checkout's destructive reset against any shared database. Empty-schema CI alone does not prove row preservation.
- [ ] Against the migrated database, exercise a store-level event with null location and verify arithmetic, then reject foreign-site and foreign-organization location/product relationships without partial writes. Never invent a physical location for a POS sale or a count baseline adjustment.
- [ ] Verify simultaneous location verification and scan/edit, pause/reassign/resume and completed write denial using independent connections. Check rows and audit evidence, not only status codes.
- [ ] Exercise both orders of overlapping baseline approvals: expected 15, both actual 13; exactly one adjustment of -2 and final ledger 13, never 11. Retry the approved request: no new event. A later count starting after the adjustment may move 13 to 12.
- [ ] Explicitly schedule ordinary receipt/sale insertion versus baseline approval with different actors/connections and barriers; verify real lock ordering, rejection semantics and final totals. The current validator's overlapping approvals share actor/site/organization locks and do not independently prove the Product/FK lock behavior.
- [ ] Add fault injection in the disposable validation harness after adjustment creation but before review metadata update: transaction abort must leave neither half committed. Also verify completed-session approval changes only deterministic adjustment/review metadata, not old count entries.

The existing review validator covers sequential/concurrent overlapping approvals, exact resulting totals, same-discrepancy retry, later fresh count, backdated/legacy-time ledger changes, remapped-UPC immutable evidence, review discovery and revoked membership. It does **not** supply the entire above matrix, and it has not executed here. Its fixtures intentionally remain until the disposable database is destroyed, preserving append-only protections.

The added `inventoryTruthFinalDbValidation.ts` uses separate PostgreSQL holder/observer connections and observes real blocked HTTP-writer backends before releasing barriers. It adds two-active-count discovery, audited A-to-B transfer and all former-owner operational denials, both scan/reassignment orders, omitted-versus-zero evidence, frozen hints, parent UPC/alias/version classification, each of five authority revocations across scan/PATCH/verify/Finish/Cancel, and both cancellation/Finish/approval orders. It asserts persisted quantities, actors, scan logs, statuses and ledger events. It is strict-type-checked and CI-wired, **not executed here**. Full DB job exit success, the populated upgrade, ordinary ledger-insert/approval scheduling and actual post-ledger rollback injection remain mandatory gates.

## Claude attack packet

Review the exact implementation SHA, not a branch name or this narrative alone. Read the binding September 14 design, routes `inventoryTruth.ts`, `inventoryTruthReview.ts`, `storeCount.ts`, and the composition endpoints in `products.ts`, Prisma schema/migrations, inventory/composition libraries, PostgreSQL validators, Count/review pages, scanner/queue modules, and corresponding tests. Include unchanged shared write paths when evaluating bypasses.

Return a verdict of GO / CONDITIONAL GO / NO-GO **with the gate to which it applies**. For each finding provide severity, exact file/line, authenticated actor/site setup, reproducible requests or UI steps, observed versus required persisted result, minimal failing test, impact and proposed fix. Distinguish executed reproductions, source-based risks, absent coverage and environmental blockers. Never call an unexecuted PostgreSQL or physical scenario a pass. Do not transmit this private packet to any new service without applicable authorization.

| Attack | Required invariant / evidence to demand |
| --- | --- |
| Store-total arithmetic | Baseline + receipts + in - out - sales - disposals +/- approved adjustments; signed quantities remain correct, exact site/product scope, no duplicate application; include zero, negative difference, large values and invalid units |
| Invented location expectation | POS reduces only store total; shelf/backstock/display show actuals and evidence-backed suspected locations, never an invented expected shelf balance |
| Cross-site hints and joins | Guess every product, location, hint, session, visit and discrepancy ID across two sites in one organization and across organizations; mutate membership/role/activity after read and before write; deny without leakage/partial persistence |
| Display parent/component double count | Two parents with recipe A4/B6/C3 add A8/B12/C6 only; parent identification and component scans cannot both become sellable units; retry does not re-expand |
| Composition version changes | V1 receipts retain V1 units after V2 activation; reject inactive/mixed versions, unknown components, overflow and foreign catalog relationships; atomically rollback partial expansion |
| Route crisscrossing | Ten products/five locations create five distinct visits, not product-by-product trips; all assigned products at current location precede advancement |
| Skipped/absent locations | Explicit None here records zero; required unverified location prevents final discrepancy/unsafe completion; no count-by-omission; optional evidence remains visible |
| Resume and reassignment | Reload/background/pause at every checkpoint; completed visits stay completed; no lost or duplicated entries; reassigned owner gains only correct authority, original history survives |
| Concurrent verification | Race two verifications and verification versus scan/edit/pause/Finish on separate connections; assert ledger, visit state, discrepancy snapshot and correct lock order |
| Concurrent/stale baseline | Both ordering permutations, independent sessions and actors, event insertion races, backdated occurrence/recording and equal timestamp; final baseline is never adjusted twice; stale evidence fails closed rather than silently rebasing |
| Ambiguous offline replay | Lose response after server commit; replay same immutable payload and ID; local storage failure cannot enable discard/rescan; session-scoped queue cannot falsely report flushed; no Finish with pending evidence |
| Stale scanner/lookup | Late decode/lookup/session-start result after location/session/auth change cannot mutate new context; decoder paused during confirmation; holding barcode creates no duplicates; rearming permits intentional new scan |
| Completed/approved writes | Scan, zero count, edit, changed/remapped/missing UPC and API bypass cannot alter locked evidence; original idempotent scan retry remains valid; completed review/approval returns to the exact original summary |
| Explanations and review | Current assignee only while ACTIVE; nine allowed reasons and <=500-character note; server actor/time; manager role scoped at write; stale token rejects; approval retry creates one deterministic adjustment; unrelated drafts survive failed refresh |
| Review discovery | Active relationships on every query; pending counts not buried by recent reviewed ones; explicit limits; null historical employee safe; discovery grants no new approval privilege |
| RESOLVED history | Recount matching expectation closes discrepancy without deleting original history or falsely attributing manager approval; no adjustment for zero difference |
| QR/MFA regression | Existing enrolled user does not loop into enrollment; phone-only enrollment remains usable; missing-factor/recovery failure cannot bypass MFA; revoked session/token and cross-tenant admin operations remain denied |
| Novice/mobile/accessibility | One clear next action, product/package/UPC and location context visible during confirmation, readable errors with safe retry and focus, large tap targets; camera denial/manual/search/hardware follow same protected quantity path |

Additional review-depth limitations: unit test doubles cannot prove PostgreSQL isolation; current real-DB validator does not explicitly schedule all edit/explanation/approval combinations or all membership relationship mutations. M1 remains a Minor coverage limitation until executed/expanded evidence resolves it. This does not imply an observed application failure.

## Isolated-preview checklist: all unchecked

- [ ] Obtain explicit authority for transmitting this branch and documentation to `Cvs1178433426/store-scan-app`; do not treat prior approval for a different tree/action as automatic authority if the upload gate rejects it.
- [ ] Freshly read remote feature ref, existing draft PR #23, and protected PR #21. Use only the separately authorized isolated draft PR/preview. Do not force-push another person's work or alter PR #21.
- [ ] Record both local and published commit IDs. If publication rewrites commit ancestry, compare exact Git tree IDs and record the mapping; a visually similar diff is insufficient.
- [ ] Confirm an eligible CI event: the current push branch list **does not contain this feature branch**. Use the authorized existing draft PR event or explicitly authorized `workflow_dispatch`; uploading alone is not a CI success or guarantee of a run.
- [ ] Require successful full CI and the additional pending database evidence above for this exact candidate. Confirm database validators actually ran, not skipped. Link the exact run and each failed/passed gate.
- [ ] Provision only an explicitly authorized isolated preview with disposable database, synthetic accounts/items, no production mounts, secrets, email/SMS sends or billing side effects. Apply only disposable migrations; keep it low-cost and stop unused services afterward.
- [ ] Pin frontend/API to the same verified published revision. Configure `NEXT_PUBLIC_BUILD_SHA` and `BUILD_SHA`; compare visible web build marker and API `/health` `buildSha` with that revision. `unknown` or a mismatch blocks acceptance. Reload/reinstall preview PWA if needed and verify again.
- [ ] Use separate employee and manager accounts with exact site membership and authenticator MFA. Check enrollment/login/recovery without collecting QR secrets, recovery codes or passwords in reports.
- [ ] Execute and archive the physical script below, record failures honestly, and retest fixes on their new exact SHA. Claude review alone cannot substitute for it.
- [ ] Only after all gates pass, request a separate explicit merge/production decision. **No merge or production deployment is authorized here.**

## Physical iPhone acceptance script: NOT RUN

### Tester preparation

The technical operator prepares the isolated preview and synthetic catalog. Mitchell/the employee only needs the phone, ten labeled practice products and this script; no developer console or SQL is required of the employee. If the app requires verbal coaching, record what was unclear instead of silently teaching around it.

Operator: record phone model, iOS version, Safari/PWA mode, preview URL, web/API SHA, store/session ID, date, employee/manager test roles and lighting. Use actual flat, curved and reflective product barcodes; register their exact UPCs against P1–P10 rather than pretending the P labels are barcodes. Similar-looking packages must have distinct matching size/UPC. Use synthetic identities and no camera images/secrets in the evidence.

Set up five nearby locations in the listed walking order. Give the app the same suspected-location assignments. Establish baseline/events **before the session starts**, with no sales/receipts while this primary scripted count is in progress. Any later legitimate ledger event must block stale approval and require a fresh count, not a workaround. A display receipt is a controlled fixture/API capability, not a claim that the full receiving-import UI exists.

The operator records the physical setup below; do not label these per-location amounts as application expectations.

| Product / package | Approved expected store total | Physical placement for this test | Required actual / difference |
| --- | ---: | --- | ---: |
| P1, flat barcode, display component A | 8 | L1 shelf: 3; L3 display: 4 | 7 / -1 |
| P2, curved bottle, display component B | 12 | L3 display: 8; L4 backstock: 4 | 12 / 0 |
| P3, reflective package, display component C | 6 | L3 display: 6 | 6 / 0 |
| P4, flat barcode | 2 | L1 shelf: 2 | 2 / 0 |
| P5, similar-looking package with distinct UPC | 2 | L1 shelf: 3 | 3 / +1 |
| P6, quantity-one item | 1 | L2 shelf: 1 | 1 / 0 |
| P7, curved package | 2 | L2 shelf: 2 | 2 / 0 |
| P8, flat package | 4 | L4 backstock: 4 | 4 / 0 |
| P9, reflective package | 2 | L5 receiving: 2 | 2 / 0 |
| P10, intentionally absent | 1 | L5 receiving: none | 0 / -1 |

Display setup: two V1 parents each contain P1×4, P2×6, P3×3, giving expected P1=8, P2=12, P3=6. Their present physical distribution is deliberately different after stocking/movement. Keep the display active so all three components have L3 as a suspected location. Do not add the parent as an eleventh sellable item. Other expected totals come from synthetic approved baseline events. Total expected is **40**, actual **39**, net difference **-1**, but three separate product discrepancies must remain visible; do not hide them by netting.

### Employee walkthrough

1. Open the preview on the iPhone. Sign in with your enrolled test account. You should not be asked to set up a new authenticator every login. If you hit a QR loop, stop and record it; do not reset your real account.
2. Start the assigned practice count. Read the next instruction without coaching. Confirm the correct store and **L1**. You should see the expected **store** total, current location and suspected-location checklist, including during quantity confirmation.
3. At L1, scan one P1 from the physical product, not its shelf tag. Enter **3**, then confirm once. Keep the barcode in view for five seconds: quantity must remain 3. Count P4=2 and P5=3, checking the similar-looking package/UPC carefully. The app must keep you at L1 until all three are checked. Tap the location-complete action once.
4. At L2, count P6=1 and P7=2. For a difficult barcode, note the seconds from aiming to correct recognition. After three seconds without recognition, look for **Barcode won't scan?**; use manual UPC, search, or the assigned-product list, confirm the same product/quantity. This must not require repeated camera attempts. Complete L2.
5. Stop after L2's saved work and completed-location confirmation, with no pending save. Lock the phone and leave the app briefly; this is an interruption test, not an instruction to find a Pause button. Reopen the same count and continue. L1/L2 must stay completed; saved quantities must not double; next work is L3, not another trip to L1. Record any extra location visit or unclear instruction. Formal server-side pause/reassignment is a separate foundation/API test below.
6. At L3, identify the display parent once and confirm it cannot also be counted as extra sellable inventory. Count components P1=4, P2=8 and P3=6 exactly once. Use portrait and landscape for the curved/reflective packages: decoded barcode must correspond to the visible aiming guide. Complete L3. P1 total is now 7, not 3 or 11; P2 remains unfinished until L4 is checked.
7. At L4, count P2=4 and P8=4. Complete L4. P2 total must be 12 across display/backstock. No request to revisit L3 just to count P2 again.
8. At L5, count P9=2. On P10's checklist card, tap the dedicated **None here for [P10's product name]** action directly. Do **not** tap **Count [P10's product name]** first: that opens a pending quantity card and disables None here. The dedicated action submits zero automatically; wait for the saved result, confirm P10 becomes **Counted**, and check **Counted here** shows 0. Do not skip it, enter a fake unit or repeat the action while its response is pending. Operator verifies a persisted P10/L5 entry with quantity 0 (not merely a missing row). Tap **Location complete**. The primary route now has exactly **five distinct location visits**, with every assigned product checked; interruption did not add a visit.
9. Tap **Review differences**. Confirm P1 expected 8/actual 7/-1, P5 expected 2/actual 3/+1, and P10 expected 1/actual 0/-1. Leave P10 **Not yet explained** for the negative Finish test. On P5 choose the truthful practice reason, such as **Other/manager review**, and type a practice note without saving it yet. On P1 choose **Could not find** and tap its **Save explanation**. During the page's automatic data refresh after that save, P5's unsaved reason/note must remain; this is not a full browser reload or navigation-away persistence test. Then tap P5's **Save explanation** and wait for its saved result. Do not invent theft evidence.
10. Test blocked completion **before saving P10's explanation**: from the Review page tap **Return to Count**, then **Summary** to compare every product/location with the table, then **Count** to return to the view containing **Finish**. Tap **Finish** and accept the browser confirmation, **Complete and lock this count? After completion, counted quantities cannot be edited.** The app must reject completion with an instruction to add an employee explanation for every discrepancy; the count must remain in progress, not locked. Tap **Review differences** again for this same count, select **Could not find** on P10 and tap **Save explanation**; wait until all three explanations show saved. Now follow the exact successful path: **Return to Count → Summary → Count → Finish**, accept the same browser confirmation, and verify the resulting Summary says **Finished and locked** for the same count identity. Success is permitted only with every required location checked, every required explanation saved, and no pending confirmation or unsynced write. Finish is not a control on the Review page or Summary view. The separate offline and pending-confirmation tests below must also demonstrate their blocking states rather than being marked passed from this explanation test.
11. Manager: sign in with the separate authorized test account, open **Find count reviews**, locate that exact completed count, and inspect original expected/actual/difference, physical locations, reason and employee/time. Approve each of the three explained discrepancies once. Retry one approval if the interface safely offers a retry; do not deliberately create another count. Operator verifies exactly one adjustment per approved discrepancy, no location invented, and resulting product baselines 7/3/0 for P1/P5/P10.
12. Return to Count. It must reopen the same original locked Summary even if another active count exists. Old evidence must remain intact. Attempt to add/edit a locked product through normal controls: no change is permitted. Record final actual total 39 and all three preserved explanations/manager decisions.

### Separate edge-case runs (fresh disposable sessions)

These do not count toward the five-visit primary route; keep separate session IDs and results so failures cannot be hidden in the happy-path totals.

- Camera denied: deny camera permission, then immediately count a known product via manual UPC. Also exercise search and assigned-list selection. If available, test a paired Bluetooth/dedicated scanner with the same quantity-confirmation/save path. Hardware not available means **not tested**, not passed.
- Unknown UPC: scan an unregistered practice barcode. No wrong product is silently counted; late recognition cannot replace the employee's current input. Record the safe next action and how the employee resolves the item.
- Offline: in a fresh session start online, disconnect, and capture two assigned products through available fallback. While those writes remain visibly pending, stay in the Count view and try **Location complete** and **Finish**: they must be disabled or reject the attempt; the session must remain in progress. Record the pending count and blocking message/state. Reconnect and retry: exact quantities persist once. Only after pending work reaches zero, every required location is checked and every required explanation is saved, follow **Summary → Count → Finish**, accept the lock confirmation, and verify successful locked completion of this separate session. Operator separately simulates committed-response loss and local-storage failure; employee must be protected from discard/rescan of an ambiguous attempt.
- Pending confirmation: in another fresh session, identify a product and leave its quantity card unsaved. Try **Finish** in the Count view: it must be disabled or reject completion, without saving or locking the session. Record that state, then complete the valid quantity and remaining required work; only after all locations/explanations are complete and writes are synchronized may **Summary → Count → Finish** and its confirmation succeed.
- Reassignment: pause unfinished work; manager assigns it to the second employee using the authorized supported workflow. New owner resumes at the checkpoint; former owner cannot write/Finish; ownership history remains. If no usable handoff UI exists, mark this as a foundation/API result and a physical usability gap, not a completed novice workflow.
- Stale work: delay lookup/save, then change session/location/account where permitted. No old response updates the new context. An in-flight unresolved confirmation/save must not permit an unsafe location switch.
- Skipped location: attempt advancement/Finish before required product/location checks. A clear instruction must direct the employee to unfinished work. None here must remain a distinct intentional zero, not absence of a record.
- Active manager approval: verify an approved product cannot then be recounted or altered, including a changed UPC. Unapproved work remains usable. A concurrent receipt/sale during the count must reject stale baseline approval and direct a new count.
- Display V2: operator activates a new composition after a V1 receipt; verify original evidence still uses V1 and later expansion uses exactly V2. Do not replace historical recipe data to make totals match.
- MFA: reopen installed preview, sign out/in and retry on the same iPhone. Existing enrollment must remain usable without a recurring QR prompt. Exercise the authorized phone-only enrollment/recovery test account path separately; never weaken MFA or reset production credentials to pass.

### Evidence sheet and pass decision

For **each attempt**, record: timestamp; exact SHA/session; product/UPC suffix and package type; location; expected store total; entered quantity; saved location/store actual; difference; seconds to correct detection; fallback method/time; repeat-scan outcome; duplicate/lost units; exact instruction/error shown; whether the employee needed help; PASS/FAIL/NOT RUN. Do not log passwords, full personal identifiers, QR secrets, recovery material or camera images.

Route sheet: planned L1 → L2 → L3 → L4 → L5; actual ordered visits: ______; distinct visits: ______; repeat visits/reason: ______; interruption checkpoint: ______. Final primary totals: expected 40; actual observed ______ (target 39); discrepancy rows ______ (target three); duplicate/lost counts ______ (target zero).

Acceptance requires correct quantities and identities, no duplicates/loss, five primary visits, safe camera fallback, all required security/lock/review behaviors, and understandable uncoached instructions. Record detection times; the specified three-second fallback must be available. Do not invent an unsupported universal camera-speed promise. Any mismatch, silent write, wrong identity, inaccessible fallback, unclear blocking action or missing required evidence fails that gate. Record tester and manager sign-off against the exact SHA; a blank or NOT RUN field is not acceptance.

## Rollback and recovery

1. **Local documentation only:** if this packet needs correction, make a follow-up documentation commit. Do not reset user work or rewrite verified application history. No deployment rollback is needed for preparing this packet.
2. **Failed disposable migration/validator:** stop the preview; retain sanitized command output, migration status and exact SHA. Confirm the database is expendable, destroy only that disposable instance, recreate it and apply the full migration chain. Never drop shared tables or disable append-only triggers to get a green run. If a populated-upgrade rehearsal fails, retain its fixture snapshot and identify the first failing migration before retry.
3. **Preview application regression:** stop new writes, preserve the isolated database snapshot and pending local count identities, then revert only the preview application to its recorded known-good revision if schema-compatible. Nullable ledger locations/new enum values can break older code assumptions; do not assume an old binary is safe against the new database. Prefer a fresh disposable database on the old revision for a clean rehearsal.
4. **Inventory discrepancy after approval:** preserve original count, explanation, decision and immutable adjustment. Use a new authorized adjustment/recount through the supported workflow; never edit/delete the approved event or rewrite historical counts. Lost responses retry the original identity; do not rescan as a recovery shortcut.
5. **Ambiguous offline save:** leave the original pending payload/ID intact, reconnect and reconcile with the saved server event. Do not clear browser storage, switch accounts to discard evidence, or uninstall the PWA until reconciliation is confirmed. If the interface cannot safely reconcile, stop that count and escalate with non-sensitive session/attempt identifiers.
6. **Any future production incident:** this packet does not authorize intervention. Obtain explicit incident/release authority, verified backup and restore plan first. Prefer a reviewed forward fix or compatible app rollback; no automatic down-migration, enum removal, destructive reset or database restore is prescribed. Restore rehearsal must account for events written after the backup, not silently discard them.

## Next decision

Proceed only to authorized exact-tree CI/disposable PostgreSQL validation and isolated preview preparation; complete missing adversarial schedules and then physical acceptance. Publication authorization is an external gate, not permission to merge or deploy production. Task 7 documentation and local gates can be complete while the milestone remains **not accepted for release**.
