"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";
import { humanizeEnum, isCountTask } from "../../lib/taskPresentation";
import { BRAND_NAME } from "../../lib/brand";
import { BrandLockup } from "../../components/BrandLockup";
import type {
  JobTitle,
  TaskAssignment,
  TaskEmployee,
  TaskPriority,
  TaskRecurrence,
  TaskReportResponse,
  TaskRolloverPolicy,
  TaskStatus,
  TaskTemplate,
  TeamWorkResponse,
} from "../../lib/types";

const JOB_TITLES: JobTitle[] = [
  "STORE_MANAGER",
  "INVENTORY_MANAGER",
  "STOCK_COUNT_ASSOCIATE",
  "RECEIVER",
  "CASHIER_CUSTOMER_SERVICE",
  "PHARMACY_TEAM",
];
const PRIORITIES: TaskPriority[] = ["LOW", "NORMAL", "HIGH", "URGENT"];
const ROLLOVER: TaskRolloverPolicy[] = ["REMAIN_OVERDUE", "ROLL_FORWARD", "SKIP"];

function templatePayload(form: TemplateForm) {
  return {
    jobTitle: form.jobTitle,
    title: form.title,
    instructions: form.instructions.trim() || null,
    recurrence: form.recurrence,
    startDate: form.startDate,
    endDate: form.endDate || null,
    weeklyDay: form.recurrence === "WEEKLY" ? Number(form.weeklyDay) : null,
    monthlyDay: form.recurrence === "MONTHLY" ? Number(form.monthlyDay) : null,
    dueTime: form.dueTime || null,
    priority: form.priority,
    rolloverPolicy: form.rolloverPolicy,
  };
}

type TemplateForm = {
  jobTitle: JobTitle;
  title: string;
  instructions: string;
  recurrence: TaskRecurrence;
  startDate: string;
  endDate: string;
  weeklyDay: string;
  monthlyDay: string;
  dueTime: string;
  priority: TaskPriority;
  rolloverPolicy: TaskRolloverPolicy;
};

const freshTemplate = (): TemplateForm => ({
  jobTitle: "STOCK_COUNT_ASSOCIATE",
  title: "",
  instructions: "",
  recurrence: "DAILY",
  startDate: "",
  endDate: "",
  weeklyDay: "1",
  monthlyDay: "1",
  dueTime: "",
  priority: "NORMAL",
  rolloverPolicy: "REMAIN_OVERDUE",
});

