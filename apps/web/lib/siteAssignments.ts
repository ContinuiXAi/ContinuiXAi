export type SiteAssignment = { id: string; name: string; code: string; assigned: boolean };

export function selectedSiteIds(sites: SiteAssignment[]): string[] {
  return sites.filter((site) => site.assigned).map((site) => site.id);
}

export function toggleSiteSelection(current: string[], siteId: string, checked: boolean): string[] {
  if (checked) return [...new Set([...current, siteId])];
  return current.filter((id) => id !== siteId);
}
