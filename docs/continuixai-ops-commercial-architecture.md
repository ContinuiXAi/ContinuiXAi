# Continuixai Ops Commercial Architecture Direction

Status: architecture direction for `chatgpt-development`; no production schema changes are authorized by this document alone.

## Product objective

Continuixai Ops is being developed as a reusable commercial platform for retailers, wholesalers, distributors, warehouses, and inventory-service organizations. The same product should be configurable for a single independent shop or a multi-site operator without maintaining customer-specific forks.

The core operational promise remains unchanged:

1. no lost physical scans;
2. no duplicate counts from retries;
3. extremely simple operation for counters;
4. reliable operation on poor Wi-Fi/cellular connectivity;
5. one counting pipeline for phones and Android hardware scanners.

Commercial architecture must preserve those guarantees while adding tenant and site boundaries.

## Current-state constraint

The current schema is still essentially single-installation. `User`, `Product`, `StoreLocation`, and `StoreCountSession` are globally scoped. That is acceptable for proving the counting engine, but it is not sufficient isolation for a commercial multi-customer service.

The inherited home-inventory domain (`Item`, nested `Location`, `AuditSession`, XP/consumer features, etc.) should not become the foundation of the commercial Continuixai Ops domain. Existing functionality must not be removed casually; Continuixai Ops should instead continue separating cleanly until legacy functionality can be deprecated or packaged separately by an explicit product decision.

## Target domain hierarchy

```text
Organization / Tenant
  ├─ Users + memberships + roles
  ├─ Product catalog
  ├─ Sites
  │   ├─ Retail store
  │   ├─ Warehouse
  │   ├─ Distribution center
  │   └─ Other facility
  │       └─ Store locations / zones / aisles / bins
  ├─ Count assignments
  └─ Count sessions
      └─ Count entries + immutable scan audit trail
```

### Organization

Represents the customer account/business boundary. Every commercially meaningful row must ultimately belong to exactly one organization.

Suggested fields:

- `id`
- `name`
- `slug`
- `isActive`
- `createdAt`
- optional branding/configuration fields later

### Membership and roles

A user should not have one global business role. A user may belong to one or more organizations with an organization-specific role.

Suggested initial commercial roles:

- `OWNER`
- `ADMIN`
- `MANAGER`
- `SUPERVISOR`
- `COUNTER`
- `VIEWER`

Use an `OrganizationMembership` join model rather than putting tenant role directly on `User`.

Authorization rule: tenant access is established from membership, never from a client-supplied organization id alone.

### Site

A customer may have one or many physical facilities. Use one neutral model so Continuixai Ops works for retail and wholesale operations.

Suggested fields:

- `id`
- `organizationId`
- `code`
- `name`
- `type` (`STORE`, `WAREHOUSE`, `DISTRIBUTION_CENTER`, `OTHER`)
- address/time-zone metadata as needed
- `isActive`

Unique site codes should be organization-scoped, not globally unique.

### StoreLocation

The current flat StoreLocation concept remains appropriate for high-speed counting, but it should become site-scoped.

Target uniqueness:

`@@unique([siteId, code])`

Examples: aisle, department, stockroom, bay, bin, cooler, endcap, reserve area.

Do not reuse the inherited nested home-inventory `Location` model.

### Product catalog

The current dedicated `Product` model remains the Continuixai Ops catalog. For commercial use it must be organization-scoped unless/until a deliberate global-product/master-data design is introduced.

Target uniqueness for the first commercial version:

`@@unique([organizationId, barcodeValue])`

This allows two customers to maintain different product descriptions/categories for the same UPC without leaking data between tenants.

External lookup cache may remain global if it contains only third-party/public lookup data and never customer-private overrides.

### Count assignment

Introduce assignments separately from active execution sessions once basic tenant/site scoping is stable.

An assignment can answer:

- which site should be counted;
- which zones are included;
- who is assigned;
- due date/status;
- optional expected inventory snapshot/reference.

Do not make assignment complexity block the simple walk-up `Start Count` flow for small customers.

### StoreCountSession

A session should eventually include:

- `organizationId`
- `siteId`
- optional `assignmentId`
- `startedById`
- status/timestamps

The one-active-session policy must be defined intentionally. Potential commercial policy options include one active session per user per site or one active session per user per assignment. Avoid assuming a global one-session rule forever once multi-site support exists.

### StoreCountEntry and scan audit

Entries remain aggregate quantities by session + location + barcode for fast summaries.

For commercial auditability, the scan/idempotency log should evolve into a durable event/audit record rather than being treated as disposable implementation detail. At minimum retain:

- physical-scan idempotency key
- session
- location
- barcode
- quantity delta
- timestamp
- user/device where practical
- outcome/status where practical

This supports investigation of disputes without sacrificing the aggregate-entry performance model.

## Tenant-isolation invariants

Before calling multi-tenant support complete, automated tests must prove:

1. Organization A cannot fetch Organization B products.
2. Organization A cannot use Organization B site/location ids.
3. Organization A cannot access, scan, summarize, complete, edit, or cancel Organization B sessions.
4. Identical UPC values can exist independently in two organizations if organization-scoped catalogs are chosen.
5. Identical location codes can exist at different sites.
6. Admin privileges are organization-scoped; a tenant admin is not a platform-wide superuser.
7. Cross-tenant idempotency-key reuse can never expose another tenant's data.

