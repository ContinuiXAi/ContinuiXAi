# ContinuiXAi Store Inventory Ledger and Guided Operations Design

Date: 2026-09-13  
Status: Approved design draft for user review  
Base: PR #21 exact candidate `b6bd6652415c6f0ec5ba9774215ca789074ff928`  
Production release: Not authorized by this document

## 1. Purpose

ContinuiXAi will help store employees keep physical merchandise in the correct place, maintain reliable quantities, replenish primary shelf locations, investigate discrepancies, and document inventory exceptions. The system must reflect real store conditions: customers and employees move merchandise, similar packages are easily confused, stock exists in several locations, receiving and POS records can be wrong or delayed, and new retail employees need simple guidance.

The app carries the operational complexity. Employees receive one clear instruction at a time.

## 2. Scope and build order

1. Faster Count screen and scan-once quantity entry.
2. Expected inventory by product and location.
3. Pause/resume, department ownership, and supervisor reassignment.
4. Discrepancy investigation, adjustment thresholds, and approvals.
5. Receiving, stocking, backstock, auxiliary locations, and transfers.
6. Disposal destinations, recalls, vendor credits, and damage allowances.
7. POS imports and weekly store-level problem reports.
8. Package and UPC changes with preserved product history.

The first release reports at the individual store level. A retailer with several stores can select a store and view that store independently. District and corporate comparisons are deferred.

## 3. Operating principles

- Count the physical product, never the shelf tag or mylar.
- Verify the exact UPC and product identity, including strength, count, form, and package.
- Keep the primary shelf location full by replenishing from backstock or auxiliary locations.
- Show expected quantity during counting so employees know when to search for misplaced or unaccounted inventory.
- Preserve every inventory-changing event with actor, time, store, location, product, quantity, reason, and source.
- Never accuse an employee of theft or poor performance automatically. Reports distinguish evidence, correlation, and suspicion.
- Do not allow unresolved work to disappear. It must be corrected, assigned, paused, or escalated.
- Use plain language, large controls, visible progress, product images, and one instruction per screen.

## 4. Guided Count experience

### 4.1 Count header

The Count screen keeps these controls visible:

- Store and department.
- Current section and location.
- Employee owner.
- Progress through assigned shelves.
- Pending corrections and unsynced scans.
- Pause Shift button.

### 4.2 Faster barcode capture

The scanner uses a clearly marked capture area and continuously decodes while the camera is active. It provides:

- Immediate beep and vibration on acceptance.
- A visible confirmation card containing product image, exact description, UPC, strength, form, and package size.
- Plain prompts such as “Move closer,” “Hold steady,” “More light needed,” or “Barcode not recognized.”
- Torch control when supported.
- Duplicate-scan protection without blocking intentional repeated scans.
- Performance instrumentation for time-to-first-detection and fallback-decoder use.

### 4.3 Scan once, enter quantity

The default workflow is:

1. Scan one item.
2. Confirm exact product identity.
3. Enter the quantity using a large numeric field or minus/plus buttons.
4. Select Confirm & Continue Scanning.

The employee does not scan every identical unit. Rapid one-by-one scanning remains available as an optional mode.

### 4.4 Expected and physical quantities

For each item the app shows:

- Expected total quantity.
- Expected quantities at the primary shelf, backstock, and auxiliary locations.
- Physical quantity entered at the current location.
- Remaining quantity to locate.
- Final variance after all relevant locations are counted.

Expected quantities remain visible before and during the count.

## 5. Location accuracy and misplaced products

Every product has one primary shelf location and may have approved backstock or auxiliary locations.

When an item is scanned in an incorrect location, the app displays the correct destination and requires one of two choices:

- **Move It Now:** The employee moves the product and confirms the destination.
- **Mark for Correction:** The app creates an assigned follow-up task.

A deferred correction requires a plain-language reason:

- Shelf is full.
- Correct location unavailable.
- Need supervisor assistance.
- Product information appears wrong.
- Customer interruption.
- Not enough time before shift ends.
- Other, with a short note.

The task cannot be completed while an item is neither corrected nor assigned for correction.

