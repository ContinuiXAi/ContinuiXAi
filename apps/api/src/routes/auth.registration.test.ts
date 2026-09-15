import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  count: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: mocks.findUnique,
      create: mocks.create,
      count: mocks.count,
    },
  },
}));

import { authRoutes } from "./auth.js";

async function testApp() {
  const app = Fastify();
  app.decorate("authenticate", async () => undefined);
  app.decorate("requireAdmin", async () => undefined);
  app.decorateRequest("locale", "en");
  await app.register(rateLimit, { global: false });
  await app.register(authRoutes, { prefix: "/api/auth" });
  return app;
}

describe("public registration route", () => {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorFlag = process.env.PUBLIC_REGISTRATION_ENABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "production";
    delete process.env.PUBLIC_REGISTRATION_ENABLED;
  });

  afterEach(() => {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (priorFlag === undefined) delete process.env.PUBLIC_REGISTRATION_ENABLED;
    else process.env.PUBLIC_REGISTRATION_ENABLED = priorFlag;
  });

  it("rejects production self-registration before touching user data", async () => {
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Unknown", email: "unknown@example.com", password: "StrongPass1!", recoveryPin: "123456" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Account creation requires an administrator." });
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports the effective registration policy", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/auth/registration-status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: false });
    await app.close();
  });
});
