const fs=require('node:fs'); const assert=require('node:assert/strict');
const checks={
 // "Continuixai Ops" is the retired product name (see lib/brandStandard.test.ts's
 // OLD_VISIBLE_BRAND check, which requires this exact page to NOT contain it); the
 // shared BrandLockup component is what renders product identity here now.
 'apps/web/app/my-work/page.tsx':['BrandLockup','Start My Day','Overdue','Today','This week','Completed today','Skipped today','countTaskActionLabel','Do not enter patient'],
 'apps/web/app/daily-summary/page.tsx':['accomplished today','Tasks completed','Skipped today','Units counted','Sign out'],
 'apps/web/components/BottomNav.tsx':['user?.taskManager'],
 'apps/web/app/team-work/page.tsx':['Team Work','Recurring templates','One-time assignment','Team status','Reports','Job title','siteDateInitialized','teamData.date','Assigned to"}<select','idempotencyKey'],
};
for(const [file,needles] of Object.entries(checks)){
 assert.ok(fs.existsSync(file),`missing ${file}`); const src=fs.readFileSync(file,'utf8');
 for(const n of needles) assert.ok(src.includes(n),`${file} missing ${n}`);
}
console.log('work UI contract passed');

const nav=fs.readFileSync('apps/web/components/BottomNav.tsx','utf8'); assert.ok(!nav.includes('jobTitle ==='), 'BottomNav must use server-computed taskManager only');
const team=fs.readFileSync('apps/web/app/team-work/page.tsx','utf8'); assert.ok(!team.includes('function todayKey'), 'Team Work must not seed dates from browser UTC');
