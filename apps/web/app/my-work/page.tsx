"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";
import { countTaskActionLabel, greetingForTimeZone, groupAssignments, humanizeEnum, isCountTask } from "../../lib/taskPresentation";
import type { MyWorkResponse, TaskAssignment, TaskStatus } from "../../lib/types";
import { BrandLockup } from "../../components/BrandLockup";

function formatSiteDate(date: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone }).format(new Date(`${date}T12:00:00Z`));
  } catch {
    return date;
  }
}

function formatDue(dueAt: string | null | undefined, timeZone: string): string | null {
  if (!dueAt) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(dueAt));
  } catch {
    return null;
  }
}

function priorityClass(priority: string): string {
  if (priority === "URGENT") return "work-priority urgent";
  if (priority === "HIGH") return "work-priority high";
  return "work-priority";
}

function TaskCard({ task, today, timeZone, onUpdate }: {
  task: TaskAssignment;
  today: string;
  timeZone: string;
  onUpdate: (task: TaskAssignment, patch: { status?: TaskStatus; employeeNote?: string | null }) => Promise<void>;
}) {
  const [note, setNote] = useState(task.employeeNote ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => setNote(task.employeeNote ?? ""), [task.employeeNote]);
  const due = formatDue(task.dueAt, timeZone);
  const isCompleted = task.status === "COMPLETED";
  const isSkipped = task.status === "SKIPPED";
  const isPharmacy = task.jobTitle === "PHARMACY_TEAM";
  const isOverdue = task.status !== "COMPLETED" && task.scheduledDate.slice(0, 10) < today;
  const scanTask = isCountTask(task);

  async function update(patch: { status?: TaskStatus; employeeNote?: string | null }) {
    setSaving(true);
    try { await onUpdate(task, patch); } finally { setSaving(false); }
  }

  return (
    <article className={`work-task-card ${isCompleted ? "completed" : ""}`}>
      <div className="work-task-topline">
        <span className={priorityClass(task.priority)}>{humanizeEnum(task.priority)}</span>
        <span className="work-task-meta">{humanizeEnum(task.recurrence)}{due ? ` · ${due}` : ""}</span>
      </div>
      <h3>{task.title}</h3>
      {task.instructions && <p className="work-task-instructions">{task.instructions}</p>}
      {isOverdue && <div className="work-overdue-note">Overdue{task.rolloverPolicy === "ROLL_FORWARD" ? " · carried forward" : ""}</div>}
      {task.managerNote && <div className="work-manager-note"><strong>Manager note:</strong> {task.managerNote}</div>}
      {isPharmacy && (
        <div className="work-phi-warning">
          <strong>Privacy reminder:</strong> Do not enter patient names, prescriptions, diagnoses, dates of birth, or other protected health information in task notes.
        </div>
      )}
      {scanTask && !isCompleted && (
        <><Link href="/store-count" className="work-link-button">{countTaskActionLabel(task)}</Link><p className="work-task-instructions">Finish the active count in Count. Marking this task done only updates My Work.</p></>
      )}
      <div className="work-task-actions" aria-label={`Actions for ${task.title}`}>
        {isSkipped && <span className="work-complete-badge">Skipped</span>}
        {!isCompleted && !isSkipped && task.status === "OPEN" && <button type="button" className="secondary" disabled={saving} onClick={() => void update({ status: "IN_PROGRESS" })}>Start task</button>}
        {!isCompleted && !isSkipped && <button type="button" disabled={saving} onClick={() => void update({ status: "COMPLETED" })}>{scanTask ? "Mark task done" : "Complete"}</button>}
        {isCompleted && <span className="work-complete-badge">Completed</span>}
      </div>
      {!isSkipped && <>
        <label className="work-note-label">
          Employee note
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} rows={2} placeholder="Optional operational note" />
        </label>
        <button type="button" className="secondary" disabled={saving || note === (task.employeeNote ?? "")} onClick={() => void update({ employeeNote: note.trim() || null })}>
          {saving ? "Saving…" : "Save note"}
        </button>
      </>}
    </article>
  );
}