## 6. Department ownership and daily work

Managers assign departments and sections to employee owners. Daily tasks include:

- Straighten and verify product placement.
- Replenish primary shelves from backstock or auxiliary locations.
- Review missing and misplaced items.
- Complete scheduled counts.
- Resolve assigned corrections and exceptions.

The app records time spent counting, rearranging, replenishing, and resolving exceptions. This distinguishes scanning time from necessary section recovery work.

## 7. Pause, resume, and reassignment

An employee can pause an unfinished count at shift end. The saved checkpoint includes:

- Department, section, and last completed shelf.
- Products and locations already counted.
- Expected quantities and physical quantities.
- Corrected and deferred misplaced items.
- Remaining shelves and discrepancies.
- Time by activity.
- Employee, pause time, and notes.

The next shift displays a direct continuation card, for example:

> Continue Vitamin Count  
> Last worked: Vitamin B12, Shelf 3. Completed: 62%. Corrections remaining: 3.

If sales, receiving, transfers, stocking, or disposal events occurred after the pause, the app updates expected quantities and clearly marks the affected products.

The assigned owner resumes by default. A supervisor can reassign unfinished work. Reassignment preserves the original employee’s complete history and records the supervisor, new assignee, time, and reason.

## 8. Inventory event ledger

ContinuiXAi maintains expected on-hand inventory from immutable business events rather than overwriting unexplained totals.

Expected quantity is calculated from:

`received - sold - disposed +/- transfers +/- approved count adjustments`

Event types include:

- Purchase order created or revised.
- Shipment received, shorted, overed, refused, or pending.
- Product stocked to a primary, backstock, or auxiliary location.
- Product transferred between locations.
- POS sale, return, void, or correction.
- Physical count and approved adjustment.
- Damage, expiration, empty package/suspected theft, discontinuation, recall, or other removal.
- Vendor return.
- Vendor credit requested, approved, denied, or received.
- Negotiated invoice allowance.
- Product package or UPC replacement.

Every event stores the product, quantity, from/to locations where applicable, employee or integration source, timestamp, reason, related document, and approval state.

## 9. Discrepancy workflow

A discrepancy card shows:

- Expected quantity.
- Physical quantity.
- Difference in units and estimated dollars.
- Locations already checked.
- Required next search steps.

The employee is prompted to check the shelf, similar-looking neighboring products, backstock, returns, carts, and auxiliary displays.

If the discrepancy remains, the employee chooses:

- Misplaced.
- Sold but not recorded.
- Damaged or expired.
- Empty package/suspected theft.
- Receiving error.
- Unknown—supervisor review.

Store-configured thresholds determine approval:

- Small, routine variances may be submitted by the employee with a reason.
- Large, high-value, controlled, repeated, or suspicious variances require supervisor approval.

The audit history preserves expected quantity, physical quantity, adjustment, reason, employee, approver, store, locations, and time.

## 10. Removal and disposition

### 10.1 Removal reasons

- Damaged.
- Expired.
- Empty package/suspected theft.
- Recalled.
- Discontinued.
- Other.

### 10.2 Rule-directed disposition

Employees do not freely choose disposition. ContinuiXAi determines it from product type, removal reason, recall notice, vendor agreement, negotiated allowance, and store policy.

Possible directed destinations include:

- Recall bin.
- Hazardous-materials bin.
- Donation bin.
- Trash.
- Return-to-vendor bin.
- Credit-documentation holding area.
- Clearance holding area.

The instruction is specific, for example:

> Place in Recall Bin R-1. Do not dispose. Vendor return is required.

### 10.3 Destination confirmation

Each destination bin has a ContinuiXAi barcode. The employee must scan that bin after placing the item inside. The destination scan completes the inventory event and updates any vendor-return, credit, recall, or reporting record.

A supervisor may override an unavailable or apparently incorrect destination. The override requires a reason and remains in the audit history.

## 11. Vendor credits and allowances

Vendor rules are stored by vendor, product/category, effective dates, and store:

- Physical return required.
- Disposal allowed after documentation.
- Report submission required for credit.
- Product not eligible for credit.
- Negotiated allowance already deducted from invoices, such as a 1% damage allowance.

The system prevents double recovery. An item covered by an invoice allowance cannot also be claimed individually unless the agreement explicitly permits it.

Credit workflow states:

- Documentation needed.
- Ready to submit.
- Submitted.
- Approved.
- Partially approved.
- Denied.
- Credit received.
- Closed under allowance.

Reports reconcile removed inventory, expected recovery, actual credit, and unresolved amounts.

## 12. Recalls and package changes

Recall instructions override ordinary disposition rules. The app identifies affected UPCs, lots, or date ranges; blocks sale or stocking where appropriate; directs the employee to the correct bin; and tracks removal, quarantine, return, disposal, and vendor reimbursement.

Package or UPC changes link old and new identifiers to one product history when appropriate. The system preserves prior counts, sales, receiving, locations, vendor terms, and recall history while preventing employees from combining genuinely different strengths, counts, or dosage forms.

## 13. Weekly Store Accuracy and Problem Areas Report

Each store receives an in-app and printable/email weekly report containing:

- Top five problem departments or sections.
- Inventory variance in units and dollars.
- Repeated missing and misplaced products.
- Empty packages and suspected-theft indicators.
- Receiving shortages, overages, and invoice discrepancies.
- Stocking and location errors.
- Damage, expiration, recalls, and disposal.
- Vendor credits pending, denied, and received.
- Count time compared with expected time.
- Primary shelves not replenished despite available backstock.
- Repeated corrections by product, location, shift, employee, and vendor.
- Week-over-week progress.
- Recommended corrective actions.

Cause analysis uses confidence labels:

- **Confirmed:** Directly supported by linked events or documents.
- **Likely:** Strong pattern with supporting evidence.
- **Possible:** Correlation requiring manager review.

The system reports operational patterns without automatically accusing an individual.

## 14. Roles and permissions

- **Employee:** Perform assigned tasks, count, move merchandise, submit routine variances, pause/resume work, and mark corrections.
- **Supervisor:** Reassign work, approve threshold exceptions, override disposition with a reason, and review store reports.
- **Store Manager/Owner:** Configure departments, ownership, thresholds, locations, disposition rules, vendor agreements, and reporting.
- **Integration:** Submit authenticated receiving and POS events with traceable source identifiers.

All actions remain organization- and store-scoped.

## 15. Offline, failure, and recovery behavior

- Captured scans remain safely queued when connectivity fails.
- The employee sees whether each scan is saved, pending, or needs review.
- Pausing never discards unresolved work.
- Completion is blocked until every captured scan is synced, corrected, or assigned.
- Repeated submissions are idempotent and cannot double inventory.
- Stale expected quantities are marked and refreshed before final adjustment.
- Scanner failure always offers manual UPC and quantity entry.

## 16. Success criteria

### Count experience

- A product can be scanned once and assigned a quantity without manually re-entering its UPC.
- Current location and expected location quantities remain visible.
- Scanner guidance is understandable to a first-job retail employee.
- Median time-to-detection improves materially on the physical iPhone test set.
- A Count can pause across shifts and resume without lost or duplicated work.

### Inventory integrity

- Expected quantity reconciles to the event ledger.
- Multiple locations roll up correctly without hiding location-level differences.
- Every adjustment and disposition has a complete audit trail.
- Destination-bin scanning prevents completion in the wrong workflow state.
- Vendor credits and negotiated allowances do not double-count recovery.
- Weekly store reports explain the strongest evidence behind problem rankings.

### Usability

- One primary action is visually dominant on each step.
- Instructions use plain language and product-specific examples.
- A new employee can complete the guided workflow without prior inventory-system training.
- Errors explain what happened and the single next action.
- Supervisors can recover, reassign, or override work without deleting history.

## 17. Deferred scope

- District and corporate comparative reporting.
- Automated employee discipline or theft accusations.
- Full ERP/accounting replacement.
- Customer-facing inventory availability.
- Advanced demand forecasting.
- Vendor-specific electronic claim submission beyond configurable exports and integrations.
