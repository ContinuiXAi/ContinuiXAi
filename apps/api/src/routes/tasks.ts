import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ensurePilotSiteForUser } from "../lib/pilotSite.js";
import { encodeCsvRow } from "../lib/csv.js";
import { STARTER_TASK_CATALOG } from "../lib/taskCatalog.js";
import { canManageTasks, dateOnly, dueAtForDate, isTemplateDue, localDateInTimeZone } from "../lib/taskSchedule.js";
import { isScheduledBefore, reportDateRange, taskEventAction, taskSnapshotData, type ReportPeriod } from "../lib/taskWorkflow.js";

const jobTitleSchema = z.enum([
  "STORE_MANAGER",
  "INVENTORY_MANAGER",
  "STOCK_COUNT_ASSOCIATE",
  "RECEIVER",
  "CASHIER_CUSTOMER_SERVICE",
  "PHARMACY_TEAM",
]);
const recurrenceSchema = z.enum(["ONCE", "DAILY", "WEEKLY", "MONTHLY"]);
const prioritySchema = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
const rolloverSchema = z.enum(["REMAIN_OVERDUE", "ROLL_FORWARD", "SKIP"]);
const employeeStatusSchema = z.enum(["OPEN", "IN_PROGRESS", "COMPLETED"]);
const managerStatusSchema = z.enum(["OPEN", "IN_PROGRESS", "COMPLETED", "SKIPPED", "CANCELLED"]);
const reportPeriodSchema = z.enum(["DAILY", "WEEKLY", "MONTHLY"]);

const templateFields = {
  jobTitle: jobTitleSchema,
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(2000).nullable().optional(),
  recurrence: recurrenceSchema,
  startDate: z.string(),
  endDate: z.string().nullable().optional(),
  weeklyDay: z.number().int().min(0).max(6).nullable().optional(),
  monthlyDay: z.number().int().min(1).max(31).nullable().optional(),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  priority: prioritySchema.default("NORMAL"),
  rolloverPolicy: rolloverSchema.default("REMAIN_OVERDUE"),
};

const templateInputSchema = z.object(templateFields).superRefine((value, ctx) => {
  if (!dateOnly(value.startDate)) ctx.addIssue({ code: "custom", path: ["startDate"], message: "Start date must be YYYY-MM-DD." });
  if (value.endDate && !dateOnly(value.endDate)) ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must be YYYY-MM-DD." });
  if (value.recurrence === "WEEKLY" && value.weeklyDay == null) ctx.addIssue({ code: "custom", path: ["weeklyDay"], message: "Weekly tasks require a weekday." });
  if (value.recurrence === "MONTHLY" && value.monthlyDay == null) ctx.addIssue({ code: "custom", path: ["monthlyDay"], message: "Monthly tasks require a day of month." });
});

const templatePatchSchema = z.object({
  jobTitle: jobTitleSchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  instructions: z.string().trim().max(2000).nullable().optional(),
  recurrence: recurrenceSchema.optional(),
  startDate: z.string().optional(),
  endDate: z.string().nullable().optional(),
  weeklyDay: z.number().int().min(0).max(6).nullable().optional(),
  monthlyDay: z.number().int().min(1).max(31).nullable().optional(),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  priority: prioritySchema.optional(),
  rolloverPolicy: rolloverSchema.optional(),
  isActive: z.boolean().optional(),
});

const assignmentUpdateSchema = z.object({
  status: employeeStatusSchema.optional(),
  employeeNote: z.string().trim().max(2000).nullable().optional(),
});

const oneTimeAssignmentSchema = z.object({
  idempotencyKey: z.string().trim().min(16).max(100),
  assignedToId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(2000).nullable().optional(),
  scheduledDate: z.string(),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  priority: prioritySchema.default("NORMAL"),
  rolloverPolicy: rolloverSchema.default("REMAIN_OVERDUE"),
});

const managerAssignmentUpdateSchema = z.object({
  status: managerStatusSchema.optional(),
  managerNote: z.string().trim().max(2000).nullable().optional(),
  assignedToId: z.string().trim().min(1).optional(),
});

type TaskContext = {
  site: { id: string; organizationId: string; timeZone: string; name: string; code: string };
  platformRole: string;
  membershipRole: string;
};

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

async function taskContext(userId: string, platformRole: string): Promise<TaskContext | null> {
  const site = await ensurePilotSiteForUser(userId, platformRole);
  if (!site) return null;
  const membership = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: site.organizationId, userId } },
    select: { role: true, isActive: true },
  });
  if (!membership?.isActive) return null;
  return { site, platformRole, membershipRole: membership.role };
}

