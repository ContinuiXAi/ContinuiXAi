export type UserRole = "ADMIN" | "GENERAL";
export type JobTitle = "STORE_MANAGER" | "INVENTORY_MANAGER" | "STOCK_COUNT_ASSOCIATE" | "RECEIVER" | "CASHIER_CUSTOMER_SERVICE" | "PHARMACY_TEAM";

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  employeeNumber?: string | null;
  jobTitle?: JobTitle | null;
  taskManager?: boolean;
  mfaEnabled?: boolean;
}

export type BarcodeSymbology = "EAN13" | "UPCA" | "CODE128" | "QR" | "DATA_MATRIX" | "OTHER";
export type BarcodeSource = "GENERATED" | "EXISTING" | "MATTER" | "SERIAL";

export interface Barcode {
  id: string;
  itemId: string;
  value: string;
  symbology: BarcodeSymbology;
  source: BarcodeSource;
  isPrimary: boolean;
}

export interface Location {
  id: string;
  name: string;
  parentId: string | null;
  photoUrl: string | null;
  notes: string | null;
  _count?: { items: number };
  freshness?: FreshnessSummary;
}

export interface FreshnessSummary {
  freshCount: number;
  totalCount: number;
  ratio: number;
  percent: number;
}

export interface XpBreakdownEntry { reason: string; points: number; }
export interface XpAward { total: number; breakdown: XpBreakdownEntry[]; }

export interface InsightsUntouched { id: string; name: string; itemType: ItemType; lastTouchAt: string; daysSinceTouch: number; }
export interface InsightsConsumed { itemId: string; name: string; consumedQty: number; }
export interface InsightsDuplicate { itemId: string; name: string; restockCount: number; restockQty: number; }
export interface InsightsPurchasedItem { id: string; name: string; price: number | null; currency: string | null; purchasedAt: string; }
export interface InsightsResponse {
  range: { start: string; end: string };
  untouchedDays: number;
  tzOffsetMinutes?: number;
  untouched: InsightsUntouched[];
  topConsumed: InsightsConsumed[];
  duplicatePurchases: InsightsDuplicate[];
  purchased: { items: InsightsPurchasedItem[]; totalByCurrency: Record<string, number> };
}

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  _count?: { items: number };
}

export interface Attachment { id: string; filePath: string; mimeType: string; uploadedAt: string; }
export type StockMovementReason = "RESTOCK" | "CONSUME" | "ADJUST";
export interface StockMovement { id: string; itemId: string; delta: number; reason: StockMovementReason; occurredAt: string; }
export interface StockMovementWithItem extends StockMovement {
  item: { id: string; name: string; photoUrl: string | null; unit: string | null };
  user: { id: string; name: string } | null;
}

export type ItemType = "CONSUMABLE" | "ASSET";
export type ItemCondition = "NEW" | "IN_USE" | "NEEDS_REPAIR" | "RETIRED";

export interface MaintenanceRecord {
  id: string;
  itemId: string;
  date: string;
  description: string;
  cost: number | null;
  currency: string | null;
  createdAt: string;
}

export interface Item {
  id: string;
  name: string;
  manufacturer: string | null;
  description: string | null;
  packageSize: string | null;
  quantity: number;
  unit: string | null;
  locationId: string | null;
  categoryId: string | null;
  minQuantity: number | null;
  purchaseDate: string | null;
  price: number | null;
  currency: string | null;
  expiryDate: string | null;
  warrantyExpiresAt: string | null;
  photoUrl: string | null;
  notes: string | null;
  wanted: boolean;
  isActive: boolean;
  itemType: ItemType;
  condition: ItemCondition | null;
  createdAt: string;
  updatedAt: string;
  lastAuditedAt: string | null;
  location: Location | null;
  category: Category | null;
  barcodes: Barcode[];
  attachments?: Attachment[];
  movements?: StockMovement[];
  maintenanceRecords?: MaintenanceRecord[];
}

export interface ProductLookupPreview {
  found: boolean;
  name?: string;
  brand?: string;
  description?: string;
  size?: string;
  category?: string;
  imageUrl?: string;
  provider?: string;
}

export interface ScanResult {
  item: Item;
  matched: boolean;
  created: boolean;
  lookup?: ProductLookupPreview;
  xp?: XpAward;
}

