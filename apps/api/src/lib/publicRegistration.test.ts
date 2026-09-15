import { describe, expect, it } from "vitest";
import { isPublicRegistrationEnabled } from "./publicRegistration.js";

describe("public registration policy", () => {
  it("fails closed in production when the flag is absent", () => {
    expect(isPublicRegistrationEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it("allows an explicit production exception", () => {
    expect(isPublicRegistrationEnabled({ NODE_ENV: "production", PUBLIC_REGISTRATION_ENABLED: "true" })).toBe(true);
  });

  it("preserves local development registration unless explicitly disabled", () => {
    expect(isPublicRegistrationEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isPublicRegistrationEnabled({ NODE_ENV: "development", PUBLIC_REGISTRATION_ENABLED: "false" })).toBe(false);
  });
});