function isManager(context: TaskContext): boolean {
  return canManageTasks(context.platformRole, context.membershipRole);
}

async function requireManagerContext(userId: string, platformRole: string): Promise<TaskContext | null> {
  const context = await taskContext(userId, platformRole);
  return context && isManager(context) ? context : null;
}

async function generateAssignmentsForUser(userId: string, context: TaskContext, scheduledDate: Date) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { jobTitle: true, isActive: true } });
  if (!user?.isActive || !user.jobTitle) return;

  const templates = await prisma.taskTemplate.findMany({
    where: {
      organizationId: context.site.organizationId,
      OR: [{ siteId: null }, { siteId: context.site.id }],
      jobTitle: user.jobTitle,
      isActive: true,
    },
  });
  const due = templates.filter((template) => isTemplateDue(template, scheduledDate));
  if (!due.length) return;

  await prisma.taskAssignment.createMany({
    data: due.map((template) => taskSnapshotData(
      template,
      context.site.id,
      userId,
      scheduledDate,
      dueAtForDate(scheduledDate, template.dueTime, context.site.timeZone),
    )),
    skipDuplicates: true,
  });
}

async function materializeWorkWindow(userId: string, context: TaskContext, startDate: Date, days = 7) {
  for (let offset = 0; offset < days; offset += 1) {
    await generateAssignmentsForUser(userId, context, addUtcDays(startDate, offset));
  }
}

async function materializeTeamWorkWindow(context: TaskContext, startDate: Date, endDate: Date) {
  const today = localDateInTimeZone(new Date(), context.site.timeZone);
  if (!today) return;
  const firstDate = startDate < today ? today : startDate;
  if (endDate < firstDate) return;
  const spanDays = Math.min(31, Math.floor((endDate.getTime() - firstDate.getTime()) / 86400000) + 1);
  const memberships = await prisma.organizationMembership.findMany({
    where: {
      organizationId: context.site.organizationId,
      isActive: true,
      user: { isActive: true, jobTitle: { not: null } },
    },
    select: { userId: true },
  });
  for (const membership of memberships) {
    await materializeWorkWindow(membership.userId, context, firstDate, spanDays);
  }
}

