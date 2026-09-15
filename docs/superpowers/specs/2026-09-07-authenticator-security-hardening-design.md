# Authenticator Security and Access-Control Hardening Design

## Decision

ContinuiXAi retains authenticator-app TOTP/QR MFA. SMS MFA, Twilio, SendGrid, and other paid verification services are excluded. Closed PR #20 remains unmerged and is not a source for this work.

The release candidate is derived from `chatgpt-development` commit `581ee3c277c3ce1b9580e6b5a6c3ab0fc2a3ee90`. Nothing is deployed or merged until automated verification and a new independent Claude adversarial review pass.

## Goals

- Prevent unauthenticated people from self-registering into live inventory.
- Preserve legitimate employee access across single-site and multi-site upgrades.
- Give administrators explicit site-assignment and authenticator-reset controls.
- Make authenticator enrollment, code verification, logout, recovery, and media authorization resistant to replay and stale-session reuse.
- Expose exact build identity so a live deployment can be matched to reviewed source.

## Registration and account provisioning

Public registration is disabled by default in production. `PUBLIC_REGISTRATION_ENABLED=true` may be used only in development or an explicitly controlled environment. When disabled, both the API registration endpoint and the web registration page fail closed and direct users to an administrator.

Administrators continue to create employee accounts through the existing Users workflow. Registration denial uses a generic response and does not reveal account existence.

## Site membership and migration safety

The site-membership migration preserves the pre-migration effective access of every active organization member by creating active memberships for every active site in that organization. CI includes populated single-site and multi-site upgrade fixtures and proves that no active member loses all site access.

After migration, administrators can view and change a user's authorized sites through scoped API and UI controls. The server derives organization scope from the authenticated administrator and rejects cross-organization site or user identifiers. At least one active site can be selected; duplicate memberships are idempotent. Creating a new site never silently grants access to unrelated users.

## Authenticator enrollment and verification

An MFA setup challenge is single-purpose and single-use. Setup refuses to run when MFA is already enabled. Successful confirmation invalidates the setup challenge by advancing the user's token version inside the same transaction that enables MFA and issues replacement session credentials.

TOTP verification records the accepted time-step counter. A counter at or below the last accepted value is rejected, including within the normal clock-skew window. Concurrent submissions cannot both consume the same counter. Backup codes remain one-time and are consumed transactionally.

## Sessions, logout, and media authorization

Each issued session has a server-side session record with a random identifier, user ID, issue/expiry timestamps, and optional revocation timestamp. Access JWTs contain the session identifier and remain short-lived. Authentication checks both user token version and active session state.

Single-device logout revokes the current session. Logout-all, password reset, MFA reset, user disablement, and recovery revoke all sessions by advancing token version and/or marking sessions revoked. Media tokens contain token version and session identity; cookie and Bearer media authorization validate both against current server state.

## Lost-device and administrator recovery

The Users page exposes the existing administrator-only reset-MFA operation with explicit confirmation and one-time recovery output. The action is organization-scoped, audited, revokes all target-user sessions, clears the authenticator secret and backup codes, and requires enrollment at the next login.

The bootstrap administrator receives recovery codes during initial enrollment. A documented command-line break-glass procedure can reset the sole administrator only with direct production operator access; it produces an audit record and never exposes secrets in logs. No paid external provider is required.

## Enumeration resistance

Login, user-ID recovery, and password recovery execute a dummy password/PIN hash verification when the supplied identifier does not resolve. Response bodies remain generic, and rate limits remain in force. Tests compare executed code paths rather than unreliable wall-clock thresholds.

## Build identification

The API health response includes the build SHA from `BUILD_SHA` or Railway's commit variable, without exposing secrets. The web application displays its build SHA in Settings or a small footer using a build-time public variable. CI and deployment documentation require API and web markers to match the reviewed candidate SHA.

## Error handling and compatibility

- All new controls fail closed when configuration or session state is missing.
- Existing authenticator users retain their encrypted secret and backup codes.
- Migration changes are additive and safe for populated PostgreSQL databases.
- Cross-tenant failures return 403 or 404 without revealing foreign records.
- Public-registration disabling does not affect administrator-created accounts.

## Verification

Automated coverage must include:

- fresh and populated PostgreSQL migrations, including a multi-site organization;
- public registration disabled in production and explicitly enabled in development;
- scoped administrator site assignment and cross-tenant rejection;
- setup-token reuse and already-enrolled setup rejection;
- TOTP counter replay and concurrent submission rejection;
- single-session logout, logout-all, password reset, MFA reset, and media-token revocation;
- administrator MFA-reset UI behavior and break-glass audit behavior;
- dummy-hash paths for unknown identifiers;
- API/web build-marker rendering;
- existing Store Count atomicity, idempotency, authorization, offline queue, and empty-count protections.

Final gates are clean install, Prisma generation, full API/web/shared tests, lint, production builds, PostgreSQL migration/schema validation, production dependency audit at high severity, and a new Claude adversarial review of the exact candidate SHA. Physical iPhone and Windows acceptance remain mandatory before production approval.
