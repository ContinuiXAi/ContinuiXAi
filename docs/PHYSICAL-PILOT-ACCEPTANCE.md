# ContinuiXAi Physical Pilot Acceptance Packet

**Status: NOT RUN.** This is the repository-tracked replacement for the prior external worksheet. It is a practical script and record for a controlled pilot using synthetic, non-customer test data. No checkbox in this document is evidence of a completed test until a named tester records a result and evidence reference.

Automated checks are necessary, but **they cannot replace this hardware and manual acceptance**: they do not prove camera focus, lighting, PWA behavior, Bluetooth/keyboard-wedge input, phone interruptions, or whether a new counter can understand the workflow.

## 1. Candidate identity — complete before testing

The authoring base for this packet was local commit `9c59c47cebf2278d503b9864d77209994183c46f`. It is **not** the source commit of this packet and does not claim that this file existed at that commit. The tester must record the exact packet revision actually used below. The application-behavior baseline is `6de0fef`; commits after that baseline through `9c59c47` are documentation/comments only. Do not infer that a build containing the eventual packet revision is deployed.

Record the exact packet and deployed identities before anyone signs in. The deploy owner must confirm that the API and web builds are the intended candidate (normally `6de0fef` for behavior), that they correspond to each other, and that the environment is the isolated pilot environment. The tester must confirm that the opened/printed packet is the recorded packet revision. If any identity is missing, differs from the intended candidate, cannot be tied to the build, or the packet revision does not match the packet being used, select **BLOCK** and stop.