export type AuditCheckStatus = "PENDING" | "FOUND" | "UNEXPECTED";
export type AuditSessionStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";
export type AuditUnscannedAction = "ZERO" | "MOVE" | "LEAVE";

export interface AuditCheck {
  id: string;
  sessionId: string;
  itemId: string;
  expectedQuantity: number;
  actualQuantity: number | null;
  status: AuditCheckStatus;
  checkedAt: string | null;
  item: Item;
}

export interface AuditProgress { expectedTotal: number; foundExpected: number; pending: number; unexpected: number; }
export interface AuditSession {
  id: string;
  locationId: string;
  includeChildren: boolean;
  status: AuditSessionStatus;
  startedAt: string;
  completedAt: string | null;
  location: Location;
  startedBy: { id: string; name: string } | null;
  checks: AuditCheck[];
  progress: AuditProgress;
}

export type AuditScanResult =
  | { status: "unknown"; barcodeValue: string; session: AuditSession }
  | {
      status: "expected" | "already_found" | "unexpected";
      item: Item;
      check: AuditCheck | null;
      inScope: boolean;
      sessionLocationId: string;
      session: AuditSession;
    };


export type TaskStatus = "OPEN" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED" | "CANCELLED";
export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type TaskRecurrence = "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";
export type TaskRolloverPolicy = "REMAIN_OVERDUE" | "ROLL_FORWARD" | "SKIP";

export interface TaskSite {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  timeZone: string;
}

export interface TaskAssignment {
  id: string;
  templateId?: string | null;
  idempotencyKey?: string | null;
  organizationId: string;
  siteId?: string | null;
  assignedToId: string;
  jobTitle?: JobTitle | null;
  recurrence: TaskRecurrence;
  rolloverPolicy: TaskRolloverPolicy;
  title: string;
  instructions?: string | null;
  scheduledDate: string;
  dueAt?: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  employeeNote?: string | null;
  managerNote?: string | null;
  completedAt?: string | null;
  completedById?: string | null;
  assignedTo?: Pick<User, "id" | "name" | "employeeNumber" | "jobTitle">;
  events?: TaskAssignmentEvent[];
}

export interface TaskAssignmentEvent {
  id: string;
  action: string;
  fromStatus?: TaskStatus | null;
  toStatus?: TaskStatus | null;
  actorUserId?: string | null;
  createdAt: string;
}

export interface TaskTemplate {
  id: string;
  organizationId: string;
  siteId?: string | null;
  jobTitle: JobTitle;
  title: string;
  instructions?: string | null;
  recurrence: TaskRecurrence;
  startDate: string;
  endDate?: string | null;
  weeklyDay?: number | null;
  monthlyDay?: number | null;
  dueTime?: string | null;
  priority: TaskPriority;
  rolloverPolicy: TaskRolloverPolicy;
  isActive: boolean;
}

export interface MyWorkResponse {
  date: string;
  site: TaskSite;
  managerAccess?: boolean;
  assignments: TaskAssignment[];
}

export interface DailySummaryResponse {
  date: string;
  site: TaskSite;
  tasks: { completed: TaskAssignment[]; skipped: TaskAssignment[]; open: TaskAssignment[]; overdueCount: number; nextUpcoming: TaskAssignment | null };
  counts: { sessionsCompleted: number; locationsCounted: number; uniqueProducts: number; unitsCounted: number; durationMinutes: number; sessions: Array<{ id: string; name?: string | null; startedAt: string; completedAt?: string | null }> };
}

export interface TaskEmployee extends User {
  membershipRole: string;
}

export interface TeamWorkResponse {
  date: string;
  site: TaskSite;
  assignments: TaskAssignment[];
}

export interface TaskReportResponse {
  period: "DAILY" | "WEEKLY" | "MONTHLY";
  anchor: string;
  start: string;
  end: string;
  site: TaskSite;
  totals: Record<string, number>;
  employees: Array<{ userId: string; name: string; employeeNumber?: string | null; completed: number; open: number; overdue: number; total: number }>;
  countActivity: { sessions: number; locations: number; products: number; units: number };
  assignments: TaskAssignment[];
}
