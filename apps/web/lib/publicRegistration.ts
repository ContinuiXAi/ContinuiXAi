type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function loadPublicRegistrationStatus(apiUrl: string, fetcher: Fetcher = fetch): Promise<boolean> {
  try {
    const response = await fetcher(`${apiUrl}/api/auth/registration-status`, { cache: "no-store" });
    if (!response.ok) return false;
    const body = await response.json() as { enabled?: unknown };
    return body.enabled === true;
  } catch {
    return false;
  }
}
