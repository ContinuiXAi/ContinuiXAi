import { describe, expect, it, vi } from "vitest";
import { loadPublicRegistrationStatus } from "./publicRegistration.js";

describe("public registration availability", () => {
  it("returns the server policy", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    await expect(loadPublicRegistrationStatus("https://example.test", fetcher)).resolves.toBe(false);
  });

  it("fails closed when the policy cannot be loaded", async () => {
    const fetcher = vi.fn(async () => { throw new Error("offline"); });
    await expect(loadPublicRegistrationStatus("https://example.test", fetcher)).resolves.toBe(false);
  });
});
