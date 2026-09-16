# Packaging and Inventory Design

Status: approved direction from 2026-08-29 ContinuixAI design discussion.

## Goal
Extend the existing Count workflow so real-world retail and wholesale inventory can correctly identify merchandise, count eaches, interpret case packs and displays, preserve location context, and support wholesaler repack/diversion and retailer display-to-basic transfers without inventing proprietary downstream barcodes.

## Core principles
- The item/manufacturer UPC remains the default universally recognizable product identity for repacked merchandise that may leave the wholesaler.
- Inventory on hand is ultimately normalized to sellable eaches for the underlying item UPC.
- Packaging composition is separate from inventory location and separate from inventory transformation.
- Unknown pack structures must never silently guess quantities.
- A scan should surface product description, scanned UPC, location, and quantity impact before or as the count is committed.
- All pack/display expansion must be auditable and atomic.

## Packaging composition model
A packaging identifier may represent:
1. EACH: one retail unit of one item UPC.
2. CASE: a standard case containing N eaches of one item UPC, with optional inner-pack metadata.
3. DISPLAY/ASSORTMENT: a parent UPC containing one or many item UPCs in varying quantities.
4. MULTIPACK/SOURCE PACK: a club or alternate-source pack that can be broken into individual retail items when commercially and legally usable.

A packaging definition stores the scanned parent UPC, type, description, and one or more component item UPCs with quantity-per-parent. Standard case pack is the default across conventional retailers. Customer/channel overrides may define larger pack quantities for club stores or other special channels.

## Count workflow
When an operator scans merchandise during an ACTIVE count, the UI shows:
- product description;
- scanned UPC;
- underlying item UPC when different;
- current location;
- packaging type;
- quantity-per-pack and resulting each quantity;
- current counted quantity for the item at that location.

The operator may either scan repeatedly one unit/pack at a time or enter a manual quantity. Manual quantity against a packaging UPC multiplies by the packaging composition. Example: 100 displays x the display bill of materials expands into the final each quantities of all component items.

## Display logic
A display is a bill of materials. Example: one display may contain seven different item UPCs at different quantities. Receiving 100 displays expands to 100 times each component quantity. The transaction records both the parent display quantity and the component each quantities.

For retailers, display placement is a location event. Merchandise may reside in temporary planogram/display locations during the promotion. When the display period ends, units transfer from those locations to regular/basic shelf locations and remaining overstock transfers to stockroom locations. The product itself is not transformed.

## Wholesaler repack/diversion logic
For wholesalers, opening a display, club multipack, or alternate-source pack is an inventory transformation. The source packaging quantity is consumed and recoverable underlying retail units are produced. Those units may then be repacked into normal item cases using the manufacturer item UPC as the scannable identifier plus human-readable case-pack/inner-pack information.

ContinuixAI must not create a proprietary merchandise barcode that a downstream retailer cannot identify. Internal transaction IDs may exist for traceability but must not replace the manufacturer UPC presented on merchandise.

Transformation records preserve source vendor, source UPC, source quantity, component yields, labor/packaging costs when captured, damaged/unusable quantity, and resulting landed cost per sellable unit.

## Club and customer pack overrides
The standard manufacturer case pack is the default for conventional retailers. Known customer/channel overrides may change the case quantity automatically for special channels such as club stores. The shipment/customer context determines the applicable override; the operator should not be forced to choose a pack size when a valid account-specific rule exists.

## Source-pack economics
For alternate sourcing, ContinuixAI may compare effective converted cost to direct/manufacturer or other source cost. Effective unit cost should include purchase price, inbound freight, labor, packaging/box cost, expected or actual loss, and other captured conversion costs divided by usable retail units recovered.

A future buyer-decision feature may calculate a maximum acceptable source-pack purchase price based on a target landed-cost advantage. This economic advisory must not alter inventory counts without an actual inventory transaction.

## Repack/diversion label disclaimer
Configurable standard disclaimer text:

“Legally acquired branded merchandise, independently distributed/repacked. Not affiliated with or authorized by the trademark owner. Packaging verified current at time of processing. Lot/batch and expiration dates may vary.”

This is informational language, not an authenticity guarantee. Supplier invoices, source records, batch/lot data when available, and transformation history should provide the stronger audit trail.

## Integrity and compliance safeguards
- Do not silently map unknown display/case/multipack UPCs to guessed quantities.
- Do not claim merchandise is authenticated unless a defined verification process supports that claim.
- Preserve lot/batch and expiration data when available; multiple lots/expirations may exist within repacked merchandise.
- Provide an authenticity/compliance hold state so suspect source lots can be blocked from further allocation pending review.
- Pack/display expansion must be transactional: all component inventory effects succeed or none do.

## Testing requirements
- Each scan adds exactly the intended each quantity.
- Standard case pack multiplies correctly.
- Account/channel case-pack override wins only in the matching context.
- Display scan expands all component item UPCs correctly for quantity 1 and quantity 100.
- Mixed count math is correct (loose eaches + cases + displays).
- Unknown pack definitions do not mutate inventory.
- Retailer location transfer preserves total on hand.
- Wholesaler transformation consumes source packaging and creates component eaches without changing the underlying manufacturer UPC identity.
- Duplicate camera detections do not cause unintended repeated increments.
- Existing manual UPC Count flow remains functional.
