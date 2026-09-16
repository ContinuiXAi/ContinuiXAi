# Inventory Truth and Reconciliation Design

**Status:** Approved design for Milestone 2  
**Date:** 2026-09-14  
**Base branch:** `design/store-inventory-ledger`  
**Depends on:** Guided Count release candidate at `fe9b72d492219fa5375c8b1d1fe0c66c7297bdf1`

## Purpose

ContinuiXAi must turn physical counting into a reliable store-level inventory truth system. It must help an inexperienced retail employee count correctly while giving managers the evidence needed to understand shortages, overages, misplaced merchandise, receiving problems, stocking problems, damage, expiration, theft, and other discrepancies.

Real-world acceptance is authoritative. Automated tests are necessary but do not replace testing on actual shelves with similar-looking products, curved and reflective packaging, interruptions, poor lighting, multiple storage locations, and employees with limited training.

## Product principles

1. Ease of use is the first interface requirement. Each step has one clear instruction and one dominant action.
2. Employees count the actual product, never the shelf tag or mylar.
3. The current location, expected store total, and suspected-location checklist remain visible throughout counting.
4. A weak or unavailable phone camera cannot stop the count.
5. Inventory changes are traceable, idempotent, tenant- and site-scoped, and reviewable.
6. Work can be paused, resumed, and reassigned without losing history.
7. The first release serves one store at a time and remains practical for a retailer with only a few locations.
8. The data model supports later multi-store and enterprise expansion without exposing that complexity to initial users.

## Inventory truth model

ContinuiXAi calculates expected inventory from an approved baseline and subsequent inventory events:

> Expected quantity = approved opening count + receipts + transfers in - transfers out - POS sales - disposals +/- approved adjustments

POS sales reduce the expected store total but do not claim which physical location supplied the sold unit. Customers and employees move merchandise throughout the day, so ContinuiXAi must not present a calculated location quantity as fact.

The system keeps these quantities distinct:

- **Expected store total:** the calculated quantity across every controlled location in the store.
- **Suspected locations:** the primary shelf and every other location where the product is assigned, was previously found, was received, or may reasonably be stored or displayed.
- **Actual at location:** the quantity physically counted in the current location.
- **Actual store total:** the sum of physical counts across shelf, display, backstock, receiving, recall, donation, hazardous, and other controlled locations.
- **Store difference:** actual store total minus expected store total, calculated after the required suspected locations are checked.
- **Unresolved quantity:** inventory expected somewhere in the store but not yet found or explained.

An approved physical count establishes a new trusted baseline only after required discrepancies are reviewed. Approval never erases the preceding expected quantity, count evidence, or explanation.

## Inventory event ledger

Every quantity change is represented as an immutable business event containing:

- Organization and site
- Product and identifier used
- Source and destination locations when applicable
- Signed quantity change and unit of measure
- Event type and reason
- Employee or system actor
- Source record, such as receipt, POS import, count, disposal, or manager adjustment
- Idempotency identity
- Occurred-at and recorded-at timestamps
- Review and approval identity when required

The first Milestone 2 slice uses existing inventory transactions and Store Count records where possible. It must not create a competing inventory-write path. Later receiving, POS, disposal, and transfer modules will publish events through the same ledger contract.

POS sale events reduce the store total without guessing a source shelf. Explicit transfers, stocking, counting, receiving, and disposition events may carry physical locations because an employee or controlled workflow identified them.

## Product and location model

Each counted product connects to:

- Product name, manufacturer, package size, and sellable unit
- UPC or other supported identifier
- Primary shelf location
- Zero or more auxiliary locations, including endcaps, displays, backstock, receiving, and controlled disposition bins
- Location confidence and evidence, such as assigned, previously counted, recently stocked, or display component
- Expected store total
- Department ownership

Locations belong to one organization and site. APIs must reject cross-tenant and cross-site access even when identifiers are guessed or reused. Counts and expected quantities must bind to the active site and session.

## Employee counting experience