function dateInputValue(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

export default function TeamWorkPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { show } = useToast();
  const [employees, setEmployees] = useState<TaskEmployee[]>([]);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [team, setTeam] = useState<TeamWorkResponse | null>(null);
  const [report, setReport] = useState<TaskReportResponse | null>(null);
  const [templateForm, setTemplateForm] = useState<TemplateForm>(freshTemplate);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [oneTimeEmployee, setOneTimeEmployee] = useState("");
  const [oneTimeTitle, setOneTimeTitle] = useState("");
  const [oneTimeInstructions, setOneTimeInstructions] = useState("");
  const [oneTimeDate, setOneTimeDate] = useState("");
  const [oneTimeDue, setOneTimeDue] = useState("");
  const [oneTimePriority, setOneTimePriority] = useState<TaskPriority>("NORMAL");
  const [managerNotes, setManagerNotes] = useState<Record<string, string>>({});
  const [countAssignees, setCountAssignees] = useState<Record<string, string>>({});
  const [countHandoffBusy, setCountHandoffBusy] = useState<string | null>(null);
  const [period, setPeriod] = useState<"DAILY" | "WEEKLY" | "MONTHLY">("DAILY");
  const [anchor, setAnchor] = useState("");
  const [busy, setBusy] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const siteDateInitialized = useRef(false);
  const oneTimeIdempotencyKey = useRef<string | null>(null);

  useEffect(() => { if (!loading && !user) router.replace("/login"); }, [loading, user, router]);

  async function refreshAll() {
    if (!user) return;
    setBusy(true);
    try {
      const [employeeData, templateData, teamData, reportData] = await Promise.all([
        apiJson<TaskEmployee[]>("/api/tasks/employees"),
        apiJson<TaskTemplate[]>("/api/tasks/templates"),
        apiJson<TeamWorkResponse>("/api/tasks/team"),
        apiJson<TaskReportResponse>(`/api/tasks/reports?period=${period}${anchor ? `&anchor=${anchor}` : ""}`),
      ]);
      setEmployees(employeeData);
      setTemplates(templateData);
      setTeam(teamData);
      setReport(reportData);
      if (!siteDateInitialized.current) {
        siteDateInitialized.current = true;
        setOneTimeDate(teamData.date);
        setAnchor(teamData.date);
        setTemplateForm((current) => ({ ...current, startDate: teamData.date }));
      }
      if (!oneTimeEmployee && employeeData.length) setOneTimeEmployee(employeeData[0].id);
      setAccessError(null);
    } catch (err) {
      setAccessError(err instanceof Error ? err.message : "Manager access is required.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { if (user) void refreshAll(); }, [user, period, anchor]);

  async function updateJobTitle(employee: TaskEmployee, jobTitle: JobTitle | null) {
    try {
      await apiJson(`/api/tasks/users/${employee.id}/job-title`, { method: "PATCH", body: JSON.stringify({ jobTitle }) });
      await refreshAll();
      show(`Job title updated for ${employee.name}.`, "success");
    } catch (err) { show(err instanceof Error ? err.message : "Could not update job title.", "error"); }
  }

  async function installStarterLibrary() {
    if (!window.confirm(`Install any missing ${BRAND_NAME} starter templates for all six job titles? Existing templates will not be replaced.`)) return;
    try {
      const result = await apiJson<{ installed: number; existing: number; totalCatalog: number }>("/api/tasks/templates/starter-library", { method: "POST" });
      await refreshAll();
      show(`${result.installed} starter template${result.installed === 1 ? "" : "s"} installed.`, "success");
    } catch (err) { show(err instanceof Error ? err.message : "Could not install starter library.", "error"); }
  }

  function editTemplate(template: TaskTemplate) {
    setEditingTemplateId(template.id);
    setTemplateForm({
      jobTitle: template.jobTitle,
      title: template.title,
      instructions: template.instructions ?? "",
      recurrence: template.recurrence,
      startDate: dateInputValue(template.startDate),
      endDate: dateInputValue(template.endDate),
      weeklyDay: String(template.weeklyDay ?? 1),
      monthlyDay: String(template.monthlyDay ?? 1),
      dueTime: template.dueTime ?? "",
      priority: template.priority,
      rolloverPolicy: template.rolloverPolicy,
    });
    document.getElementById("template-editor")?.scrollIntoView({ behavior: "smooth" });
  }

  async function saveTemplate(event: FormEvent) {
    event.preventDefault();
    try {
      const path = editingTemplateId ? `/api/tasks/templates/${editingTemplateId}` : "/api/tasks/templates";
      await apiJson(path, { method: editingTemplateId ? "PATCH" : "POST", body: JSON.stringify(templatePayload(templateForm)) });
      setEditingTemplateId(null);
      setTemplateForm(freshTemplate());
      await refreshAll();
      show(editingTemplateId ? "Template updated." : "Template created.", "success");
    } catch (err) { show(err instanceof Error ? err.message : "Could not save template.", "error"); }
  }

  async function deactivateTemplate(template: TaskTemplate) {
    if (!window.confirm(`Deactivate “${template.title}”? Existing task history will remain unchanged.`)) return;
    try {
      await apiJson(`/api/tasks/templates/${template.id}`, { method: "DELETE" });
      await refreshAll();
      show("Template deactivated.", "success");
    } catch (err) { show(err instanceof Error ? err.message : "Could not deactivate template.", "error"); }
  }

  async function createOneTime(event: FormEvent) {
    event.preventDefault();
    if (!oneTimeEmployee) return;
    try {
      await apiJson("/api/tasks/assignments", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: oneTimeIdempotencyKey.current ?? (oneTimeIdempotencyKey.current = (typeof crypto !== "undefined" && "randomUUID" in crypto) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
          assignedToId: oneTimeEmployee,
          title: oneTimeTitle,
          instructions: oneTimeInstructions.trim() || null,
          scheduledDate: oneTimeDate,
          dueTime: oneTimeDue || null,
          priority: oneTimePriority,
          rolloverPolicy: "REMAIN_OVERDUE",
        }),
      });
      oneTimeIdempotencyKey.current = null;
      setOneTimeTitle(""); setOneTimeInstructions(""); setOneTimeDue(""); setOneTimePriority("NORMAL");
      await refreshAll();
      show("One-time assignment created.", "success");
    } catch (err) { show(err instanceof Error ? err.message : "Could not create assignment.", "error"); }
  }

  async function updateAssignment(task: TaskAssignment, patch: { status?: TaskStatus; managerNote?: string | null; assignedToId?: string }) {
    try {
      await apiJson(`/api/tasks/assignments/${task.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await refreshAll();
      show("Assignment updated.", "success");
    } catch (err) { show(err instanceof Error ? err.message : "Could not update assignment.", "error"); }
  }

  async function saveManagerNote(task: TaskAssignment) {
    const value = managerNotes[task.id] ?? task.managerNote ?? "";
    await updateAssignment(task, { managerNote: value.trim() || null });
  }

  async function handOffCount(countId: string, currentAssigneeId?: string | null) {
    const toUserId = countAssignees[countId] ?? currentAssigneeId ?? "";
    if (!toUserId || toUserId === currentAssigneeId || countHandoffBusy) return;
    setCountHandoffBusy(countId);
    try {
      await apiJson(`/api/inventory-truth/counts/${encodeURIComponent(countId)}/reassign`, {
        method: "POST",
        body: JSON.stringify({ toUserId }),
      });
      setCountAssignees((current) => {
        const next = { ...current };
        delete next[countId];
        return next;
      });
      await refreshAll();
      show("Count handed off. Saved progress and ownership history were kept.", "success");
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not hand off count.", "error");
    } finally {
      setCountHandoffBusy(null);
    }
  }

  async function downloadReport() {
    try {
      const response = await apiFetch(`/api/tasks/reports.csv?period=${period}&anchor=${anchor}`);
      if (!response.ok) throw new Error(`Report export failed (${response.status})`);
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? `ContinuiXai-${period.toLowerCase()}-${anchor}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      show("Report downloaded.", "success");
    } catch (err) { show(err instanceof Error ? err.message : "Could not download report.", "error"); }
  }

  const activeTemplates = useMemo(() => templates.filter((template) => template.isActive), [templates]);
  const inactiveTemplates = useMemo(() => templates.filter((template) => !template.isActive), [templates]);

  if (loading || !user) return null;
  if (accessError) return <main className="container work-container"><header className="work-hero compact"><BrandLockup compact /><h1>Team Work</h1></header><section className="card"><p className="error-text">{accessError}</p><button type="button" className="secondary" onClick={() => router.push("/my-work")}>Back to My Work</button></section></main>;

  return (
    <main className="container manager-container">
      <header className="work-hero compact">
        <BrandLockup compact />
        <h1>Team Work</h1>
        <p>{team?.site.name || team?.site.code || "Current site"} · manage assignments, recurring work, and results.</p>
      </header>

      <section className="manager-section">
        <div className="manager-section-title"><div><h2>Employees & Job title</h2><p>Job titles drive recurring assignments.</p></div><button type="button" className="secondary" disabled={busy} onClick={() => void refreshAll()}>{busy ? "Refreshing…" : "Refresh"}</button></div>
        <div className="manager-grid">
          {employees.map((employee) => (
            <article className="card manager-card" key={employee.id}>
              <strong>{employee.name}</strong>
              <span className="manager-muted">{employee.employeeNumber || employee.email}</span>
              <label>Job title
                <select value={employee.jobTitle ?? ""} onChange={(event) => void updateJobTitle(employee, (event.target.value || null) as JobTitle | null)}>
                  <option value="">Unassigned</option>
                  {JOB_TITLES.map((jobTitle) => <option key={jobTitle} value={jobTitle}>{humanizeEnum(jobTitle)}</option>)}
                </select>
              </label>
              <span className="manager-muted">Org role: {humanizeEnum(employee.membershipRole)}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="manager-section" id="template-editor">
        <div className="manager-section-title"><div><h2>Recurring templates</h2><p>Daily, weekly, and monthly work by job title.</p></div><button type="button" onClick={() => void installStarterLibrary()}>Install starter library</button></div>
        <form className="manager-form card" onSubmit={saveTemplate}>
          <div className="manager-form-grid">
            <label>Job title<select value={templateForm.jobTitle} onChange={(e) => setTemplateForm((v) => ({ ...v, jobTitle: e.target.value as JobTitle }))}>{JOB_TITLES.map((v) => <option value={v} key={v}>{humanizeEnum(v)}</option>)}</select></label>
            <label>Recurrence<select value={templateForm.recurrence} onChange={(e) => setTemplateForm((v) => ({ ...v, recurrence: e.target.value as TaskRecurrence }))}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option><option value="ONCE">One time</option></select></label>
            <label>Priority<select value={templateForm.priority} onChange={(e) => setTemplateForm((v) => ({ ...v, priority: e.target.value as TaskPriority }))}>{PRIORITIES.map((v) => <option value={v} key={v}>{humanizeEnum(v)}</option>)}</select></label>
            <label>Rollover<select value={templateForm.rolloverPolicy} onChange={(e) => setTemplateForm((v) => ({ ...v, rolloverPolicy: e.target.value as TaskRolloverPolicy }))}>{ROLLOVER.map((v) => <option value={v} key={v}>{humanizeEnum(v)}</option>)}</select></label>
          </div>
          <label>Task title<input value={templateForm.title} onChange={(e) => setTemplateForm((v) => ({ ...v, title: e.target.value }))} required maxLength={200} /></label>
          <label>Instructions<textarea value={templateForm.instructions} onChange={(e) => setTemplateForm((v) => ({ ...v, instructions: e.target.value }))} rows={2} maxLength={2000} /></label>
          <div className="manager-form-grid">
            <label>Start date<input type="date" value={templateForm.startDate} disabled={!team} onChange={(e) => setTemplateForm((v) => ({ ...v, startDate: e.target.value }))} required /></label>
            <label>End date<input type="date" value={templateForm.endDate} onChange={(e) => setTemplateForm((v) => ({ ...v, endDate: e.target.value }))} /></label>
            <label>Due time<input type="time" value={templateForm.dueTime} onChange={(e) => setTemplateForm((v) => ({ ...v, dueTime: e.target.value }))} /></label>
            {templateForm.recurrence === "WEEKLY" && <label>Weekday<select value={templateForm.weeklyDay} onChange={(e) => setTemplateForm((v) => ({ ...v, weeklyDay: e.target.value }))}>{["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((name, index) => <option key={name} value={index}>{name}</option>)}</select></label>}
            {templateForm.recurrence === "MONTHLY" && <label>Day of month<input type="number" min={1} max={31} value={templateForm.monthlyDay} onChange={(e) => setTemplateForm((v) => ({ ...v, monthlyDay: e.target.value }))} /></label>}
          </div>
          <div className="manager-actions"><button type="submit" disabled={!team || !templateForm.startDate}>{editingTemplateId ? "Update template" : "Create template"}</button>{editingTemplateId && <button type="button" className="secondary" onClick={() => { setEditingTemplateId(null); setTemplateForm(freshTemplate()); }}>Cancel edit</button>}</div>
        </form>

        <div className="manager-table-list">
          {activeTemplates.map((template) => <article className="card manager-row" key={template.id}><div><strong>{template.title}</strong><div className="manager-muted">{humanizeEnum(template.jobTitle)} · {humanizeEnum(template.recurrence)} · {humanizeEnum(template.priority)}{template.dueTime ? ` · ${template.dueTime}` : ""}</div></div><div className="manager-actions"><button type="button" className="secondary" onClick={() => editTemplate(template)}>Edit</button><button type="button" className="secondary" onClick={() => void deactivateTemplate(template)}>Deactivate</button></div></article>)}
          {inactiveTemplates.length > 0 && <details className="card"><summary>{inactiveTemplates.length} inactive template{inactiveTemplates.length === 1 ? "" : "s"}</summary><div className="manager-muted" style={{ marginTop: 8 }}>{inactiveTemplates.map((t) => t.title).join(" · ")}</div></details>}
        </div>
      </section>

      <section className="manager-section">
        <div className="manager-section-title"><div><h2>One-time assignment</h2><p>Assign non-recurring work to one employee.</p></div></div>
        <form className="manager-form card" onSubmit={createOneTime}>
          <div className="manager-form-grid">
            <label>Employee<select value={oneTimeEmployee} onChange={(e) => setOneTimeEmployee(e.target.value)} required><option value="">Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
            <label>Date<input type="date" value={oneTimeDate} disabled={!team} onChange={(e) => setOneTimeDate(e.target.value)} required /></label>
            <label>Due time<input type="time" value={oneTimeDue} onChange={(e) => setOneTimeDue(e.target.value)} /></label>
            <label>Priority<select value={oneTimePriority} onChange={(e) => setOneTimePriority(e.target.value as TaskPriority)}>{PRIORITIES.map((v) => <option key={v} value={v}>{humanizeEnum(v)}</option>)}</select></label>
          </div>
          <label>Task title<input value={oneTimeTitle} onChange={(e) => setOneTimeTitle(e.target.value)} required maxLength={200} /></label>
          <label>Instructions<textarea value={oneTimeInstructions} onChange={(e) => setOneTimeInstructions(e.target.value)} rows={2} maxLength={2000} /></label>
          <button type="submit" disabled={!team || !oneTimeDate}>Assign work</button>
        </form>
      </section>

      <section className="manager-section">
        <div className="manager-section-title"><div><h2>Active counts</h2><p>Hand off the actual active count. Saved count progress and ownership history stay with the count.</p></div><span>{team?.activeCounts.length ?? 0} active</span></div>
        <div className="manager-table-list">
          {team?.activeCounts.map((count) => {
            const selectedAssignee = countAssignees[count.id] ?? count.assignedToId ?? "";
            return <article className="card manager-row manager-assignment" key={count.id}>
              <div className="manager-assignment-main">
                <strong>{count.name || "Store count"}</strong>
                <div className="manager-muted">Current owner: {count.assignedTo?.name ?? "Unassigned"} · started {new Date(count.startedAt).toLocaleString()}</div>
                {count.assignmentEvents.length > 0 && <details><summary>Ownership history</summary><ul className="manager-history">{count.assignmentEvents.map((event) => <li key={event.id}>{event.fromUser?.name ?? "Started"} → {event.toUser.name} · by {event.assignedBy.name}{event.reason ? ` · ${event.reason}` : ""}</li>)}</ul></details>}
              </div>
              <div className="manager-assignment-controls">
                <label>Count owner<select aria-label={`Count owner for ${count.name || "Store count"}`} value={selectedAssignee} onChange={(event) => setCountAssignees((current) => ({ ...current, [count.id]: event.target.value }))}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
                <button type="button" disabled={!selectedAssignee || selectedAssignee === count.assignedToId || countHandoffBusy !== null} onClick={() => void handOffCount(count.id, count.assignedToId)}>{countHandoffBusy === count.id ? "Handing off…" : "Hand off count"}</button>
              </div>
            </article>;
          })}
          {team?.activeCounts.length === 0 && <p className="work-empty">No active counts at this site.</p>}
        </div>
      </section>

      <section className="manager-section">
        <div className="manager-section-title"><div><h2>Team status</h2><p>Open, overdue, completed, skipped, and cancelled work.</p></div><span>{team?.assignments.length ?? 0} assignments</span></div>
        <div className="manager-table-list">
          {team?.assignments.map((task) => (
            <article className="card manager-row manager-assignment" key={task.id}>
              <div className="manager-assignment-main"><strong>{task.title}</strong><div className="manager-muted">{task.assignedTo?.name ?? task.assignedToId} · {task.scheduledDate.slice(0,10)} · {humanizeEnum(task.priority)} · {humanizeEnum(task.status)}</div>{task.employeeNote && <p><strong>Employee note:</strong> {task.employeeNote}</p>}{task.events && task.events.length > 0 && <details><summary>History</summary><ul className="manager-history">{task.events.map((event) => <li key={event.id}>{humanizeEnum(event.action)} · {new Date(event.createdAt).toLocaleString()}</li>)}</ul></details>}</div>
              <div className="manager-assignment-controls">
                <label>{isCountTask(task) ? "Task owner (not count)" : "Assigned to"}<select value={task.assignedToId} onChange={(e) => void updateAssignment(task, { assignedToId: e.target.value })} disabled={task.status === "COMPLETED"}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
                <textarea rows={2} maxLength={2000} value={managerNotes[task.id] ?? task.managerNote ?? ""} onChange={(e) => setManagerNotes((notes) => ({ ...notes, [task.id]: e.target.value }))} placeholder="Manager note" />
                {isCountTask(task) && <p className="manager-muted">Task changes do not hand off or finish the active count. Use Active counts above.</p>}
                <div className="manager-actions"><button type="button" className="secondary" onClick={() => void saveManagerNote(task)}>Save note</button>{task.status === "COMPLETED" ? <button type="button" onClick={() => void updateAssignment(task, { status: "OPEN" })}>Reopen</button> : <><button type="button" onClick={() => void updateAssignment(task, { status: "COMPLETED" })}>{isCountTask(task) ? "Complete task only" : "Complete"}</button><button type="button" className="secondary" onClick={() => void updateAssignment(task, { status: "SKIPPED" })}>Skip</button><button type="button" className="secondary" onClick={() => void updateAssignment(task, { status: "CANCELLED" })}>Cancel</button></>}</div>
              </div>
            </article>
          ))}
          {team?.assignments.length === 0 && <p className="work-empty">No team assignments in this range.</p>}
        </div>
      </section>

      <section className="manager-section">
        <div className="manager-section-title"><div><h2>Reports</h2><p>Daily, weekly, and monthly work plus count activity.</p></div><button type="button" onClick={() => void downloadReport()}>Export CSV</button></div>
        <div className="manager-report-controls card"><label>Period<select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></select></label><label>Anchor date<input type="date" value={anchor} disabled={!team} onChange={(e) => setAnchor(e.target.value)} /></label></div>
        {report && <><div className="summary-grid"><div className="summary-stat"><strong>{report.totals.assignments ?? 0}</strong><span>Assignments</span></div><div className="summary-stat"><strong>{report.totals.COMPLETED ?? 0}</strong><span>Completed</span></div><div className="summary-stat"><strong>{report.totals.OPEN ?? 0}</strong><span>Open</span></div><div className="summary-stat"><strong>{report.countActivity.sessions}</strong><span>Count sessions</span></div><div className="summary-stat"><strong>{report.countActivity.locations}</strong><span>Locations</span></div><div className="summary-stat"><strong>{report.countActivity.units}</strong><span>Units</span></div></div><div className="manager-table-list">{report.employees.map((row) => <div className="card manager-row" key={row.userId}><div><strong>{row.name}</strong><div className="manager-muted">{row.employeeNumber || "No employee number"}</div></div><div className="manager-kpis"><span>{row.completed} completed</span><span>{row.open} open</span><span>{row.overdue} overdue</span></div></div>)}</div></>}
      </section>
    </main>
  );
}
