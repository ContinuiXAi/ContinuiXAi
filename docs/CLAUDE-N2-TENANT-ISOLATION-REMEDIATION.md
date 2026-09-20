# Claude N2 Tenant-Isolation Remediation

The administrator password-reset and account-deactivation routes now use the same organization-scoped authorization boundary as MFA reset.

The boundary requires the operator to hold an active OWNER or ADMIN membership in every active organization belonging to the target user. Unauthorized and partially overlapping multi-organization targets return the same not-found response before any credential, account, membership, session, or audit mutation.

## Verification before upload

- Security regression: 6/6 passed, including all three sensitive administrator routes.
- API: 158/158 passed.
- Web: 69/69 passed.
- PWA launcher regression: passed.
- API/shared TypeScript builds: passed.
- Web production build: passed (31 routes).
- Lint: 0 errors; 10 pre-existing web warnings.
- Production dependency audit: 0 vulnerabilities.

This candidate must still pass exact-SHA GitHub CI and independent Claude re-review before merge or deployment.