Before counting, the employee selects or resumes assigned work and confirms the location. Counting is organized by location, not by product. The employee visits one location and counts every assigned product there before moving to the next location. Ten products across five locations therefore require five location visits, not fifty product-by-product trips across the store.

The count screen shows:

- Product name, package size, and UPC
- “Counting at” with the current location code and name
- Expected store total
- Every suspected location for the product and whether each has been verified in this count
- Products and units already counted at the current location
- Progress through all products assigned to the current location

The default instruction is:

> [quantity] expected in the store. Count every actual product at this location—not the shelf tag.

The default workflow remains scan once, enter the full physical quantity, and confirm. Rapid one-by-one mode remains an explicit opt-in. Location cannot change during identification, confirmation, or an unresolved save.

When all assigned products at a location are checked, the app directs the employee to the next efficient location. It does not send the employee back and forth for each product. A product remains unresolved until all required suspected locations are verified or a manager accepts an explained exception.

## Displays, cases, and component products

A received display, shipper, assortment, case, or kit may contain multiple sellable products. Its packaging definition records each component product and the number of sellable units contributed by one parent package.

When a parent package is received or broken down:

- ContinuiXAi expands the parent quantity into component-item quantities using the approved packaging definition.
- Each component increases the expected store total for its own sellable product.
- The display location is added as a suspected location for each component while the display is active.
- Moving components from the display to a basic shelf or backstock records a location transfer without changing the expected store total.
- Scanning either the parent identifier or a component identifier must not count both as sellable inventory at the same time.
- Changes to a display recipe are versioned so prior receipts and counts retain the correct historical breakdown.

Example: receiving two displays containing four units of Product A, six of Product B, and three of Product C per display adds eight A, twelve B, and six C to expected store inventory.

## Scanner and fallback requirements

The phone camera is one input method, not a workflow dependency.

- The visible aiming guide must match the decoded region in portrait and landscape.
- Decoding pauses during quantity confirmation and resumes with correct duplicate rearming.
- Holding one barcode in view cannot create duplicate counts.
- Guidance progresses from aiming instruction to lighting, distance, curvature, and glare help.
- After three seconds without product recognition, the employee receives a prominent “Barcode won’t scan?” action.
- Manual UPC entry, product search, and selection from the current location's assigned-product list open the same quantity-confirmation workflow.
- Bluetooth and dedicated handheld scanners use the same protected persistence path.
- Camera denial or failure immediately presents a usable fallback.
- Detection time, fallback use, and difficult-package outcomes may be recorded without collecting images or sensitive camera data.

Physical iPhone acceptance must cover flat barcodes, curved bottles, reflective packages, known products, unknown UPCs, quantities of one and greater than one, repeat scans, location changes, pause/resume, Summary, and Finish/lock.

## Discrepancy workflow

A difference does not immediately overwrite expected inventory.

1. The employee counts the actual product at the current location.
2. ContinuiXAi compares the running actual store total with the expected store total without treating the difference as final.
3. The employee completes the remaining suspected locations in the route, counting all assigned products at each location.
4. Quantities found anywhere are recorded at their actual locations.
5. If the difference remains, the employee selects one reason:
   - Could not find
   - Wrong shelf/location
   - Receiving problem
   - Stocking problem
   - Sale not recorded
   - Damage or expiration
   - Empty package/possible theft
   - Product or package changed
   - Other/manager review
6. The count may be paused and resumed on a later shift.
7. A manager reviews unresolved discrepancies and approves or rejects the new baseline.

Shortage guidance after all required locations are checked:

> [quantity] units are still missing after the listed locations were checked. Choose a reason or request manager review.

Overage guidance:

> [quantity] extra units found. Confirm the product and location.

The system preserves the original expectation, every physical count, reason, employee, time, location, and manager decision.

## Pause, resume, and ownership

- Departments or sections may be assigned to an employee owner.
- Active work stores the last completed location and product checkpoint.
- The employee can resume without recounting completed work.
- A supervisor may reassign unfinished work while retaining the original owner and event history.
- Completion is blocked while confirmations, queued writes, or required discrepancy decisions remain unresolved.
- Completed counts remain immutable except through a new authorized adjustment event.