## Migration strategy

Do not perform a big-bang rewrite. Preserve the now-tested counting engine.

### Phase 0 — current reliability work

Finish and verify:

- offline/reconnect reconciliation;
- Product-to-Store-Count regression coverage;
- hardware scanner workflow;
- actual device testing;
- current route-level concurrency/idempotency guarantees.

### Phase 1 — add Organization + Site foundations

Add organization/site tables and memberships without immediately deleting old models. Create a default organization/site migration path for current data.

Requirements:

- forward-only migration;
- disposable-database migration test;
- zero Prisma drift;
- explicit backfill verification;
- no change to count quantities during migration.

### Phase 2 — scope Continuixai Ops domain

Add tenant/site foreign keys to Product, StoreLocation, StoreCountSession and relevant Store Count records. Update every Continuixai Ops query to derive tenant scope from authenticated membership.

Add cross-tenant denial tests before expanding UI.

### Phase 3 — commercial administration

Add organization/site administration, membership management, role controls, imports/exports and configurable terminology/branding.

### Phase 4 — assignments/reporting/integrations

Add scheduled count assignments, reconciliation/approval workflows, richer audit reports, POS/ERP/WMS import/export/API integration and commercial operational tooling.

## API design direction

Avoid trusting tenant identifiers supplied in request payloads. Auth should establish accessible organizations/memberships, and handlers should query within that authorized scope.

Where a user belongs to multiple organizations, use an explicitly selected current organization/site context that is validated server-side on every request.

Every tenant-scoped database lookup should include the tenant boundary directly or be reached through a relation already proven to belong to that tenant.

## UX direction

Commercial complexity belongs primarily in manager/admin screens, not the counter workflow.

Counter experience should remain approximately:

```text
Sign in
→ choose/receive site or assignment
→ choose location
→ scan continuously
→ change location when needed
→ finish
```

A counter should not need to understand tenants, databases, sync queues, idempotency keys, provider lookups, or architectural concepts.

Managers may receive configuration, failed-scan reconciliation, product maintenance, assignment, export and reporting screens.

### Current site stock state

The manager product screen may show a selected site's current stock state. `On hand` is a read-only signed Decimal sum of that organization's `InventoryTransaction.quantity` rows for the selected site, serialized with four decimal places; it is not derived from the legacy `Item.quantity` field and may be negative. Active organization products are paginated by name then ID, including zero for products with no ledger rows. Both the site list and balances require an active user, organization, organization membership, site, and site membership; a global ADMIN role provides no bypass. `Committed` and `Incoming` are explicitly `notTracked` until those operational ledgers exist.

`asOf` means **ledger creation cutoff**, not response time or a commit-time completeness guarantee. The server captures one application-clock timestamp before each page's balance read, filters `InventoryTransaction.createdAt <= asOf`, and uses that same cutoff for all rows in the page. `occurredAt` is deliberately not used: business events can be backdated. Only committed rows visible to the aggregate query are included. Pages are independently refreshed reads, not a repeatable-read snapshot across pagination; product metadata is also current at its query time. The UI labels this timestamp “Ledger creation cutoff.”

Clock/visibility limits: `createdAt` is the system creation timestamp, immutable under the application's append-only ledger convention (not a database-enforced commit timestamp). Some writers supply application time and other inserts use the database default. Application/database clock skew can exclude a visible row whose timestamp is ahead of the cutoff, and a transaction begun earlier but committed later can enter a subsequent read. Synchronize these clocks operationally; a future historical/audit snapshot requiring commit-complete reproducibility needs a stronger database snapshot/watermark contract. This endpoint does not claim that guarantee.

This current ledger view is separate from a count. Count's `Expected in store` remains the frozen expectation captured at count start and must never be relabeled as current stock.

## Hardware/device direction

Keep one shared barcode handling pipeline independent of input source:

- phone camera decode;
- Android keyboard-wedge scanner;
- manual fallback;
- future native scanner integrations if needed.

Do not encode Zebra-, Honeywell-, or Datalogic-specific assumptions into the counting engine. Device-specific tuning belongs in adapters/input configuration.

## Commercial configuration direction

Plan for configurable organization-level settings rather than customer-specific forks:

- business name/logo;
- terminology (site/store/warehouse, aisle/bin/zone);
- barcode behavior;
- product/category conventions;
- count workflow options;
- locale/time zone;
- optional features by plan/customer.

## Data ownership and export

Commercial customers should be able to export their own core data. Design APIs/data models so future CSV/XLSX/API export can cleanly include:

- products;
- locations;
- users/memberships;
- sessions;
- entries;
- scan audit;
- summaries/reconciliation.

## Non-goals for the immediate reliability milestone

Do not interrupt current reliability/device-validation work by prematurely implementing:

- billing/subscriptions;
- elaborate enterprise SSO;
- complex ERP integrations;
- customer-specific forks;
- microservices solely for architectural fashion.

The immediate goal is a proven counting engine with clean seams for commercial scoping.

## Definition of architectural success

The architecture is commercially ready when we can demonstrate with automated integration tests that two independent organizations can coexist in the same deployment, use overlapping UPC/location values, and neither can read or mutate any Continuixai Ops data belonging to the other, while both retain the same no-loss/no-duplicate/offline-safe counting guarantees already established for the single-organization workflow.
