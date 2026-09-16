# ContinuiXai PWA Home Launcher Design

## Goal
Make ContinuiXai Ops on iPhone, Android, and desktop feel like one simple application: open ContinuiXai, see the branded welcome screen, authenticate with the existing password + MFA flow, land on a personalized Home launcher, and enter the desired work area with one tap.

## Approved user flow
1. User opens the installed ContinuiXai PWA/Home Screen icon or visits the root URL.
2. If unauthenticated, the root shows the ContinuiXai brand, `Welcome to ContinuiXai`, a short welcome message, and one clear `Sign In` action.
3. Sign In opens the existing password authentication flow.
4. Existing MFA remains mandatory and unchanged.
5. After successful MFA/enrollment, the user lands on `/` (Home), not directly in Count.
6. Home recognizes the authenticated user's first name and local time and displays a greeting such as `Good morning, Mitchell — ready to start working?`.
7. Home presents four large, touch-friendly launcher buttons: Count, My Work, Products, Locations.
8. One tap opens the corresponding existing application area.
9. Home is intentionally extensible so future role-authorized applications/suboptions can be added without redesigning authentication.

## Architecture
This is an extension of the existing Next.js web/PWA application, not a second native application. Existing service-worker registration, Apple web-app metadata, authentication, MFA, API, database, Count workflow, offline behavior, and tenant/site authorization remain intact.

The root route owns both the unauthenticated welcome state and authenticated Home launcher. Authentication redirects are changed so successful MFA ends at `/`. Existing feature routes remain unchanged and retain their own authorization behavior.

## Home launcher
Home must:
- show only the branded welcome + Sign In action when there is no authenticated user;
- use the user's first/preferred display token from the existing authenticated user object, never a hard-coded name;
- derive morning/afternoon/evening from the browser's local time;
- render a clear ContinuiXai brand lockup;
- render four large launcher controls with labels and concise supporting text;
- use direct links to the existing routes `/store-count`, `/my-work`, `/store-products`, and `/store-locations`;
- remain usable on iPhone-sized screens and desktop;
- preserve the existing bottom navigation inside the authenticated app;
- provide a clear sign-out action using the existing auth mechanism.

## Authentication
No authentication security is weakened for convenience. Password login and MFA remain required according to current server policy. Both normal MFA verification and first-time MFA enrollment completion redirect to `/`.

The launcher must not introduce a second token/session store, bypass MFA, expose backup codes, or create a parallel account system.

## PWA behavior
Reuse the existing PWA foundation. The app must retain Apple standalone-web-app metadata, ContinuiXai application title/icon, service-worker registration, mobile viewport/safe-area behavior, and current offline infrastructure. The manifest start URL and scope are `/`, with standalone display mode.

The installed Home Screen experience launches into the same production application and root flow rather than a separate build.

## Error and loading behavior
While authentication state is being resolved, Home shows a simple branded loading state rather than protected content. When resolution confirms no authenticated user, Home shows the branded welcome state and Sign In action. Feature-level API/network errors remain owned by the existing feature pages.

## Scope boundaries
This change does not modify Count persistence, scanning, product/location data, organization/site authorization, database schema, Railway services, GitHub/Railway account identities, SMS MFA, employee onboarding, or native App Store packaging.

## Verification contract
Before merge:
1. Add regression coverage proving successful MFA and MFA-enrollment completion route to `/`.
2. Add regression coverage for the unauthenticated welcome/Sign In state, Home launcher labels/routes, and non-hard-coded personalized greeting behavior.
3. Verify existing Count/scanner regression tests remain green.
4. Run lint, tests, build, dependency/security audit, and PostgreSQL database validation through CI.
5. Review the exact PR diff for authentication/security regressions.
6. Merge only a fully green exact head SHA and verify post-merge CI.
7. Verify the deployed production build before manual iPhone installation/testing.
8. Manually verify on iPhone: Home Screen launch, welcome screen, sign-in, MFA, personalized Home, all four launcher buttons, Count camera permission/scan path, and return navigation.
9. Submit exact final branch/commit, CI evidence, and manual evidence to Claude for independent adversarial review before calling the experience complete.