async function applyAutomaticSkip(context: TaskContext, today: Date) {
  const stale = await prisma.taskAssignment.findMany({
    where: {
      organizationId: context.site.organizationId,
      siteId: context.site.id,
      scheduledDate: { lt: today },
      rolloverPolicy: "SKIP",
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
    select: { id: true, organizationId: true, siteId: true, status: true, updatedAt: true },
    take: 500,
  });
  for (const assignment of stale) {
    await prisma.$transaction(async (tx) => {
      const changed = await tx.taskAssignment.updateMany({
        where: { id: assignment.id, status: assignment.status, updatedAt: assignment.updatedAt },
        data: { status: "SKIPPED" },
      });
      if (changed.count === 1) {
        await tx.taskAssignmentEvent.create({
          data: {
            assignmentId: assignment.id,
            organizationId: assignment.organizationId,
            siteId: assignment.siteId,
            actorUserId: null,
            action: "AUTO_SKIPPED",
            fromStatus: assignment.status,
            toStatus: "SKIPPED",
          },
        });
      }
    });
  }
}

function localDayBounds(date: Date, timeZone: string): { start: Date; endExclusive: Date } | null {
  const start = dueAtForDate(date, "00:00", timeZone);
  const endExclusive = dueAtForDate(addUtcDays(date, 1), "00:00", timeZone);
  return start && endExclusive ? { start, endExclusive } : null;
}

async function employeeDailySummary(userId: string, context: TaskContext, date: Date) {
  const bounds = localDayBounds(date, context.site.timeZone);
  if (!bounds) throw new Error("INVALID_TIME_ZONE");

  await materializeWorkWindow(userId, context, date, 7);
  await applyAutomaticSkip(context, date);

  const [completedTasks, skippedTasks, openTasks, completedSessions] = await Promise.all([
    prisma.taskAssignment.findMany({
      where: {
        assignedToId: userId,
        organizationId: context.site.organizationId,
        siteId: context.site.id,
        status: "COMPLETED",
        completedAt: { gte: bounds.start, lt: bounds.endExclusive },
      },
      orderBy: { completedAt: "asc" },
    }),
    prisma.taskAssignment.findMany({
      where: {
        assignedToId: userId,
        organizationId: context.site.organizationId,
        siteId: context.site.id,
        status: "SKIPPED",
        scheduledDate: date,
      },
      orderBy: { updatedAt: "asc" },
    }),
    prisma.taskAssignment.findMany({
      where: {
        assignedToId: userId,
        organizationId: context.site.organizationId,
        siteId: context.site.id,
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
      orderBy: [{ scheduledDate: "asc" }, { priority: "desc" }, { dueAt: "asc" }],
      take: 250,
    }),
    prisma.storeCountSession.findMany({
      where: {
        siteId: context.site.id,
        status: "COMPLETED",
        completedAt: { gte: bounds.start, lt: bounds.endExclusive },
        OR: [{ startedById: userId }, { entries: { some: { countedByUserId: userId } } }],
      },
      select: {
        id: true,
        name: true,
        startedAt: true,
        completedAt: true,
        entries: {
          where: { countedByUserId: userId },
          select: { locationId: true, productId: true, barcodeValue: true, quantity: true },
        },
      },
      orderBy: { completedAt: "asc" },
    }),
  ]);

  const locationIds = new Set<string>();
  const productKeys = new Set<string>();
  let unitsCounted = 0;
  let durationMinutes = 0;
  for (const session of completedSessions) {
    if (session.completedAt) durationMinutes += Math.max(0, Math.round((session.completedAt.getTime() - session.startedAt.getTime()) / 60000));
    for (const entry of session.entries) {
      locationIds.add(entry.locationId);
      productKeys.add(entry.productId ?? `barcode:${entry.barcodeValue}`);
      unitsCounted += entry.quantity;
    }
  }

  const overdue = openTasks.filter((task) => isScheduledBefore(task.scheduledDate, date));
  const nextUpcoming = openTasks.find((task) => !isScheduledBefore(task.scheduledDate, date)) ?? null;
  return {
    date: dateKey(date),
    site: context.site,
    tasks: {
      completed: completedTasks,
      skipped: skippedTasks,
      open: openTasks,
      overdueCount: overdue.length,
      nextUpcoming,
    },
    counts: {
      sessionsCompleted: completedSessions.length,
      locationsCounted: locationIds.size,
      uniqueProducts: productKeys.size,
      unitsCounted,
      durationMinutes,
      sessions: completedSessions.map(({ entries: _entries, ...session }) => session),
    },
  };
}

async function managerReport(context: TaskContext, period: ReportPeriod, anchor: Date) {
  const { start, end } = reportDateRange(period, anchor);
  const endExclusive = addUtcDays(end, 1);
  const assignments = await prisma.taskAssignment.findMany({
    where: {
      organizationId: context.site.organizationId,
      siteId: context.site.id,
      scheduledDate: { gte: start, lt: endExclusive },
    },
    include: { assignedTo: { select: { id: true, name: true, employeeNumber: true, jobTitle: true } } },
    orderBy: [{ scheduledDate: "asc" }, { assignedTo: { name: "asc" } }, { priority: "desc" }],
    take: 5000,
  });

  const statusCounts: Record<string, number> = { OPEN: 0, IN_PROGRESS: 0, COMPLETED: 0, SKIPPED: 0, CANCELLED: 0 };
  const employees = new Map<string, { userId: string; name: string; employeeNumber: string | null; completed: number; open: number; overdue: number; total: number }>();
  for (const task of assignments) {
    statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
    const row = employees.get(task.assignedToId) ?? {
      userId: task.assignedToId,
      name: task.assignedTo.name,
      employeeNumber: task.assignedTo.employeeNumber,
      completed: 0,
      open: 0,
      overdue: 0,
      total: 0,
    };
    row.total += 1;
    if (task.status === "COMPLETED") row.completed += 1;
    if (task.status === "OPEN" || task.status === "IN_PROGRESS") {
      row.open += 1;
      if (isScheduledBefore(task.scheduledDate, anchor)) row.overdue += 1;
    }
    employees.set(task.assignedToId, row);
  }

  const boundsStart = localDayBounds(start, context.site.timeZone)?.start;
  const boundsEnd = localDayBounds(end, context.site.timeZone)?.endExclusive;
  const countSessions = boundsStart && boundsEnd ? await prisma.storeCountSession.findMany({
    where: { siteId: context.site.id, status: "COMPLETED", completedAt: { gte: boundsStart, lt: boundsEnd } },
    select: { id: true, entries: { select: { locationId: true, productId: true, barcodeValue: true, quantity: true } } },
  }) : [];
  const locations = new Set<string>();
  const products = new Set<string>();
  let units = 0;
  for (const session of countSessions) {
    for (const entry of session.entries) {
      locations.add(entry.locationId);
      products.add(entry.productId ?? `barcode:${entry.barcodeValue}`);
      units += entry.quantity;
    }
  }

  return {
    period,
    anchor: dateKey(anchor),
    start: dateKey(start),
    end: dateKey(end),
    site: context.site,
    totals: { assignments: assignments.length, ...statusCounts },
    employees: [...employees.values()].sort((a, b) => a.name.localeCompare(b.name)),
    countActivity: { sessions: countSessions.length, locations: locations.size, products: products.size, units },
    assignments,
  };
}

export async function taskRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/me", async (request, reply) => {
    const query = z.object({ date: z.string().optional(), days: z.coerce.number().int().min(1).max(31).default(7) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const context = await taskContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "No authorized task site is available." });
    const scheduledDate = query.data.date ? dateOnly(query.data.date) : localDateInTimeZone(new Date(), context.site.timeZone);
    if (!scheduledDate) return reply.code(400).send({ error: "Date or site time zone is invalid." });

    await materializeWorkWindow(request.user.sub, context, scheduledDate, query.data.days);
    await applyAutomaticSkip(context, scheduledDate);
    const dayBounds = localDayBounds(scheduledDate, context.site.timeZone);
    if (!dayBounds) return reply.code(400).send({ error: "Site time zone is invalid." });
    const assignments = await prisma.taskAssignment.findMany({
      where: {
        assignedToId: request.user.sub,
        organizationId: context.site.organizationId,
        siteId: context.site.id,
        OR: [
          { scheduledDate: { lte: addUtcDays(scheduledDate, query.data.days - 1) }, status: { in: ["OPEN", "IN_PROGRESS"] } },
          { completedAt: { gte: dayBounds.start, lt: dayBounds.endExclusive }, status: "COMPLETED" },
          { scheduledDate, status: "SKIPPED" },
        ],
      },
      orderBy: [{ scheduledDate: "asc" }, { priority: "desc" }, { dueAt: "asc" }, { createdAt: "asc" }],
      take: 500,
    });
    return { date: dateKey(scheduledDate), site: context.site, managerAccess: isManager(context), assignments };
  });

  app.get("/me/summary", async (request, reply) => {
    const query = z.object({ date: z.string().optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const context = await taskContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "No authorized task site is available." });
    const date = query.data.date ? dateOnly(query.data.date) : localDateInTimeZone(new Date(), context.site.timeZone);
    if (!date) return reply.code(400).send({ error: "Date or site time zone is invalid." });
    try {
      return await employeeDailySummary(request.user.sub, context, date);
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_TIME_ZONE") return reply.code(400).send({ error: "Site time zone is invalid." });
      throw error;
    }
  });

  app.patch("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = assignmentUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const context = await taskContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "No authorized task site is available." });
    const assignment = await prisma.taskAssignment.findFirst({
      where: { id, assignedToId: request.user.sub, organizationId: context.site.organizationId, siteId: context.site.id },
    });
    if (!assignment) return reply.code(404).send({ error: "Task not found." });
    if (assignment.status === "CANCELLED" || assignment.status === "SKIPPED") return reply.code(409).send({ error: "This task can no longer be changed by the employee." });
    if (assignment.status === "COMPLETED" && parsed.data.status && parsed.data.status !== "COMPLETED") {
      return reply.code(409).send({ error: "Completed tasks cannot be reopened by employees." });
    }

    const status = parsed.data.status ?? assignment.status;
    const becomesCompleted = assignment.status !== "COMPLETED" && status === "COMPLETED";
    const noteProvided = Object.prototype.hasOwnProperty.call(parsed.data, "employeeNote");
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.taskAssignment.updateMany({
        where: {
          id,
          assignedToId: request.user.sub,
          organizationId: context.site.organizationId,
          siteId: context.site.id,
          updatedAt: assignment.updatedAt,
        },
        data: {
          status,
          ...(noteProvided ? { employeeNote: parsed.data.employeeNote } : {}),
          ...(becomesCompleted ? { completedAt: new Date(), completedById: request.user.sub } : {}),
        },
      });
      if (changed.count !== 1) return null;
      if (status !== assignment.status || noteProvided) {
        await tx.taskAssignmentEvent.create({
          data: {
            assignmentId: assignment.id,
            organizationId: assignment.organizationId,
            siteId: assignment.siteId,
            actorUserId: request.user.sub,
            action: taskEventAction(assignment.status, status),
            fromStatus: assignment.status,
            toStatus: status,
          },
        });
      }
      return tx.taskAssignment.findUniqueOrThrow({ where: { id } });
    });
    if (!updated) return reply.code(409).send({ error: "This task changed while you were editing it. Refresh and try again." });
    return updated;
  });

  app.get("/employees", async (request, reply) => {
    const context = await requireManagerContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "Manager access required." });
    const memberships = await prisma.organizationMembership.findMany({
      where: { organizationId: context.site.organizationId, isActive: true, user: { isActive: true, siteMemberships: { some: { siteId: context.site.id, isActive: true } } } },
      select: {
        role: true,
        user: { select: { id: true, name: true, email: true, employeeNumber: true, role: true, jobTitle: true, isActive: true } },
      },
      orderBy: { user: { name: "asc" } },
    });
    return memberships.map((membership) => ({ ...membership.user, membershipRole: membership.role }));
  });

  app.get("/team", async (request, reply) => {
    const context = await requireManagerContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "Manager access required." });
    const query = z.object({ start: z.string().optional(), end: z.string().optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const today = localDateInTimeZone(new Date(), context.site.timeZone);
    if (!today) return reply.code(400).send({ error: "Site time zone is invalid." });
    const start = query.data.start ? dateOnly(query.data.start) : addUtcDays(today, -7);
    const end = query.data.end ? dateOnly(query.data.end) : addUtcDays(today, 7);
    if (!start || !end || end < start) return reply.code(400).send({ error: "Invalid team date range." });

    await materializeTeamWorkWindow(context, start, end);

    const [assignments, activeCounts] = await Promise.all([prisma.taskAssignment.findMany({
      where: {
        organizationId: context.site.organizationId,
        siteId: context.site.id,
        OR: [
          { status: { in: ["OPEN", "IN_PROGRESS"] }, scheduledDate: { lte: end } },
          { scheduledDate: { gte: start, lte: end } },
        ],
      },
      include: {
        assignedTo: { select: { id: true, name: true, employeeNumber: true, jobTitle: true } },
        events: { orderBy: { createdAt: "desc" }, take: 5, select: { id: true, action: true, fromStatus: true, toStatus: true, actorUserId: true, createdAt: true } },
      },
      orderBy: [{ scheduledDate: "asc" }, { priority: "desc" }, { dueAt: "asc" }],
      take: 1000,
    }), prisma.storeCountSession.findMany({
      where: { siteId: context.site.id, status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        startedAt: true,
        assignedToId: true,
        assignedTo: { select: { id: true, name: true, employeeNumber: true } },
        assignmentEvents: {
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: 20,
          include: {
            fromUser: { select: { id: true, name: true } },
            toUser: { select: { id: true, name: true } },
            assignedBy: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    })]);
    return { date: dateKey(today), site: context.site, assignments, activeCounts };
  });

  app.get("/templates", async (request, reply) => {
    const context = await requireManagerContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "Manager access required." });
    return prisma.taskTemplate.findMany({
      where: { organizationId: context.site.organizationId, OR: [{ siteId: null }, { siteId: context.site.id }] },
      orderBy: [{ isActive: "desc" }, { jobTitle: "asc" }, { priority: "desc" }, { title: "asc" }],
    });
  });

  app.post("/templates/starter-library", async (request, reply) => {
    const context = await requireManagerContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "Manager access required." });
    const startDate = localDateInTimeZone(new Date(), context.site.timeZone);
    if (!startDate) return reply.code(400).send({ error: "Site time zone is invalid." });

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`starter-tasks:${context.site.organizationId}:${context.site.id}`}))`;
      const existing = await tx.taskTemplate.findMany({
        where: { organizationId: context.site.organizationId, siteId: context.site.id },
        select: { jobTitle: true, recurrence: true, title: true },
      });
      const keys = new Set(existing.map((template) => `${template.jobTitle}|${template.recurrence}|${template.title}`));
      const missing = STARTER_TASK_CATALOG.filter((template) => !keys.has(`${template.jobTitle}|${template.recurrence}|${template.title}`));
      if (missing.length) {
        await tx.taskTemplate.createMany({
          data: missing.map((template) => ({
            organizationId: context.site.organizationId,
            siteId: context.site.id,
            jobTitle: template.jobTitle,
            title: template.title,
            instructions: template.jobTitle === "PHARMACY_TEAM" ? "Operational work only. Do not enter patient names, prescriptions, diagnoses, dates of birth, or other protected health information." : null,
            recurrence: template.recurrence,
            startDate,
            endDate: null,
            weeklyDay: template.recurrence === "WEEKLY" ? 1 : null,
            monthlyDay: template.recurrence === "MONTHLY" ? 1 : null,
            dueTime: null,
            priority: template.priority,
            rolloverPolicy: "REMAIN_OVERDUE",
            createdById: request.user.sub,
            updatedById: request.user.sub,
          })),
        });
      }
      return { installed: missing.length, existing: existing.length };
    });
    return reply.send({ ...result, totalCatalog: STARTER_TASK_CATALOG.length });
  });

  app.post("/templates", async (request, reply) => {
    const parsed = templateInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const context = await requireManagerContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "Manager access required." });
    const startDate = dateOnly(parsed.data.startDate)!;
    const endDate = parsed.data.endDate ? dateOnly(parsed.data.endDate) : null;
    if (endDate && endDate < startDate) return reply.code(400).send({ error: "End date cannot be before start date." });

    const template = await prisma.taskTemplate.create({
      data: {
        organizationId: context.site.organizationId,
        siteId: context.site.id,
        jobTitle: parsed.data.jobTitle,
        title: parsed.data.title,
        instructions: parsed.data.instructions,
        recurrence: parsed.data.recurrence,
        startDate,
        endDate,
        weeklyDay: parsed.data.recurrence === "WEEKLY" ? parsed.data.weeklyDay : null,
        monthlyDay: parsed.data.recurrence === "MONTHLY" ? parsed.data.monthlyDay : null,
        dueTime: parsed.data.dueTime,
        priority: parsed.data.priority,
        rolloverPolicy: parsed.data.rolloverPolicy,
        createdById: request.user.sub,
        updatedById: request.user.sub,
      },
    });
    return reply.code(201).send(template);
  });

  app.patch("/templates/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = templatePatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const context = await requireManagerContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "Manager access required." });
    const existing = await prisma.taskTemplate.findFirst({
      where: { id, organizationId: context.site.organizationId, OR: [{ siteId: null }, { siteId: context.site.id }] },
    });
    if (!existing) return reply.code(404).send({ error: "Task template not found." });

    const merged = {
      jobTitle: parsed.data.jobTitle ?? existing.jobTitle,
      title: parsed.data.title ?? existing.title,
      instructions: Object.prototype.hasOwnProperty.call(parsed.data, "instructions") ? parsed.data.instructions : existing.instructions,
      recurrence: parsed.data.recurrence ?? existing.recurrence,
      startDate: parsed.data.startDate ?? dateKey(existing.startDate),
      endDate: Object.prototype.hasOwnProperty.call(parsed.data, "endDate") ? parsed.data.endDate : existing.endDate ? dateKey(existing.endDate) : null,
      weeklyDay: Object.prototype.hasOwnProperty.call(parsed.data, "weeklyDay") ? parsed.data.weeklyDay : existing.weeklyDay,
      monthlyDay: Object.prototype.hasOwnProperty.call(parsed.data, "monthlyDay") ? parsed.data.monthlyDay : existing.monthlyDay,
      dueTime: Object.prototype.hasOwnProperty.call(parsed.data, "dueTime") ? parsed.data.dueTime : existing.dueTime,
      priority: parsed.data.priority ?? existing.priority,
      rolloverPolicy: parsed.data.rolloverPolicy ?? existing.rolloverPolicy,
    };
    const validated = templateInputSchema.safeParse(merged);
    if (!validated.success) return reply.code(400).send({ error: validated.error.flatten() });
    const startDate = dateOnly(validated.data.startDate)!;
    const endDate = validated.data.endDate ? dateOnly(validated.data.endDate) : null;
    if (endDate && endDate < startDate) return reply.code(400).send({ error: "End date cannot be before start date." });

    return prisma.taskTemplate.update({
      where: { id },
      data: {
        jobTitle: validated.data.jobTitle,
        title: validated.data.title,
        instructions: validated.data.instructions,
        recurrence: validated.data.recurrence,
        startDate,
        endDate,
        weeklyDay: validated.data.recurrence === "WEEKLY" ? validated.data.weeklyDay : null,
        monthlyDay: validated.data.recurrence === "MONTHLY" ? validated.data.monthlyDay : null,
        dueTime: validated.data.dueTime,
        priority: validated.data.priority,
        rolloverPolicy: validated.data.rolloverPolicy,
        ...(parsed.data.isActive === undefined ? {} : { isActive: parsed.data.isActive }),
        updatedById: request.user.sub,
      },
    });
  });

  app.delete("/templates/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const context = await requireManagerContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "Manager access required." });
    const existing = await prisma.taskTemplate.findFirst({
      where: { id, organizationId: context.site.organizationId, OR: [{ siteId: null }, { siteId: context.site.id }] },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: "Task template not found." });
    const updated = await prisma.taskTemplate.update({ where: { id }, data: { isActive: false, updatedById: request.user.sub } });
    return reply.send(updated);
  });

  app.post("/assignments", async (request, reply) => {
    const parsed = oneTimeAssignmentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const context = await requireManagerContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "Manager access required." });
    const scheduledDate = dateOnly(parsed.data.scheduledDate);
    if (!scheduledDate) return reply.code(400).send({ error: "Scheduled date must be YYYY-MM-DD." });
    const membership = await prisma.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId: context.site.organizationId, userId: parsed.data.assignedToId } },
      select: { isActive: true, user: { select: { id: true, isActive: true, jobTitle: true, siteMemberships: { where: { siteId: context.site.id, isActive: true }, select: { id: true }, take: 1 } } } },
    });
    if (!membership?.isActive || !membership.user.isActive || membership.user.siteMemberships.length === 0) return reply.code(404).send({ error: "Active employee for this site not found." });
    if (!membership.user.jobTitle) return reply.code(409).send({ error: "Assign a job title before assigning work." });

    const existingRetry = await prisma.taskAssignment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: context.site.organizationId, idempotencyKey: parsed.data.idempotencyKey } } });
    if (existingRetry) {
      const sameRequest = existingRetry.organizationId === context.site.organizationId
        && existingRetry.siteId === context.site.id
        && existingRetry.assignedToId === membership.user.id
        && existingRetry.title === parsed.data.title
        && dateKey(existingRetry.scheduledDate) === dateKey(scheduledDate);
      if (!sameRequest) return reply.code(409).send({ error: "Idempotency key was already used for different work." });
      return reply.code(200).send(existingRetry);
    }

    try {
      const assignment = await prisma.$transaction(async (tx) => {
        const created = await tx.taskAssignment.create({
          data: {
            templateId: null,
            idempotencyKey: parsed.data.idempotencyKey,
            organizationId: context.site.organizationId,
            siteId: context.site.id,
            assignedToId: membership.user.id,
            jobTitle: membership.user.jobTitle,
            recurrence: "ONCE",
            rolloverPolicy: parsed.data.rolloverPolicy,
            title: parsed.data.title,
            instructions: parsed.data.instructions,
            scheduledDate,
            dueAt: dueAtForDate(scheduledDate, parsed.data.dueTime ?? null, context.site.timeZone),
            priority: parsed.data.priority,
          },
        });
        await tx.taskAssignmentEvent.create({
          data: {
            assignmentId: created.id,
            organizationId: created.organizationId,
            siteId: created.siteId,
            actorUserId: request.user.sub,
            action: "CREATED",
            fromStatus: null,
            toStatus: created.status,
          },
        });
        return created;
      });
      return reply.code(201).send(assignment);
    } catch (error) {
      if ((error as { code?: string })?.code !== "P2002") throw error;
      const retried = await prisma.taskAssignment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: context.site.organizationId, idempotencyKey: parsed.data.idempotencyKey } } });
      const sameRetry = retried
        && retried.organizationId === context.site.organizationId
        && retried.siteId === context.site.id
        && retried.assignedToId === membership.user.id
        && retried.title === parsed.data.title
        && dateKey(retried.scheduledDate) === dateKey(scheduledDate);
      if (!sameRetry) throw error;
      return reply.code(200).send(retried);
    }
  });

  app.patch("/assignments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = managerAssignmentUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const context = await requireManagerContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "Manager access required." });
    const assignment = await prisma.taskAssignment.findFirst({
      where: { id, organizationId: context.site.organizationId, siteId: context.site.id },
    });
    if (!assignment) return reply.code(404).send({ error: "Task assignment not found." });

    let assigneeJobTitle = assignment.jobTitle;
    if (parsed.data.assignedToId && parsed.data.assignedToId !== assignment.assignedToId) {
      if (assignment.status === "COMPLETED") return reply.code(409).send({ error: "Reopen a completed task before reassigning it." });
      const target = await prisma.organizationMembership.findUnique({
        where: { organizationId_userId: { organizationId: context.site.organizationId, userId: parsed.data.assignedToId } },
        select: { isActive: true, user: { select: { id: true, isActive: true, jobTitle: true, siteMemberships: { where: { siteId: context.site.id, isActive: true }, select: { id: true }, take: 1 } } } },
      });
      if (!target?.isActive || !target.user.isActive || target.user.siteMemberships.length === 0) return reply.code(404).send({ error: "Active employee for this site not found." });
      if (!target.user.jobTitle) return reply.code(409).send({ error: "Assign a job title before assigning work." });
      assigneeJobTitle = target.user.jobTitle;
    }

    const status = parsed.data.status ?? assignment.status;
    const managerNoteProvided = Object.prototype.hasOwnProperty.call(parsed.data, "managerNote");
    const assigneeChanged = Boolean(parsed.data.assignedToId && parsed.data.assignedToId !== assignment.assignedToId);
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.taskAssignment.updateMany({
        where: {
          id,
          organizationId: context.site.organizationId,
          siteId: context.site.id,
          updatedAt: assignment.updatedAt,
        },
        data: {
          status,
          ...(managerNoteProvided ? { managerNote: parsed.data.managerNote } : {}),
          ...(assigneeChanged ? { assignedToId: parsed.data.assignedToId, jobTitle: assigneeJobTitle } : {}),
          ...(status === "COMPLETED" && assignment.status !== "COMPLETED" ? { completedAt: new Date(), completedById: request.user.sub } : {}),
          ...(status !== "COMPLETED" && assignment.status === "COMPLETED" ? { completedAt: null, completedById: null } : {}),
        },
      });
      if (changed.count !== 1) return null;
      if (status !== assignment.status || managerNoteProvided || assigneeChanged) {
        await tx.taskAssignmentEvent.create({
          data: {
            assignmentId: assignment.id,
            organizationId: assignment.organizationId,
            siteId: assignment.siteId,
            actorUserId: request.user.sub,
            action: assigneeChanged ? "REASSIGNED" : taskEventAction(assignment.status, status),
            fromStatus: assignment.status,
            toStatus: status,
            ...(assigneeChanged ? { fromAssignedToId: assignment.assignedToId, toAssignedToId: parsed.data.assignedToId } : {}),
          },
        });
      }
      return tx.taskAssignment.findUniqueOrThrow({ where: { id } });
    });
    if (!updated) return reply.code(409).send({ error: "This task changed while you were editing it. Refresh and try again." });
    return updated;
  });

  app.patch("/users/:id/job-title", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ jobTitle: jobTitleSchema.nullable() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const context = await requireManagerContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "Manager access required." });
    const target = await prisma.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId: context.site.organizationId, userId: id } },
      select: {
        user: {
          select: {
            id: true,
            isActive: true,
            siteMemberships: {
              where: { siteId: context.site.id, isActive: true },
              select: { id: true },
              take: 1,
            },
          },
        },
        isActive: true,
      },
    });
    if (!target?.isActive || !target.user.isActive || target.user.siteMemberships.length === 0) return reply.code(404).send({ error: "Active employee for this site not found." });
    return prisma.user.update({
      where: { id },
      data: { jobTitle: parsed.data.jobTitle },
      select: { id: true, name: true, employeeNumber: true, jobTitle: true },
    });
  });

  app.get("/reports", async (request, reply) => {
    const context = await requireManagerContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "Manager access required." });
    const query = z.object({ period: reportPeriodSchema.default("DAILY"), anchor: z.string().optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const anchor = query.data.anchor ? dateOnly(query.data.anchor) : localDateInTimeZone(new Date(), context.site.timeZone);
    if (!anchor) return reply.code(400).send({ error: "Anchor date or site time zone is invalid." });
    return managerReport(context, query.data.period, anchor);
  });

  app.get("/reports.csv", async (request, reply) => {
    const context = await requireManagerContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "Manager access required." });
    const query = z.object({ period: reportPeriodSchema.default("DAILY"), anchor: z.string().optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const anchor = query.data.anchor ? dateOnly(query.data.anchor) : localDateInTimeZone(new Date(), context.site.timeZone);
    if (!anchor) return reply.code(400).send({ error: "Anchor date or site time zone is invalid." });
    const report = await managerReport(context, query.data.period, anchor);
    let csv = encodeCsvRow(["scheduledDate", "employee", "employeeNumber", "jobTitle", "task", "recurrence", "priority", "status", "dueAt", "completedAt", "employeeNote", "managerNote"]);
    for (const task of report.assignments) {
      csv += encodeCsvRow([
        dateKey(task.scheduledDate), task.assignedTo.name, task.assignedTo.employeeNumber, task.jobTitle, task.title,
        task.recurrence, task.priority, task.status, task.dueAt?.toISOString() ?? "", task.completedAt?.toISOString() ?? "",
        task.employeeNote, task.managerNote,
      ]);
    }
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="continuixai-ops-${report.period.toLowerCase()}-${report.start}-${report.end}.csv"`);
    return reply.send(csv);
  });
}
