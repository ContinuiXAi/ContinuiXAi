import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  login: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => createElement("a", { href }, children) }));
vi.mock("./api", () => ({ API_URL: "https://api.example.test" }));
vi.mock("./auth-context", () => ({ useAuth: () => ({ login: mocks.login }) }));
vi.mock("../components/BrandLockup", () => ({ BrandLockup: () => createElement("div", null, "ContinuiXAi") }));

import LoginPage from "../app/login/page";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function settle() {
  await act(async () => undefined);
  await act(async () => undefined);
}

async function changeValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Google Authenticator sign-in", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderSignIn() {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ needsBootstrap: false }), { status: 200 }));
    await act(async () => root.render(createElement(LoginPage)));
    await settle();
  }

  async function submitCredentials(enrollmentRequired: boolean) {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      challengeToken: "challenge-token",
      enrollmentRequired,
    }), { status: 200 }));
    if (enrollmentRequired) {
      mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
        qrDataUrl: "data:image/png;base64,unused",
        secret: "JBSWY3DPEHPK3PXP",
      }), { status: 200 }));
    }
    const [identifier, password] = Array.from(container.querySelectorAll<HTMLInputElement>("input"));
    await changeValue(identifier, "user@example.test");
    await changeValue(password, "SecurePass1!");
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
  }

  it("uses a manual Google Authenticator setup key without displaying a QR code", async () => {
    await renderSignIn();
    await submitCredentials(true);

    expect(container.textContent).toContain("Google Authenticator");
    expect(container.textContent).toContain("JBSWY3DPEHPK3PXP");
    expect(container.querySelector('img[alt*="QR"]')).toBeNull();
  });

  it("asks an enrolled user only for the current authenticator code", async () => {
    await renderSignIn();
    await submitCredentials(false);

    expect(container.textContent).toContain("6-digit code");
    expect(container.textContent).not.toContain("Secure Your Account");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/mfa/setup"), expect.anything());
  });
});
