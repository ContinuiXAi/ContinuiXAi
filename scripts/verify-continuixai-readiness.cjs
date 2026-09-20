const fs = require('node:fs');
const assert = require('node:assert/strict');

function read(file) {
  assert.ok(fs.existsSync(file), `missing required file: ${file}`);
  return fs.readFileSync(file, 'utf8');
}
function includes(file, needles) {
  const src = read(file);
  for (const needle of needles) assert.ok(src.includes(needle), `${file} missing readiness contract: ${needle}`);
}

const root = JSON.parse(read('package.json'));
assert.equal(root.name, 'continuixai-ops');
assert.equal(JSON.parse(read('apps/api/package.json')).name, '@continuixai/api');
assert.equal(JSON.parse(read('apps/web/package.json')).name, '@continuixai/web');
assert.equal(JSON.parse(read('packages/shared/package.json')).name, '@continuixai/shared');

includes('apps/api/prisma/schema.prisma', [
  'model TaskAssignment {',
  'jobTitle       JobTitle?',
  'recurrence     TaskRecurrence',
  'rolloverPolicy TaskRolloverPolicy',
  'model TaskAssignmentEvent {',
  'fromAssignedToId String?',
  'toAssignedToId   String?',
  'idempotencyKey String?',
  '@@unique([organizationId, idempotencyKey])',
  'model SiteMembership {',
]);
includes('apps/api/prisma/migrations/20260905000000_task_workflow_completion/migration.sql', [
  'TaskAssignmentEvent_scope_guard',
  'prevent_task_assignment_event_mutation',
  'TaskAssignmentEvent rows are append-only',
]);
includes('apps/api/prisma/migrations/20260906000000_task_reassignment_audit/migration.sql', [
  'fromAssignedToId',
  'toAssignedToId',
]);

includes('apps/api/src/routes/tasks.ts', [
  'app.get("/me"',
  'app.get("/me/summary"',
  'app.get("/team"',
  'app.get("/templates"',
  'app.post("/templates/starter-library"',
  'app.post("/assignments"',
  'app.patch("/assignments/:id"',
  'app.get("/reports"',
  'app.get("/reports.csv"',
  'organizationId: context.site.organizationId',
  'siteId: context.site.id',
  'assignedToId: request.user.sub',
  'materializeTeamWorkWindow(context, start, end)',
  'updatedAt: assignment.updatedAt',
  'This task changed while you were editing it. Refresh and try again.',
  'fromAssignedToId: assignment.assignedToId',
  'toAssignedToId: parsed.data.assignedToId',
  'Do not enter patient names, prescriptions, diagnoses, dates of birth, or other protected health information.',
  'idempotencyKey: parsed.data.idempotencyKey',
  'siteMemberships: { some: { siteId: context.site.id, isActive: true } }',
  'skipped: skippedTasks',
]);

includes('apps/web/app/my-work/page.tsx', [
  // "Continuixai Ops" is the retired product name (see lib/brandStandard.test.ts's
  // OLD_VISIBLE_BRAND check, which requires this exact page to NOT contain it).
  // The official brand lockup (BrandLockup, BRAND_NAME from lib/brand.ts) is what
  // renders product identity here now.
  'BrandLockup', 'Start My Day', 'Overdue', 'Completed today', 'Skipped today', 'Do not enter patient',
]);
includes('apps/web/app/team-work/page.tsx', [
  'Team Work', 'Recurring templates', 'One-time assignment', 'siteDateInitialized', 'teamData.date', 'Count sessions',
  // The reassignment label is now conditional (isCountTask ? "Task owner (not count)" : "Assigned to"),
  // so the literal source text ends with the closing JSX brace before <select>, not "Assigned to<select" directly.
  'Assigned to"}<select', 'idempotencyKey',
]);
includes('apps/web/app/daily-summary/page.tsx', [
  'accomplished today', 'Skipped today', 'Count sessions', 'Sign out',
]);
includes('apps/web/app/manifest.ts', [
  // Manifest name/short_name are wired to the shared BRAND_NAME constant
  // rather than a hardcoded literal (see lib/brandStandard.test.ts). start_url
  // now points at the home launcher ("/", app/page.tsx — see
  // test-pwa-home-launcher.mjs), which routes signed-in users onward, rather
  // than opening directly on My Work.
  'name: BRAND_NAME', 'start_url: "/"', 'name: "Start Count"',
]);
includes('apps/web/public/sw.js', [
  // Cache name is version-suffixed and bumps on shell-asset changes; check the
  // stable prefix rather than pinning an exact version that goes stale on every bump.
  'continuixai-ops-shell-v', 'title: "Continuixai Ops"', '"/my-work"',
]);
includes('apps/api/src/lib/mfa.ts', ['issuer: "ContinuiXAi Ops"']);
includes('apps/web/lib/storeCountQueue.ts', ['ownerUserId: string', 'continuixai_count_queue']);
includes('apps/api/src/index.ts', ['ENABLE_LEGACY_INVENTORY_FEATURES', 'if (legacyInventoryFeaturesEnabled)']);
includes('render.yaml', ['branch: continuixai-ops-completion', 'MFA_ENCRYPTION_KEY']);

const catalog = read('apps/api/src/lib/taskCatalog.ts');
const legacyTaskLabel = 'Store' + ' Scan';
const taskNameMatches = catalog.match(new RegExp(`Complete assigned ${legacyTaskLabel}`, 'g')) || [];
assert.equal(taskNameMatches.length, 1, 'legacy scan label must occur exactly once as the starter daily task name');

const nav = read('apps/web/components/BottomNav.tsx');
assert.ok(nav.includes('label: "Count"'), 'bottom navigation must call the counting capability Count');
assert.ok(!nav.includes(`label: "${legacyTaskLabel}"`), 'bottom navigation must not use legacy product branding');

includes('docs/CLAUDE-COMPLETE-REVIEW-BRIEF.md', [
  '# Claude Adversarial Review Brief — Continuixai Ops',
  'GO / CONDITIONAL GO / NO-GO',
  'Tenant isolation',
  'Race conditions',
  'Timezone correctness',
  'Migration safety',
]);

console.log('Continuixai Ops readiness source contracts passed');