function WorkSection({ title, tasks, empty, today, timeZone, onUpdate }: {
  title: string;
  tasks: TaskAssignment[];
  empty: string;
  today: string;
  timeZone: string;
  onUpdate: (task: TaskAssignment, patch: { status?: TaskStatus; employeeNote?: string | null }) => Promise<void>;
}) {
  return (
    <section className="work-section">
      <div className="work-section-heading"><h2>{title}</h2><span>{tasks.length}</span></div>
      {tasks.length === 0 ? <p className="work-empty">{empty}</p> : tasks.map((task) => <TaskCard key={task.id} task={task} today={today} timeZone={timeZone} onUpdate={onUpdate} />)}
    </section>
  );
}

export default function MyWorkPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { show } = useToast();
  const [data, setData] = useState<MyWorkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const workRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!loading && !user) router.replace("/login"); }, [loading, user, router]);

  async function refresh() {
    if (!user) return;
    setRefreshing(true);
    try {
      setData(await apiJson<MyWorkResponse>("/api/tasks/me?days=7"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your work.");
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => { if (user) void refresh(); }, [user]);

  const grouped = useMemo(() => data ? groupAssignments(data.assignments, data.date) : null, [data]);
  const availableCountTask = data?.assignments.find((task) => task.status !== "COMPLETED" && isCountTask(task)) ?? null;

  async function updateTask(task: TaskAssignment, patch: { status?: TaskStatus; employeeNote?: string | null }) {
    try {
      await apiJson(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await refresh();
      if (patch.status === "COMPLETED") show("Task completed.", "success");
      else show("Task updated.", "success");
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not update task.", "error");
    }
  }

  function startDay() {
    if (data) sessionStorage.setItem("continuixai_ops_day_started", data.date);
    workRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (loading || !user) return null;

  return (
    <main className="container work-container">
      <header className="work-hero">
        <BrandLockup compact />
        {data ? (
          <>
            <h1>{greetingForTimeZone(user.name, new Date(), data.site.timeZone)}</h1>
            <p>{formatSiteDate(data.date, data.site.timeZone)} · {data.site.name || data.site.code}</p>
            <div className="work-hero-actions">
              <button type="button" onClick={startDay}>Start My Day</button>
              {availableCountTask && <Link href="/store-count" className="work-link-button secondary-link">{countTaskActionLabel(availableCountTask)}</Link>}
              {data.managerAccess && <Link href="/team-work" className="work-link-button secondary-link">Team Work</Link>}
            </div>
          </>
        ) : <h1>My Work</h1>}
      </header>

      {error && <section className="card"><p className="error-text">{error}</p><button type="button" onClick={() => void refresh()}>Try again</button></section>}
      {!data && !error && <section className="card"><p>Loading today’s work…</p></section>}

      {data && grouped && (
        <div ref={workRef} className="work-list">
          <WorkSection title="Overdue" tasks={grouped.overdue} empty="No overdue work." today={data.date} timeZone={data.site.timeZone} onUpdate={updateTask} />
          <WorkSection title="Today" tasks={grouped.today} empty="No work is due today." today={data.date} timeZone={data.site.timeZone} onUpdate={updateTask} />
          <WorkSection title="This week" tasks={grouped.thisWeek} empty="Nothing else is scheduled in the next seven days." today={data.date} timeZone={data.site.timeZone} onUpdate={updateTask} />
          <WorkSection title="Completed today" tasks={grouped.completedToday} empty="Completed tasks will appear here." today={data.date} timeZone={data.site.timeZone} onUpdate={updateTask} />
          <WorkSection title="Skipped today" tasks={grouped.skippedToday} empty="No work was skipped today." today={data.date} timeZone={data.site.timeZone} onUpdate={updateTask} />
          <div className="work-footer-actions">
            <Link href="/daily-summary" className="work-link-button">Review today & sign out</Link>
            <button type="button" className="secondary" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh"}</button>
          </div>
        </div>
      )}
    </main>
  );
}