## Manager experience

Managers and supervisors can:

- View active, paused, completed, overdue, and reassigned counts
- See progress by department, employee, and location
- Review expected, actual, and difference quantities
- See products assigned to or previously found in multiple suspected locations
- Identify suspected locations not yet verified and quantities not yet found or explained
- Review and approve discrepancy reasons and baseline changes
- Trace every adjustment to its evidence and actor

Employees receive simple task instructions. Manager detail must not clutter the employee count screen.

## Weekly store-level report

The report identifies:

- Departments requiring the most counting and cleanup time
- Largest shortages and overages
- Frequently misplaced products
- Repeated receiving and stocking errors
- Possible theft and empty-package activity
- Expired, damaged, recalled, donated, returned, and disposed quantities when those event modules are available
- Unfinished or overdue counts and assigned employees
- Repeated discrepancies by employee, product, location, vendor, and reason
- Recommended corrective actions supported by recorded evidence

The report labels conclusions as evidence, pattern, or hypothesis. It must not automatically accuse an employee of theft or poor performance.

## Permissions and security

- Employees may count only authorized sites and assigned work.
- Managers may review and approve only within their authorized organization and sites.
- Product and location lookup remains organization- and site-scoped.
- Idempotency protects every quantity-changing request and offline replay.
- Offline retries retain the exact original payload and identity.
- Server authorization is revalidated at the write boundary; UI restrictions are not security controls.
- Completed sessions cannot be changed through count-entry endpoints.
- Audit evidence records both successful changes and rejected privileged attempts where appropriate.

## Error handling

- A product lookup that exceeds three seconds falls back to an unknown-product card; late results cannot overwrite employee input.
- Network failures retain exact pending work locally and explain that it is queued.
- Ambiguous server responses reuse the original idempotency identity and immutable payload.
- If local durable storage also fails after an ambiguous response, the employee cannot discard or rescan the attempt until it is reconciled.
- Location or session changes invalidate stale asynchronous results.
- Errors use plain language and provide one safe next action.

## Milestone 2 delivery scope

Milestone 2 delivers a testable vertical slice:

1. Store-total expected quantities by product based on an approved baseline and ledger movements, without falsely assigning POS reductions to a physical location.
2. Location-first routes that count every assigned product before advancing to the next location.
3. Suspected-location verification and multi-location actual totals.
4. Display, case, and assortment decomposition into sellable component quantities.
5. Discrepancy calculation and guided search workflow.
6. Pause/resume checkpoints and supervisor reassignment foundations.
7. Manager discrepancy review and baseline approval.
8. Store-level discrepancy summary suitable for later weekly reporting.

Receiving imports, live POS integrations, full disposal/disposition processing, vendor credits, recalls, and enterprise multi-store analytics remain separate later milestones. Milestone 2 defines their ledger interface but does not implement those modules.

## Acceptance criteria

- A novice employee can start or resume assigned work and identify the next action without verbal instruction.
- Expected store total and the product's suspected-location checklist remain visible while counting.
- The workflow counts all assigned products at one location before sending the employee to another location.
- The employee can record one product across multiple physical locations.
- Parent displays and cases expand into the correct component-product quantities without double counting the parent and components.
- Shortage and overage guidance directs the employee to search before adjustment.
- Pausing and resuming never duplicates or loses confirmed work.
- Reassignment preserves ownership history.
- A manager can review evidence and approve a new baseline without erasing history.
- Cross-tenant, cross-site, duplicate, stale-response, offline-replay, and completed-session attacks are covered by automated tests.
- Camera failure never blocks manual or hardware-scanner counting.
- Automated API/web tests, builds, lint, dependency audit, isolated preview identity, and physical iPhone acceptance pass before production approval.
- Production and PR #21 remain unchanged until explicit approval.

## Success measure

The milestone succeeds when a real employee can count a difficult retail section, stop and resume, find inventory across multiple locations, explain unresolved differences, and hand a manager an accurate, reviewable result without needing technical assistance.
