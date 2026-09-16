# Claude N1 employee-provisioning remediation

Status: implementation complete; independent Round 4 verification pending.

## Requirement-to-test matrix

| Review finding | Required invariant | Evidence |
| --- | --- | --- |
| N1 | Employee creation requires one explicit `organizationId`. | `auth.createUserIsolation.test.ts`: missing selection returns 400 before user creation. |
| N1 | The acting administrator must actively manage the selected organization as OWNER or ADMIN. | `auth.createUserIsolation.test.ts`: an unmanaged organization returns 404 before user or membership creation. |
| N1 | Creating an employee for Org A cannot grant organization or site access in Org B. | `auth.createUserIsolation.test.ts`: only the selected Org A membership and Org A site are created. |
| N1 concurrency | Permission and site changes cannot leave provisioning with a stale authorization snapshot. | Transaction tests simulate revoked authority and a site leaving the organization before the write; row locks bind validation and writes. |
| N1 UX | Administrators can select from only organizations they actively manage. | API and web tests cover the filtered organization list, required selector, and submitted `organizationId`. |
| N2 | Password reset, account deactivation, and MFA reset remain scoped to every active target organization. | `auth.adminIsolation.test.ts` remains green and unchanged in intent. |

## Implementation boundary

- `POST /api/auth/users` no longer loops over all organizations belonging to the acting administrator.
- The selected organization and acting administrator membership are revalidated and row-locked inside the write transaction.
- Active sites are selected and row-locked inside that same transaction before access is granted.
- The transaction creates exactly one organization membership and only active site memberships belonging to that selected organization.
- `GET /api/auth/user-organizations` returns only active organizations where the actor holds an active OWNER or ADMIN membership.
- The employee form requires the organization selection and submits its identifier with the creation request.

No database migration is required. PR #21 must remain draft and undeployed until exact-SHA CI and Claude Round 4 return GO.