| Field | Record before test |
|---|---|
| Intended behavior candidate SHA | `6de0fef` (or approved replacement: __________) |
| Documentation authoring base (not this packet's source commit) | `9c59c47cebf2278d503b9864d77209994183c46f` |
| Exact packet revision commit actually used (must contain this file) | __________ |
| Packet copy/build identity shown to tester (URL, file revision, or release artifact) | __________ |
| Tester confirms packet copy matches recorded revision | [ ] Yes [ ] No |
| Environment and URL (no secrets) | __________ |
| Deployed API build SHA / image revision | __________ |
| Deployed web build SHA / asset revision | __________ |
| API SHA matches intended candidate | [ ] Yes [ ] No |
| Web SHA matches intended candidate | [ ] Yes [ ] No |
| API and web candidate pairing approved by deploy owner | [ ] Yes [ ] No |
| Deploy owner, UTC date/time, evidence link or release record | __________ |

**Stop condition:** Do not run the workflow against an unknown, production, customer-data, mismatched deployment, or mismatched/unrecorded packet revision. A SHA in this repository is not a deployment attestation.

## 2. Roles, accounts, data, and evidence

Use isolated pilot accounts and a disposable organization/site. Do not put passwords, TOTP seeds, recovery codes, API tokens, personal phone numbers, screenshots containing secrets, or real customer/product data in this packet or attached evidence.

| Role | Minimum access / purpose | Named tester |
|---|---|---|
| Counter A | Assigned counter at pilot site | __________ |
| Counter B | Separate counter for concurrency/reassignment checks | __________ |
| Manager | Review, approval, export, and reassignment at pilot site | __________ |
| Other-site / other-tenant user | Separate account with no membership at pilot site | __________ |
| Pilot admin | Creates/reset isolated accounts only when recovery test is in scope | __________ |
| Observer/timekeeper | Records timings, usability observations, and evidence | __________ |

Prepare a small synthetic catalog and labels. Include known UPCs with expected descriptions, one deliberately unknown UPC, at least two physical locations, and labels that are flat, curved, and reflective. Mark every test label `PILOT ONLY`. Pre-count the labels and planned quantities on a separate controlled sheet; never use a real inventory balance as a test oracle.

Suggested test set: known item A (flat), known item B (curved), known item C (reflective), unknown item U, location L1, and location L2. Record expected starting totals: A ___ / B ___ / C ___ / U exceptions ___ / L1 ___ units / L2 ___ units.

For each row below use one result: **PASS**, **FAIL**, **BLOCK**, or **NOT RUN**. `BLOCK` means an environmental, account, build, safety, or access issue prevented a valid test. Capture UTC start/end, device/browser/app version, tester, result, a short observation, and evidence ID (redacted screenshot, screen recording, exported CSV, audit/history reference, or defect link).

| Result | Meaning |
|---|---|
| PASS | Expected outcome observed and evidence captured. |
| FAIL | Test completed but observed behavior differs from expected outcome. |
| BLOCK | Cannot safely or validly test; record blocker and do not guess. |
| NOT RUN | Not yet attempted. This is the initial state for every test. |

## 3. Device setup record

Complete one setup record per path. Install/launch the PWA only where the platform supports it; browser-only validation is still required where noted. Keep device lock settings available for interruption testing.

| Path | Device/model + OS | Browser/PWA version | Network | Tester | Ready? |
|---|---|---|---|---|---|
| iPhone Safari browser | __________ | __________ | Wi-Fi/cellular: ___ | __________ | [ ] |
| iPhone Safari PWA | __________ | __________ | Wi-Fi/cellular: ___ | __________ | [ ] |
| Android phone browser | __________ | __________ | Wi-Fi/cellular: ___ | __________ | [ ] |
| Android phone PWA | __________ | __________ | Wi-Fi/cellular: ___ | __________ | [ ] |
| Dedicated Android scanner | __________ | __________ | Wi-Fi/cellular: ___ | __________ | [ ] |
| Bluetooth scanner / keyboard-wedge mode | __________ | __________ | paired to: ___ | __________ | [ ] |

For the dedicated Android/Bluetooth scanner, record scanner model, firmware, keyboard layout, suffix (for example Enter), focus behavior, and whether the scan is delivered as keyboard input. Do not change a production scanner profile for this test.

## 4. Authentication and account safety

Run the following once on a phone path, then repeat normal login on each device path. Account recovery/admin reset is **out of scope** unless this is an isolated account and the pilot lead explicitly checks the optional row below.

| ID | Numbered action and expected outcome | Result | UTC start/end | Evidence / notes |
|---|---|---|---|---|
| AUTH-1 | 1. Start a clean session on the same phone used for the authenticator. 2. Sign in. 3. Enroll the authenticator once. 4. Enter the current code from that same phone. **Expected:** enrollment completes and normal app access appears. | NOT RUN | ___ | ___ |
| AUTH-2 | 1. Sign out. 2. Sign in again using the enrolled authenticator. **Expected:** login succeeds without presenting a new enrollment QR or enrollment screen. | NOT RUN | ___ | ___ |
| AUTH-3 | 1. Refresh/reopen after successful login. 2. Repeat one sign-in if needed. **Expected:** no repeated QR/enrollment loop; the user either remains signed in or receives the ordinary login prompt, never an unexplained re-enrollment demand. | NOT RUN | ___ | ___ |
| AUTH-4 | 1. Attempt pilot-site access as the other-site/other-tenant account. **Expected:** no pilot-site session, count, export, history, or data becomes visible or mutable. | NOT RUN | ___ | ___ |
| AUTH-5 (optional, isolated account only) | With pilot-lead approval, have the pilot admin reset/recover the isolated account. Sign in and enroll once again. **Expected:** recovery is attributable and does not loop or expose prior session data. | NOT RUN | ___ | ___ |

**Stop condition:** Stop and contain the test if an account sees another tenant/site’s data, enrollment repeatedly loops, an authenticator secret appears in evidence, or recovery would affect a non-isolated account.

## 5. Core count script — run on every applicable device path

Run CORE-1 through CORE-13 on iPhone Safari browser/PWA, Android browser/PWA, and dedicated Android scanner. For Bluetooth scanner, run at least CORE-1, 2, 6, 7, 8, 9, and 13 with keyboard-wedge input. Start each run in a new or reset isolated session so recorded quantities are unambiguous.

| ID | Numbered action and expected outcome | Result | Seconds | Evidence / notes |
|---|---|---|---|---|
| CORE-1 | 1. Sign in. 2. Select the pilot site, active count, and L1. **Expected:** site, session, and active location remain obvious before scanning. | NOT RUN | ___ | ___ |
| CORE-2 | 1. Scan known flat label A in portrait. 2. Repeat in landscape. **Expected:** each intentional scan gives immediate visible confirmation and correct count effect. | NOT RUN | ___ | ___ |
| CORE-3 | 1. Scan curved label B. 2. Scan reflective label C under normal pilot lighting. **Expected:** usable capture guidance and correct item/quantity, or a clear fallback without losing context. | NOT RUN | ___ | ___ |
| CORE-4 | 1. Use torch if offered. 2. Turn it off again. 3. Use manual UPC entry when camera capture fails. **Expected:** controls are reachable, state remains clear, and fallback records the intended item once. | NOT RUN | ___ | ___ |
| CORE-5 | 1. Enter a multi-unit quantity for known A. 2. For a designated known UPC/location with no stock, use the supported `None here` or explicit-zero action. 3. Reopen the UI review after the action. **Expected:** zero is explicitly persisted and visible in the UI; it is not silently converted to blank, one, omission, or a failed submission. Verify the same explicit zero again in GOV-4, GOV-5, and the reconciliation worksheet. | NOT RUN | ___ | ___ |
| CORE-6 | 1. Present/hold one barcode continuously in the capture area. 2. Observe duplicate suppression. 3. Remove it, then rearm as instructed and scan once more. **Expected:** held code does not add uncontrolled duplicates; an intentional rearmed scan creates exactly one additional logical scan. | NOT RUN | ___ | ___ |
| CORE-7 | 1. Scan U, the unknown UPC. **Expected:** exception is clear, retained, and actionable; no silent substitution or lost scan. | NOT RUN | ___ | ___ |
| CORE-8 | 1. Change from L1 to L2. 2. Scan A once in L2. **Expected:** transition is explicit and subsequent count is tied to L2, not silently carried under L1. | NOT RUN | ___ | ___ |
| CORE-9 | 1. On the keyboard-wedge scanner, focus the intended capture field only as required. 2. Scan A with configured suffix. **Expected:** input is accepted as one scan without keyboard typing, stray characters, focus loss, or duplicate posting. | NOT RUN | ___ | ___ |
| CORE-10 | 1. Navigate portrait/landscape as available while an active count is open. **Expected:** controls, feedback, active location, and pending state remain readable and usable. | NOT RUN | ___ | ___ |
| CORE-11 | 1. From the normal scan flow, record elapsed time for ten ordinary known-label scans. **Expected:** no confusing pause or lost context; record median and slowest observed time, not a release threshold. | NOT RUN | median ___ / max ___ | ___ |
| CORE-12 | 1. Ask a new counter to start at L1, scan one known item, change to L2, record an unknown item, and enter a quantity without coaching beyond the printed task. **Expected:** observer records where they hesitate, misread labels, or need help; outcome need not be PASS to be useful. | NOT RUN | ___ | ___ |
| CORE-13 | 1. Invoke native screen reader where available (VoiceOver on iPhone; TalkBack on Android) for sign-in, selected site/location, scan feedback, error/pending state, manual entry, and primary action. 2. Check touch targets and text readability in normal store lighting. **Expected:** actionable controls have discernible names/state, feedback is perceivable, and a counter can operate without tiny or unreadable controls. | NOT RUN | ___ | ___ |

### Required core execution matrix

Every `NOT RUN` cell below is an individual required execution. Replace it only after the matching execution-ledger row is complete. A PASS in one cell never passes another device/path. `—` means Bluetooth execution is not required for that particular CORE test; it may still be run and recorded. All non-`—` cells must be PASS for this packet to be accepted.

| Test ID | iPhone Safari browser | iPhone Safari PWA | Android phone browser | Android phone PWA | Dedicated Android scanner | Bluetooth keyboard-wedge |
|---|---|---|---|---|---|---|
| CORE-1 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| CORE-2 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| CORE-3 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | — |
| CORE-4 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | — |
| CORE-5 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | — |
| CORE-6 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| CORE-7 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| CORE-8 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| CORE-9 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| CORE-10 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | — |
| CORE-11 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | — |
| CORE-12 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | — |
| CORE-13 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

### Execution ledger — one row per execution

Use one row for every matrix cell and for any AUTH, RES, or GOV test that has a device-specific execution. Add rows as needed; do not combine paths in one row. The test ID, path/device, tester, UTC timing, OS/browser/PWA/scanner version, elapsed timing, result, and evidence are all required for a PASS.

| Test ID | Path/device | Tester | UTC start | UTC end | OS / browser / PWA or scanner version | Elapsed seconds | Result | Evidence ID / observation |
|---|---|---|---|---|---|---:|---|---|
| __________ | __________ | __________ | __________ | __________ | __________ | ___ | NOT RUN | __________ |
| __________ | __________ | __________ | __________ | __________ | __________ | ___ | NOT RUN | __________ |
| __________ | __________ | __________ | __________ | __________ | __________ | ___ | NOT RUN | __________ |
| __________ | __________ | __________ | __________ | __________ | __________ | ___ | NOT RUN | __________ |
| __________ | __________ | __________ | __________ | __________ | __________ | ___ | NOT RUN | __________ |
| __________ | __________ | __________ | __________ | __________ | __________ | ___ | NOT RUN | __________ |

## 6. Interruptions, offline queue, and reconciliation

Use the isolated site only. Have the observer write down the exact intended logical scan actions before each disruption: UPC, quantity, location, order, and whether the UI said unsynced/syncing/failed. Do not deliberately manipulate browser storage or network requests unless the pilot lead has approved the method.

| ID | Numbered action and expected outcome | Result | UTC start/end | Evidence / notes |
|---|---|---|---|---|
| RES-1 | 1. Capture one known scan while online. 2. Disable data / enter an isolated no-network state. 3. Capture a planned set of known and unknown actions. **Expected:** durable queued state is visible (for example unsynced/syncing/failed) and the user knows what needs attention. | NOT RUN | ___ | ___ |
| RES-2 | 1. While actions are queued, reload the browser/PWA. 2. Reopen the active count. **Expected:** queued work and active context recover where supported; none silently disappears. | NOT RUN | ___ | ___ |
| RES-3 | 1. Queue an action. 2. Background the app, lock the device, wait ___ minutes, unlock, and return. **Expected:** the user can resume and queued state is not silently discarded or misattributed. | NOT RUN | ___ | ___ |
| RES-4 | 1. Restore network. 2. Watch status through reconnect. **Expected:** queue moves to a clear final state; retry uses the original logical action and does not create duplicate inventory. | NOT RUN | ___ | ___ |
| RES-5 | 1. Simulate/observe an ambiguous retry only by normal disconnect/reconnect behavior. 2. Compare history/export against the handwritten planned actions. **Expected:** idempotent replay records each intended logical action once, not once per retry. | NOT RUN | ___ | ___ |
| RES-6 | 1. While a manager or second counter changes the relevant expected/current state in the isolated session, attempt the planned correction from the first device. **Expected:** stale correction is clearly rejected/refreshed/recovered without overwriting newer truth or losing an auditable action. Record the exact UI and recovery path. | NOT RUN | ___ | ___ |

**Stop condition:** Stop further write tests if any queued action vanishes, duplicates inventory, crosses an account boundary, or offers an unclear state that could cause a counter to repeat a count. Preserve evidence before reset/cleanup.

## 7. Finish, review, lock, reassignment, discrepancies, and history

Use a clean, reconcilable pilot session for this section. Manager review and approval (GOV-3) are mandatory and must PASS; they cannot be scoped away. If the required approval/review controls are absent or cannot establish the expected auditable, exactly-once effect, mark FAIL or BLOCK and do not accept the packet.

| ID | Numbered action and expected outcome | Result | UTC start/end | Evidence / notes |
|---|---|---|---|---|
| GOV-1 | 1. Have Counter A pause/leave an unfinished count. 2. Have Manager reassign it to Counter B with a reason. 3. Resume as B. **Expected:** reassignment is scoped, attributable, preserves A’s history, and B can continue without recounting completed work. | NOT RUN | ___ | ___ |
| GOV-2 | 1. Finish the reconcilable count using the explicit finish/submit control. 2. Try one further scan/edit using Counter A and B. **Expected:** completion is deliberate and completed count data is read-only/locked; any permitted correction follows an auditable separate path. | NOT RUN | ___ | ___ |
| GOV-3 | 1. As Manager, review item/location quantities, unknown exceptions, and a designated discrepancy. 2. Capture history and reconciliation totals before approval. 3. Approve the required adjustment/disposition once. 4. Refresh/reopen and inspect history and totals. **Expected:** review and approval controls are present; the decision is attributable; exactly one approved adjustment/history effect appears; totals reconcile; and approval does not erase count evidence. Missing controls, duplicate effect, or unreconciled total is FAIL or BLOCK. | NOT RUN | ___ | ___ |
| GOV-4 | 1. Export the completed session/history to CSV. 2. Verify scope, site/session metadata, locations, UPC/description, quantities, exceptions, actors/timestamps, the persisted explicit-zero entry, and the manager approval/adjustment history. **Expected:** export is readable, contains only authorized pilot data, and represents the zero and approval effect exactly once. | NOT RUN | ___ | ___ |
| GOV-5 | 1. Compare CSV/history totals to the handwritten action log and review screen. 2. Reconcile the persisted explicit zero and the exactly-once manager approval/adjustment effect. **Expected:** each planned logical action appears once; location and session totals reconcile; unknown UPC and zero treatment are explicit; approval effect appears exactly once. | NOT RUN | ___ | ___ |
| GOV-6 | 1. As other-site/other-tenant user, try direct navigation or normal UI paths to the pilot count, history, CSV export, review/approval, and reassignment. **Expected:** server-side denial; no data leak, mutation, or existence details beyond an appropriate access denial. | NOT RUN | ___ | ___ |

## 8. Reconciliation worksheet

Complete this before sign-off. Use actual exported/history values after reconnect has settled. An unresolved variance is a FAIL or BLOCK, not a rounding note.

| Measure | Planned / handwritten | UI review | CSV/history | Reconciled? |
|---|---:|---:|---:|---|
| A at L1 | ___ | ___ | ___ | [ ] |
| A at L2 | ___ | ___ | ___ | [ ] |
| B total | ___ | ___ | ___ | [ ] |
| C total | ___ | ___ | ___ | [ ] |
| Persisted explicit-zero / `None here` entries | ___ | ___ | ___ | [ ] |
| Unknown UPC exceptions | ___ | ___ | ___ | [ ] |
| Intended logical scan actions | ___ | ___ | ___ | [ ] |
| Duplicate/unexplained actions | 0 | ___ | ___ | [ ] |
| Approved manager adjustment/history effects | 1 | ___ | ___ | [ ] |
| Session total units | ___ | ___ | ___ | [ ] |

Record discrepancy details, suspected cause, and recovery/disposition: ________________________________________________

## 9. Defects, observations, and stop rules

Open a defect for every FAIL; attach only redacted evidence. Suggested severity:

| Severity | Use when |
|---|---|
| Critical | Cross-tenant/site exposure, unauthorized write, data loss, duplicate inventory, bypass of finished lock, credential/secret exposure, or no safe recovery. Stop testing. |
| High | Count integrity or account access can be wrong in normal pilot use; no reliable workaround. Pause affected path. |
| Medium | Important workflow, accessibility, or reliability issue with a documented safe workaround. |
| Low | Usability/cosmetic issue that does not change data or block the workflow. |

Also stop the affected run for: wrong/missing build identity, real/customer data, unsafe device condition, account that is not isolated, authentication enrollment loop, unrecoverable offline state, or any result the tester cannot explain. Record `BLOCK`, preserve evidence, notify the pilot lead, and do not erase the session until reviewed.

Novice observations (quote/describe behavior, not personal judgments):

- Where did the counter hesitate or ask for help? ________________________________________________
- Did site, session, location, scan success, exception, and queued/sync state remain understandable? ________________________________________________
- Were touch targets, text, contrast/readability, orientation, torch, and screen-reader feedback usable? ________________________________________________
- Suggested product change / defect ID: ________________________________________________

## 10. Completion and sign-off

This packet does not authorize production rollout. It records whether the named isolated physical pilot was accepted. All required execution-matrix cells and mandatory rows, including GOV-3 manager review/approval, must PASS; totals must reconcile; and no Critical/High defect may remain open. A NOT RUN, FAIL, or BLOCK required row prevents a pilot-ready claim.

| Sign-off item | Name | UTC date/time | Decision / evidence |
|---|---|---|---|
| Counter A | __________ | __________ | [ ] accept observations [ ] do not accept |
| Counter B | __________ | __________ | [ ] accept observations [ ] do not accept |
| Manager | __________ | __________ | [ ] review complete [ ] not complete |
| Deploy owner | __________ | __________ | [ ] candidate identity confirmed [ ] not confirmed |
| Pilot lead | __________ | __________ | [ ] accepted for isolated pilot [ ] rejected [ ] deferred |

Final package status: [ ] PASS — isolated physical pilot accepted  [ ] FAIL  [ ] BLOCK  [x] NOT RUN
