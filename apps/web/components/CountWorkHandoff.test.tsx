import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  show: vi.fn(),
  user: { id: "manager", name: "Morgan Manager" } as { id: string; name: string } | null,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...props }, children) }));
vi.mock("../lib/api", () => ({ apiJson: mocks.apiJson, apiFetch: mocks.apiFetch }));
vi.mock("../lib/auth-context", () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
vi.mock("../lib/toast-context", () => ({ useToast: () => ({ show: mocks.show }) }));
vi.mock("./BrandLockup", () => ({ BrandLockup: () => createElement("div", null, "ContinuiXAi") }));

import MyWorkPage from "../app/my-work/page";
import TeamWorkPage from "../app/team-work/page";
import type { TaskAssignment, TaskEmployee, TeamWorkResponse } from "../lib/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const site = { id: "site-a", organizationId: "org-a", code: "A", name: "Main Store", timeZone: "UTC" };
const countTask: TaskAssignment = {
  id: "task-a",
  organizationId: "org-a",
  siteId: "site-a",
  assignedToId: "employee-a",
  jobTitle: "STOCK_COUNT_ASSOCIATE",
  recurrence: "ONCE",
  rolloverPolicy: "REMAIN_OVERDUE",
  title: "Complete Store Count",
  instructions: "Count the vitamin aisle",
  scheduledDate: "2026-09-16T00:00:00.000Z",
  status: "IN_PROGRESS",
  priority: "HIGH",
  assignedTo: { id: "employee-a", name: "Alex", employeeNumber: "E-1", jobTitle: "STOCK_COUNT_ASSOCIATE" },
  events: [],
};
const employees: TaskEmployee[] = [
  { id: "employee-a", name: "Alex", email: "alex@example.test", role: "GENERAL", employeeNumber: "E-1", jobTitle: "STOCK_COUNT_ASSOCIATE", membershipRole: "MEMBER" },
  { id: "employee-b", name: "Bailey", email: "bailey@example.test", role: "GENERAL", employeeNumber: "E-2", jobTitle: "STOCK_COUNT_ASSOCIATE", membershipRole: "MEMBER" },
];

describe("count assignment handoff wording and behavior", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: "manager", name: "Morgan Manager" };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.trim() === label);
    if (!found) throw new Error(`Button not found: ${label}`);
    return found;
  }

  it("labels count-task completion as task-only and directs the employee to finish the count in Count", async () => {
    mocks.user = { id: "employee-a", name: "Alex Associate" };
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/tasks/me?days=7") return { date: "2026-09-16", site, managerAccess: false, assignments: [countTask] };
      if (url === "/api/tasks/task-a" && init?.method === "PATCH") return countTask;
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => root.render(createElement(MyWorkPage)));
    await act(async () => undefined);

    expect(container.textContent).toContain("Finish the active count in Count");
    expect(button("Mark task done")).not.toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((candidate) => candidate.textContent?.trim() === "Complete")).toBe(false);
    await act(async () => button("Mark task done").click());
    expect(mocks.apiJson).toHaveBeenCalledWith("/api/tasks/task-a", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ status: "COMPLETED" }),
    }));
  });

  it("hands off the active count through the count reassignment endpoint and shows ownership history", async () => {
    const team: TeamWorkResponse = {
      date: "2026-09-16",
      site,
      assignments: [countTask],
      activeCounts: [{
        id: "count-a",
        name: "Evening count",
        startedAt: "2026-09-16T12:00:00.000Z",
        assignedToId: "employee-a",
        assignedTo: { id: "employee-a", name: "Alex", employeeNumber: "E-1" },
        assignmentEvents: [{
          id: "event-a",
          fromUser: null,
          toUser: { id: "employee-a", name: "Alex" },
          assignedBy: { id: "manager", name: "Morgan" },
          reason: "Opening shift",
          occurredAt: "2026-09-16T12:00:00.000Z",
        }],
      }],
    };
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/tasks/employees") return employees;
      if (url === "/api/tasks/templates") return [];
      if (url === "/api/tasks/team") return team;
      if (url.startsWith("/api/tasks/reports")) return { period: "DAILY", anchor: "2026-09-16", start: "2026-09-16", end: "2026-09-16", site, totals: {}, employees: [], countActivity: { sessions: 1, locations: 1, products: 1, units: 4 }, assignments: [] };
      if (url === "/api/inventory-truth/counts/count-a/reassign" && init?.method === "POST") return { ...team.activeCounts[0], assignedToId: "employee-b" };
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => root.render(createElement(TeamWorkPage)));
    await act(async () => undefined);

    expect(container.textContent).toContain("Active counts");
    expect(container.textContent).toContain("Saved count progress and ownership history stay with the count");
    expect(container.textContent).toContain("Opening shift");
    expect(container.textContent).toContain("Task owner (not count)");
    expect(button("Complete task only")).not.toBeNull();
    const owner = container.querySelector<HTMLSelectElement>('select[aria-label="Count owner for Evening count"]')!;
    await act(async () => {
      owner.value = "employee-b";
      owner.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Hand off count").click());

    expect(mocks.apiJson).toHaveBeenCalledWith("/api/inventory-truth/counts/count-a/reassign", {
      method: "POST",
      body: JSON.stringify({ toUserId: "employee-b" }),
    });
    expect(mocks.apiJson.mock.calls.some(([url, init]) => url === "/api/tasks/assignments/task-a" && init?.method === "PATCH")).toBe(false);
  });
});
