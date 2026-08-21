import express from "express";
import cors from "cors";
import multer from "multer";
import { mkdirSync, existsSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createSession, requireAuth, requireRole } from "./auth.js";
import { db, getTempleBySlug, hashPassword, initDb, seedCategories, verifyPassword } from "./db.js";

initDb();

const app = express();
const port = Number(process.env.PORT ?? 4000);
const uploadDir = join(process.cwd(), "uploads", "receipts");
const logoDir = join(process.cwd(), "uploads", "logos");
const eventDir = join(process.cwd(), "uploads", "events");
mkdirSync(uploadDir, { recursive: true });
mkdirSync(logoDir, { recursive: true });
mkdirSync(eventDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 8 * 1024 * 1024 } });
const uploadLogo = multer({ dest: logoDir, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadEvent = multer({ dest: eventDir, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(join(process.cwd(), "uploads")));

function ok(res, data) {
  res.json({ data });
}

function toAuditJson(value) {
  return value ? JSON.stringify(value) : null;
}

function writeAudit({ templeId, entityType, entityId, action, userId, before, after, comments }) {
  db.prepare(`
    INSERT INTO audit_logs (temple_id, entity_type, entity_id, action, performed_by_user_id, before_json, after_json, comments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(templeId, entityType, entityId, action, userId, toAuditJson(before), toAuditJson(after), comments || null);
}

function getPoojaIncomeCategoryIds(templeId, poojaType) {
  const category = db.prepare(`
    SELECT id FROM categories
    WHERE temple_id = ? AND type = 'INCOME' AND name = 'Special Pooja Income' AND parent_id IS NULL
  `).get(templeId);
  const subcategory = category
    ? db.prepare(`
        SELECT id FROM categories
        WHERE temple_id = ? AND type = 'INCOME' AND parent_id = ? AND lower(name) = lower(?)
      `).get(templeId, category.id, poojaType)
    : null;
  return { categoryId: category?.id ?? null, subcategoryId: subcategory?.id ?? null };
}

function buildPoojaIncomeNotes(booking) {
  const parts = [
    "Pooja booking",
    booking.occasion,
    booking.pooja_type,
    booking.occasion_date,
  ].filter(Boolean);
  return parts.join(" · ");
}

function syncPoojaIncomeTransaction({ templeId, booking, userId }) {
  const amount = Number(booking.amount ?? 0);
  const linkedId = Number(booking.income_transaction_id ?? 0) || null;
  if (!(amount > 0)) {
    if (linkedId) {
      db.prepare("UPDATE transactions SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND temple_id = ?").run(linkedId, templeId);
      db.prepare("UPDATE pooja_bookings SET income_transaction_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND temple_id = ?").run(booking.id, templeId);
    }
    return null;
  }

  const { categoryId, subcategoryId } = getPoojaIncomeCategoryIds(templeId, booking.pooja_type);
  const transactionDate = booking.occasion_date || new Date().toISOString().slice(0, 10);
  const notes = buildPoojaIncomeNotes(booking);

  if (linkedId) {
    db.prepare(`
      UPDATE transactions
      SET category_id = ?, subcategory_id = ?, amount = ?, transaction_date = ?,
          payment_mode = 'CASH', counterparty_name = ?, notes = ?, deleted = 0,
          status = 'APPROVED', approved_by_user_id = ?, approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND temple_id = ?
    `).run(categoryId, subcategoryId, amount, transactionDate, booking.devotee_name, notes, userId, linkedId, templeId);
    return linkedId;
  }

  const result = db.prepare(`
    INSERT INTO transactions (
      temple_id, type, category_id, subcategory_id, amount, transaction_date,
      payment_mode, counterparty_name, notes, status, entered_by_user_id, approved_by_user_id, approved_at
    ) VALUES (?, 'INCOME', ?, ?, ?, ?, 'CASH', ?, ?, 'APPROVED', ?, ?, CURRENT_TIMESTAMP)
  `).run(templeId, categoryId, subcategoryId, amount, transactionDate, booking.devotee_name, notes, userId, userId);
  const transactionId = result.lastInsertRowid;
  db.prepare("UPDATE pooja_bookings SET income_transaction_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND temple_id = ?").run(transactionId, booking.id, templeId);
  return transactionId;
}

function backfillPoojaIncomeTransactions() {
  const bookings = db.prepare(`
    SELECT * FROM pooja_bookings
    WHERE active = 1 AND COALESCE(amount, 0) > 0 AND income_transaction_id IS NULL
  `).all();
  bookings.forEach((booking) => {
    syncPoojaIncomeTransaction({
      templeId: booking.temple_id,
      booking,
      userId: booking.created_by_user_id,
    });
  });
}

backfillPoojaIncomeTransactions();

function isWithinCorrectionWindow(row) {
  if (!row?.created_at) return false;
  const createdAt = Date.parse(`${String(row.created_at).replace(" ", "T")}Z`);
  if (Number.isNaN(createdAt)) return false;
  return Date.now() - createdAt <= 2 * 60 * 60 * 1000;
}

function canModifyTransaction(row) {
  return Boolean(row?.unlocked || isWithinCorrectionWindow(row));
}

function getCategories(templeId, type) {
  const rows = db.prepare(
    "SELECT id, type, name, parent_id AS parentId FROM categories WHERE temple_id = ? AND type = ? AND active = 1 ORDER BY parent_id NULLS FIRST, sort_order, name",
  ).all(templeId, type);
  return rows.filter((row) => !row.parentId).map((parent) => ({
    ...parent,
    children: rows.filter((row) => row.parentId === parent.id),
  }));
}

app.get("/api/:templeSlug/public", (req, res) => {
  const temple = getTempleBySlug(req.params.templeSlug);
  if (!temple) {
    res.status(404).json({ message: "Temple not found" });
    return;
  }
  ok(res, {
    slug: temple.slug,
    name: temple.name,
    address: temple.address,
    logoUrl: temple.logo_url,
    approvalThreshold: temple.approval_threshold,
    defaultLanguage: temple.default_language,
    currency: temple.currency || "INR",
  });
});

app.get("/api/:templeSlug/public/temples", (req, res) => {
  const temples = db.prepare("SELECT slug, name FROM temples WHERE active = 1 ORDER BY name").all();
  ok(res, temples);
});

app.get("/api/:templeSlug/public/events/:eventId/poster", (req, res) => {
  const temple = getTempleBySlug(req.params.templeSlug);
  if (!temple) { res.status(404).json({ message: "Temple not found" }); return; }
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND temple_id = ? AND active = 1").get(req.params.eventId, temple.id);
  if (!event) { res.status(404).json({ message: "Event not found" }); return; }
  ok(res, {
    temple: { name: temple.name, address: temple.address, logoUrl: temple.logo_url },
    event: { name: event.name, eventDate: event.event_date, endDate: event.end_date, description: event.description, imageUrl: event.image_url, status: event.status },
  });
});

app.post("/api/:templeSlug/auth/login", (req, res) => {
  const temple = getTempleBySlug(req.params.templeSlug);
  if (!temple) {
    res.status(404).json({ message: "Temple not found" });
    return;
  }
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE temple_id = ? AND lower(email) = ? AND active = 1").get(temple.id, email);
  if (!user || !verifyPassword(String(req.body.password ?? ""), user.password_hash)) {
    res.status(401).json({ message: "Invalid email or password" });
    return;
  }
  ok(res, {
    token: createSession(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    temple: { id: temple.id, slug: temple.slug, name: temple.name, logoUrl: temple.logo_url, approvalThreshold: temple.approval_threshold, defaultLanguage: temple.default_language },
  });
});

app.get("/api/:templeSlug/me", requireAuth, (req, res) => {
  ok(res, { user: req.user, temple: { id: req.temple.id, slug: req.temple.slug, name: req.temple.name, logoUrl: req.temple.logo_url, approvalThreshold: req.temple.approval_threshold, defaultLanguage: req.temple.default_language } });
});

app.get("/api/:templeSlug/dashboard", requireAuth, (req, res) => {
  const templeId = req.temple.id;
  const today = new Date().toISOString().slice(0, 10);
  const requestedMonth = String(req.query.month ?? "").trim();
  const monthPrefix = /^\d{4}-\d{2}$/.test(requestedMonth) ? requestedMonth : today.slice(0, 7);
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'INCOME' AND transaction_date = ? AND status = 'APPROVED' THEN amount ELSE 0 END), 0) todayIncome,
      COALESCE(SUM(CASE WHEN type = 'EXPENSE' AND transaction_date = ? AND status = 'APPROVED' THEN amount ELSE 0 END), 0) todayExpense,
      COALESCE(SUM(CASE WHEN type = 'INCOME' AND transaction_date LIKE ? AND status = 'APPROVED' THEN amount ELSE 0 END), 0) monthIncome,
      COALESCE(SUM(CASE WHEN type = 'EXPENSE' AND transaction_date LIKE ? AND status = 'APPROVED' THEN amount ELSE 0 END), 0) monthExpense
    FROM transactions WHERE temple_id = ? AND deleted = 0
  `).get(today, today, `${monthPrefix}%`, `${monthPrefix}%`, templeId);
  const pendingApprovals = db.prepare("SELECT COUNT(*) count FROM approvals WHERE temple_id = ? AND status = 'PENDING'").get(templeId).count;
  const monthPoojas = db.prepare(`
    SELECT COUNT(*) count FROM pooja_bookings
    WHERE temple_id = ? AND active = 1 AND substr(occasion_date, 6, 2) = ?
  `).get(templeId, monthPrefix.slice(5, 7)).count;
  const monthPoojaBookings = db.prepare(`
    SELECT id, devotee_name, mobile, pooja_type, occasion, occasion_date, amount, notes
    FROM pooja_bookings
    WHERE temple_id = ? AND active = 1 AND substr(occasion_date, 6, 2) = ?
    ORDER BY substr(occasion_date, 6, 5), devotee_name
  `).all(templeId, monthPrefix.slice(5, 7));
  const todayPoojaBookings = db.prepare(`
    SELECT id, devotee_name, mobile, pooja_type, occasion, occasion_date, amount, notes
    FROM pooja_bookings
    WHERE temple_id = ? AND active = 1 AND substr(occasion_date, 6, 5) = substr(?, 6, 5)
    ORDER BY devotee_name
  `).all(templeId, today);
  const todayPoojas = todayPoojaBookings.length;
  ok(res, {
    ...totals,
    month: monthPrefix,
    pendingApprovals,
    todayPoojas,
    monthPoojas,
    monthPoojaBookings,
    todayPoojaBookings,
    balance: totals.monthIncome - totals.monthExpense,
  });
});

app.get("/api/:templeSlug/categories", requireAuth, (req, res) => {
  ok(res, {
    income: getCategories(req.temple.id, "INCOME"),
    expense: getCategories(req.temple.id, "EXPENSE"),
  });
});

function listUsers(templeId) {
  return db.prepare(`
    SELECT id, name, email, phone, role, active, created_at, updated_at
    FROM users WHERE temple_id = ?
    ORDER BY active DESC, name
  `).all(templeId);
}

app.get("/api/:templeSlug/admin/users", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  ok(res, listUsers(req.temple.id));
});

app.post("/api/:templeSlug/admin/users", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const role = String(req.body.role ?? "").toUpperCase();
  const password = String(req.body.password ?? "");
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !["MANAGER", "TRUSTEE", "SUPER_TRUSTEE"].includes(role)) {
    res.status(400).json({ message: "Name, valid email, and a valid role are required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ message: "Password must be at least 8 characters" });
    return;
  }
  if (role === "SUPER_TRUSTEE" && req.user.role !== "SUPER_TRUSTEE") {
    res.status(403).json({ message: "Only a Super Trustee can create a Super Trustee" });
    return;
  }
  if (db.prepare("SELECT id FROM users WHERE lower(email) = ?").get(email)) {
    res.status(409).json({ message: "A user with this email already exists" });
    return;
  }
  const result = db.prepare(`
    INSERT INTO users (temple_id, name, email, phone, role, password_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.temple.id, name, email, req.body.phone || null, role, hashPassword(password));
  const created = listUsers(req.temple.id).find((user) => user.id === result.lastInsertRowid);
  writeAudit({
    templeId: req.temple.id,
    entityType: "USER",
    entityId: result.lastInsertRowid,
    action: "CREATE",
    userId: req.user.id,
    after: created,
  });
  ok(res, created);
});

app.put("/api/:templeSlug/admin/users/:id", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND temple_id = ?").get(req.params.id, req.temple.id);
  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }
  if (user.id === req.user.id) {
    res.status(400).json({ message: "You cannot edit your own account here" });
    return;
  }
  const role = String(req.body.role ?? user.role).toUpperCase();
  if (!["MANAGER", "TRUSTEE", "SUPER_TRUSTEE"].includes(role)) {
    res.status(400).json({ message: "Invalid role" });
    return;
  }
  if (role === "SUPER_TRUSTEE" && req.user.role !== "SUPER_TRUSTEE") {
    res.status(403).json({ message: "Only a Super Trustee can assign the Super Trustee role" });
    return;
  }
  const active = req.body.active === undefined ? user.active : (req.body.active ? 1 : 0);
  if (!active && user.role === "SUPER_TRUSTEE") {
    const activeSupers = db.prepare("SELECT COUNT(*) count FROM users WHERE temple_id = ? AND role = 'SUPER_TRUSTEE' AND active = 1").get(req.temple.id).count;
    if (activeSupers <= 1) {
      res.status(400).json({ message: "At least one active Super Trustee must remain" });
      return;
    }
  }
  const password = String(req.body.password ?? "");
  if (password && password.length < 8) {
    res.status(400).json({ message: "Password must be at least 8 characters" });
    return;
  }
  const before = user;
  db.prepare(`
    UPDATE users
    SET name = ?, phone = ?, role = ?, active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND temple_id = ?
  `).run(
    String(req.body.name ?? user.name).trim() || user.name,
    req.body.phone === undefined ? user.phone : (req.body.phone || null),
    role,
    active,
    user.id,
    req.temple.id,
  );
  if (password) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), user.id);
  }
  const after = listUsers(req.temple.id).find((item) => item.id === user.id);
  writeAudit({
    templeId: req.temple.id,
    entityType: "USER",
    entityId: user.id,
    action: "UPDATE",
    userId: req.user.id,
    before,
    after,
    comments: password ? "Password reset" : null,
  });
  ok(res, after);
});

app.get("/api/:templeSlug/admin/categories", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  ok(res, db.prepare(`
    SELECT id, type, name, parent_id AS parentId, active, sort_order AS sortOrder
    FROM categories WHERE temple_id = ?
    ORDER BY type, COALESCE(parent_id, 0), sort_order, name
  `).all(req.temple.id));
});

app.post("/api/:templeSlug/admin/categories", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const type = String(req.body.type ?? "").toUpperCase();
  const name = String(req.body.name ?? "").trim();
  const parentId = Number(req.body.parentId || 0) || null;
  if (!["INCOME", "EXPENSE"].includes(type) || !name) {
    res.status(400).json({ message: "Type and category name are required" });
    return;
  }
  if (parentId) {
    const parent = db.prepare("SELECT id, type FROM categories WHERE id = ? AND temple_id = ?").get(parentId, req.temple.id);
    if (!parent || parent.type !== type) {
      res.status(400).json({ message: "Invalid parent category" });
      return;
    }
  }
  const result = db.prepare("INSERT INTO categories (temple_id, type, name, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)").run(
    req.temple.id,
    type,
    name,
    parentId,
    Number(req.body.sortOrder ?? 0),
  );
  const after = db.prepare(`
    SELECT id, type, name, parent_id AS parentId, active, sort_order AS sortOrder
    FROM categories WHERE id = ?
  `).get(result.lastInsertRowid);
  writeAudit({
    templeId: req.temple.id,
    entityType: "CATEGORY",
    entityId: result.lastInsertRowid,
    action: "CREATE",
    userId: req.user.id,
    after,
  });
  ok(res, after);
});

app.put("/api/:templeSlug/admin/categories/:id", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const before = db.prepare("SELECT * FROM categories WHERE id = ? AND temple_id = ?").get(req.params.id, req.temple.id);
  if (!before) {
    res.status(404).json({ message: "Category not found" });
    return;
  }
  const name = req.body.name === undefined ? before.name : String(req.body.name).trim();
  if (!name) {
    res.status(400).json({ message: "Category name cannot be empty" });
    return;
  }
  db.prepare(`
    UPDATE categories
    SET name = ?, sort_order = ?, active = ?
    WHERE id = ? AND temple_id = ?
  `).run(
    name,
    Number(req.body.sortOrder ?? before.sort_order),
    req.body.active === undefined ? before.active : (req.body.active ? 1 : 0),
    before.id,
    req.temple.id,
  );
  const after = db.prepare(`
    SELECT id, type, name, parent_id AS parentId, active, sort_order AS sortOrder
    FROM categories WHERE id = ?
  `).get(before.id);
  writeAudit({
    templeId: req.temple.id,
    entityType: "CATEGORY",
    entityId: before.id,
    action: "UPDATE",
    userId: req.user.id,
    before,
    after,
  });
  ok(res, after);
});

app.put("/api/:templeSlug/temple", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const before = req.temple;
  const name = String(req.body.name ?? before.name).trim();
  if (!name) {
    res.status(400).json({ message: "Temple name cannot be empty" });
    return;
  }
  const threshold = Number(req.body.approvalThreshold ?? before.approval_threshold);
  if (!Number.isFinite(threshold) || threshold < 0) {
    res.status(400).json({ message: "Approval threshold must be a positive number" });
    return;
  }
  const defaultLanguage = ["en", "kn"].includes(req.body.defaultLanguage) ? req.body.defaultLanguage : before.default_language;
  const currency = ["INR", "GBP", "USD"].includes(req.body.currency) ? req.body.currency : before.currency;
  db.prepare(`
    UPDATE temples
    SET name = ?, address = ?, logo_url = ?, approval_threshold = ?, default_language = ?, currency = ?
    WHERE id = ?
  `).run(
    name,
    req.body.address === undefined ? before.address : (req.body.address || null),
    req.body.logoUrl === undefined ? before.logo_url : (req.body.logoUrl || null),
    threshold,
    defaultLanguage,
    currency,
    before.id,
  );
  const after = db.prepare("SELECT * FROM temples WHERE id = ?").get(before.id);
  writeAudit({
    templeId: before.id,
    entityType: "TEMPLE",
    entityId: before.id,
    action: "UPDATE",
    userId: req.user.id,
    before,
    after,
  });
  ok(res, {
    id: after.id,
    slug: after.slug,
    name: after.name,
    address: after.address,
    logoUrl: after.logo_url,
    approvalThreshold: after.approval_threshold,
    defaultLanguage: after.default_language,
    currency: after.currency || "INR",
  });
});

app.get("/api/:templeSlug/admin/logo", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const temple = db.prepare("SELECT logo_url FROM temples WHERE id = ?").get(req.temple.id);
  ok(res, { logoUrl: temple?.logo_url || null });
});

app.post("/api/:templeSlug/admin/logo", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), uploadLogo.single("logo"), (req, res) => {
  if (!req.file) { res.status(400).json({ message: "No file uploaded" }); return; }
  const ext = req.file.originalname.split(".").pop() || "png";
  const fileName = `logo-${req.temple.id}-${Date.now()}.${ext}`;
  renameSync(req.file.path, join(logoDir, fileName));
  const logoUrl = `/uploads/logos/${fileName}`;
  db.prepare("UPDATE temples SET logo_url = ? WHERE id = ?").run(logoUrl, req.temple.id);
  writeAudit({ templeId: req.temple.id, entityType: "TEMPLE", entityId: req.temple.id, action: "UPDATE", userId: req.user.id, before: { logo_url: req.temple.logo_url }, after: { logo_url: logoUrl }, comments: "Logo uploaded" });
  ok(res, { logoUrl });
});

app.get("/api/:templeSlug/admin/temples", requireAuth, requireRole("SUPER_TRUSTEE"), (req, res) => {
  ok(res, db.prepare(`
    SELECT id, slug, name, address, approval_threshold AS approvalThreshold,
           default_language AS defaultLanguage, currency, active
    FROM temples ORDER BY id
  `).all());
});

app.post("/api/:templeSlug/admin/temples", requireAuth, requireRole("SUPER_TRUSTEE"), (req, res) => {
  const slug = String(req.body.slug ?? "").trim().toLowerCase();
  const name = String(req.body.name ?? "").trim();
  const adminName = String(req.body.adminName ?? "").trim();
  const adminEmail = String(req.body.adminEmail ?? "").trim().toLowerCase();
  const adminPassword = String(req.body.adminPassword ?? "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) {
    res.status(400).json({ message: "Slug must be lowercase letters, numbers, or hyphens (no spaces or special characters)" });
    return;
  }
  if (!name || !adminName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
    res.status(400).json({ message: "Temple name, admin name, and a valid admin email are required" });
    return;
  }
  if (adminPassword.length < 8) {
    res.status(400).json({ message: "Admin password must be at least 8 characters" });
    return;
  }
  if (db.prepare("SELECT id FROM temples WHERE slug = ?").get(slug)) {
    res.status(409).json({ message: "A temple with this slug already exists" });
    return;
  }
  if (db.prepare("SELECT id FROM users WHERE lower(email) = ?").get(adminEmail)) {
    res.status(409).json({ message: "A user with this email already exists" });
    return;
  }
  const result = db.prepare(`
    INSERT INTO temples (slug, name, address, approval_threshold, default_language, currency)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    slug,
    name,
    req.body.address || null,
    Number(req.body.approvalThreshold ?? 2000),
    ["en", "kn"].includes(req.body.defaultLanguage) ? req.body.defaultLanguage : "en",
    ["INR", "GBP", "USD"].includes(req.body.currency) ? req.body.currency : "INR",
  );
  const templeId = result.lastInsertRowid;
  seedCategories(templeId);
  const adminResult = db.prepare(`
    INSERT INTO users (temple_id, name, email, role, password_hash)
    VALUES (?, ?, ?, 'SUPER_TRUSTEE', ?)
  `).run(templeId, adminName, adminEmail, hashPassword(adminPassword));
  const after = db.prepare("SELECT * FROM temples WHERE id = ?").get(templeId);
  writeAudit({
    templeId,
    entityType: "TEMPLE",
    entityId: templeId,
    action: "CREATE",
    userId: req.user.id,
    after,
    comments: `Created with admin ${adminEmail}`,
  });
  ok(res, {
    id: templeId,
    slug,
    name,
    adminUser: { id: adminResult.lastInsertRowid, name: adminName, email: adminEmail },
  });
});

app.get("/api/:templeSlug/transactions", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, c.name categoryName, sc.name subcategoryName, u.name enteredByName
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories sc ON sc.id = t.subcategory_id
    JOIN users u ON u.id = t.entered_by_user_id
    WHERE t.temple_id = ? AND t.deleted = 0
    ORDER BY t.transaction_date DESC, t.id DESC
    LIMIT 100
  `).all(req.temple.id);
  ok(res, rows);
});

app.post("/api/:templeSlug/transactions", requireAuth, upload.single("receipt"), (req, res) => {
  const temple = req.temple;
  const type = String(req.body.type ?? "").toUpperCase();
  const amount = Number(req.body.amount ?? 0);
  const categoryId = Number(req.body.categoryId || 0) || null;
  const subcategoryId = Number(req.body.subcategoryId || 0) || null;
  if (!["INCOME", "EXPENSE"].includes(type) || !(amount > 0)) {
    res.status(400).json({ message: "Type and positive amount are required" });
    return;
  }
  const needsApproval = type === "EXPENSE" && req.user.role === "MANAGER" && amount > temple.approval_threshold;
  const status = needsApproval ? "PENDING_APPROVAL" : "APPROVED";
  const result = db.prepare(`
    INSERT INTO transactions (
      temple_id, type, category_id, subcategory_id, amount, transaction_date,
      payment_mode, counterparty_name, notes, status, entered_by_user_id, approved_by_user_id, approved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    temple.id,
    type,
    categoryId,
    subcategoryId,
    amount,
    req.body.transactionDate || new Date().toISOString().slice(0, 10),
    req.body.paymentMode || "CASH",
    req.body.counterpartyName || null,
    req.body.notes || null,
    status,
    req.user.id,
    status === "APPROVED" ? req.user.id : null,
    status === "APPROVED" ? new Date().toISOString() : null,
  );
  const transactionId = result.lastInsertRowid;
  if (needsApproval) {
    db.prepare("INSERT INTO approvals (temple_id, transaction_id, requested_by_user_id) VALUES (?, ?, ?)").run(temple.id, transactionId, req.user.id);
  }
  if (req.file) {
    db.prepare(`
      INSERT INTO attachments (temple_id, transaction_id, file_path, original_file_name, mime_type, uploaded_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(temple.id, transactionId, req.file.path, req.file.originalname, req.file.mimetype, req.user.id);
  }
  const created = db.prepare("SELECT * FROM transactions WHERE id = ? AND temple_id = ?").get(transactionId, temple.id);
  writeAudit({
    templeId: temple.id,
    entityType: "TRANSACTION",
    entityId: transactionId,
    action: "CREATE",
    userId: req.user.id,
    after: created,
  });
  ok(res, { id: transactionId, status });
});

app.post("/api/:templeSlug/transactions/:id/unlock", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const before = db.prepare("SELECT * FROM transactions WHERE id = ? AND temple_id = ? AND deleted = 0").get(req.params.id, req.temple.id);
  if (!before) {
    res.status(404).json({ message: "Ledger entry not found" });
    return;
  }
  db.prepare("UPDATE transactions SET unlocked = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND temple_id = ?").run(before.id, req.temple.id);
  const after = db.prepare("SELECT * FROM transactions WHERE id = ? AND temple_id = ?").get(before.id, req.temple.id);
  writeAudit({
    templeId: req.temple.id,
    entityType: "TRANSACTION",
    entityId: before.id,
    action: "UNLOCK",
    userId: req.user.id,
    before,
    after,
    comments: req.body.comments || "Unlocked for correction",
  });
  ok(res, { id: before.id, unlocked: true });
});

app.put("/api/:templeSlug/transactions/:id", requireAuth, (req, res) => {
  const before = db.prepare("SELECT * FROM transactions WHERE id = ? AND temple_id = ? AND deleted = 0").get(req.params.id, req.temple.id);
  if (!before) {
    res.status(404).json({ message: "Ledger entry not found" });
    return;
  }
  if (!canModifyTransaction(before)) {
    res.status(403).json({ message: "Entries older than 2 hours must be unlocked by a trustee before editing" });
    return;
  }
  const amount = Number(req.body.amount ?? before.amount);
  const type = String(req.body.type ?? before.type).toUpperCase();
  if (!["INCOME", "EXPENSE"].includes(type) || !(amount > 0)) {
    res.status(400).json({ message: "Type and positive amount are required" });
    return;
  }
  db.prepare(`
    UPDATE transactions
    SET type = ?, category_id = ?, subcategory_id = ?, amount = ?, transaction_date = ?,
        payment_mode = ?, counterparty_name = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND temple_id = ?
  `).run(
    type,
    req.body.categoryId === undefined ? before.category_id : Number(req.body.categoryId || 0) || null,
    req.body.subcategoryId === undefined ? before.subcategory_id : Number(req.body.subcategoryId || 0) || null,
    amount,
    req.body.transactionDate || before.transaction_date,
    req.body.paymentMode || before.payment_mode || "CASH",
    req.body.counterpartyName === undefined ? before.counterparty_name : req.body.counterpartyName || null,
    req.body.notes === undefined ? before.notes : req.body.notes || null,
    before.id,
    req.temple.id,
  );
  const after = db.prepare("SELECT * FROM transactions WHERE id = ? AND temple_id = ?").get(before.id, req.temple.id);
  writeAudit({
    templeId: req.temple.id,
    entityType: "TRANSACTION",
    entityId: before.id,
    action: "UPDATE",
    userId: req.user.id,
    before,
    after,
  });
  ok(res, { id: before.id });
});

app.delete("/api/:templeSlug/transactions/:id", requireAuth, (req, res) => {
  const before = db.prepare("SELECT * FROM transactions WHERE id = ? AND temple_id = ? AND deleted = 0").get(req.params.id, req.temple.id);
  if (!before) {
    res.status(404).json({ message: "Ledger entry not found" });
    return;
  }
  if (!canModifyTransaction(before)) {
    res.status(403).json({ message: "Entries older than 2 hours must be unlocked by a trustee before removing" });
    return;
  }
  db.prepare("UPDATE transactions SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND temple_id = ?").run(before.id, req.temple.id);
  db.prepare("UPDATE approvals SET status = 'REJECTED', decided_by_user_id = ?, comments = ?, decided_at = CURRENT_TIMESTAMP WHERE transaction_id = ? AND status = 'PENDING'")
    .run(req.user.id, "Ledger entry removed after unlock", before.id);
  const after = db.prepare("SELECT * FROM transactions WHERE id = ? AND temple_id = ?").get(before.id, req.temple.id);
  writeAudit({
    templeId: req.temple.id,
    entityType: "TRANSACTION",
    entityId: before.id,
    action: "DELETE",
    userId: req.user.id,
    before,
    after,
  });
  ok(res, { id: before.id });
});

app.get("/api/:templeSlug/approvals", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, t.amount, t.transaction_date transactionDate, t.notes, c.name categoryName, u.name requestedByName
    FROM approvals a
    JOIN transactions t ON t.id = a.transaction_id
    LEFT JOIN categories c ON c.id = t.category_id
    JOIN users u ON u.id = a.requested_by_user_id
    WHERE a.temple_id = ? AND a.status = 'PENDING'
    ORDER BY a.created_at DESC
  `).all(req.temple.id);
  ok(res, rows);
});

app.post("/api/:templeSlug/approvals/:id/decision", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const decision = String(req.body.decision ?? "").toUpperCase();
  if (!["APPROVED", "REJECTED"].includes(decision)) {
    res.status(400).json({ message: "Decision must be APPROVED or REJECTED" });
    return;
  }
  const approval = db.prepare("SELECT * FROM approvals WHERE id = ? AND temple_id = ?").get(req.params.id, req.temple.id);
  if (!approval) {
    res.status(404).json({ message: "Approval not found" });
    return;
  }
  db.prepare("UPDATE approvals SET status = ?, decided_by_user_id = ?, comments = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(decision, req.user.id, req.body.comments || null, approval.id);
  db.prepare("UPDATE transactions SET status = ?, approved_by_user_id = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(decision === "APPROVED" ? "APPROVED" : "REJECTED", req.user.id, approval.transaction_id);
  const transaction = db.prepare("SELECT * FROM transactions WHERE id = ? AND temple_id = ?").get(approval.transaction_id, req.temple.id);
  writeAudit({
    templeId: req.temple.id,
    entityType: "TRANSACTION",
    entityId: approval.transaction_id,
    action: decision,
    userId: req.user.id,
    after: transaction,
    comments: req.body.comments || null,
  });
  ok(res, { status: decision });
});

app.get("/api/:templeSlug/pooja-bookings", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM pooja_bookings
    WHERE temple_id = ? AND active = 1
    ORDER BY substr(occasion_date, 6, 5), devotee_name
  `).all(req.temple.id);
  ok(res, rows);
});

app.post("/api/:templeSlug/pooja-bookings", requireAuth, (req, res) => {
  const result = db.prepare(`
    INSERT INTO pooja_bookings (temple_id, devotee_name, mobile, pooja_type, occasion, occasion_date, amount, notes, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.temple.id,
    req.body.devoteeName,
    req.body.mobile || null,
    req.body.poojaType,
    req.body.occasion,
    req.body.occasionDate,
    Number(req.body.amount ?? 0),
    req.body.notes || null,
    req.user.id,
  );
  const bookingId = result.lastInsertRowid;
  let created = db.prepare("SELECT * FROM pooja_bookings WHERE id = ? AND temple_id = ?").get(bookingId, req.temple.id);
  syncPoojaIncomeTransaction({ templeId: req.temple.id, booking: created, userId: req.user.id });
  created = db.prepare("SELECT * FROM pooja_bookings WHERE id = ? AND temple_id = ?").get(bookingId, req.temple.id);
  writeAudit({
    templeId: req.temple.id,
    entityType: "POOJA_BOOKING",
    entityId: bookingId,
    action: "CREATE",
    userId: req.user.id,
    after: created,
  });
  ok(res, { id: bookingId });
});

app.put("/api/:templeSlug/pooja-bookings/:id", requireAuth, (req, res) => {
  const before = db.prepare("SELECT * FROM pooja_bookings WHERE id = ? AND temple_id = ? AND active = 1").get(req.params.id, req.temple.id);
  if (!before) {
    res.status(404).json({ message: "Pooja booking not found" });
    return;
  }
  db.prepare(`
    UPDATE pooja_bookings
    SET devotee_name = ?, mobile = ?, pooja_type = ?, occasion = ?, occasion_date = ?,
        amount = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND temple_id = ?
  `).run(
    req.body.devoteeName || before.devotee_name,
    req.body.mobile || null,
    req.body.poojaType || before.pooja_type,
    req.body.occasion || before.occasion,
    req.body.occasionDate || before.occasion_date,
    Number(req.body.amount ?? before.amount ?? 0),
    req.body.notes || null,
    before.id,
    req.temple.id,
  );
  let after = db.prepare("SELECT * FROM pooja_bookings WHERE id = ? AND temple_id = ?").get(before.id, req.temple.id);
  syncPoojaIncomeTransaction({ templeId: req.temple.id, booking: after, userId: req.user.id });
  after = db.prepare("SELECT * FROM pooja_bookings WHERE id = ? AND temple_id = ?").get(before.id, req.temple.id);
  writeAudit({
    templeId: req.temple.id,
    entityType: "POOJA_BOOKING",
    entityId: before.id,
    action: "UPDATE",
    userId: req.user.id,
    before,
    after,
  });
  ok(res, { id: before.id });
});

app.delete("/api/:templeSlug/pooja-bookings/:id", requireAuth, (req, res) => {
  const before = db.prepare("SELECT * FROM pooja_bookings WHERE id = ? AND temple_id = ? AND active = 1").get(req.params.id, req.temple.id);
  if (!before) {
    res.status(404).json({ message: "Pooja booking not found" });
    return;
  }
  db.prepare("UPDATE pooja_bookings SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND temple_id = ?").run(before.id, req.temple.id);
  if (before.income_transaction_id) {
    db.prepare("UPDATE transactions SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND temple_id = ?").run(before.income_transaction_id, req.temple.id);
  }
  const after = db.prepare("SELECT * FROM pooja_bookings WHERE id = ? AND temple_id = ?").get(before.id, req.temple.id);
  writeAudit({
    templeId: req.temple.id,
    entityType: "POOJA_BOOKING",
    entityId: before.id,
    action: "DELETE",
    userId: req.user.id,
    before,
    after,
  });
  ok(res, { id: before.id });
});

// ─── Inventory Endpoints ────────────────────────────────────────────────────────

app.get("/api/:templeSlug/inventory", requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT * FROM inventory_items WHERE temple_id = ? AND active = 1 ORDER BY category, name
  `).all(req.temple.id);
  ok(res, items);
});

app.post("/api/:templeSlug/inventory", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const unit = String(req.body.unit ?? "PIECE").toUpperCase();
  if (!name || !["PIECE", "KG", "LITRE", "PACKET", "DOZEN"].includes(unit)) {
    res.status(400).json({ message: "Name and valid unit are required" });
    return;
  }
  const result = db.prepare(`
    INSERT INTO inventory_items (temple_id, name, unit, current_stock, min_stock, cost_per_unit, category)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.temple.id, name, unit,
    Number(req.body.currentStock ?? 0),
    Number(req.body.minStock ?? 0),
    Number(req.body.costPerUnit ?? 0),
    req.body.category || "POOJA_ITEM"
  );
  const item = db.prepare("SELECT * FROM inventory_items WHERE id = ? AND temple_id = ?").get(result.lastInsertRowid, req.temple.id);
  writeAudit({ templeId: req.temple.id, entityType: "INVENTORY_ITEM", entityId: result.lastInsertRowid, action: "CREATE", userId: req.user.id, after: item });
  ok(res, item);
});

app.put("/api/:templeSlug/inventory/:id", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const before = db.prepare("SELECT * FROM inventory_items WHERE id = ? AND temple_id = ?").get(req.params.id, req.temple.id);
  if (!before) { res.status(404).json({ message: "Item not found" }); return; }
  db.prepare(`
    UPDATE inventory_items SET name = ?, unit = ?, min_stock = ?, cost_per_unit = ?, category = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND temple_id = ?
  `).run(
    req.body.name === undefined ? before.name : String(req.body.name).trim() || before.name,
    req.body.unit || before.unit,
    req.body.minStock === undefined ? before.min_stock : Number(req.body.minStock),
    req.body.costPerUnit === undefined ? before.cost_per_unit : Number(req.body.costPerUnit),
    req.body.category || before.category,
    before.id, req.temple.id
  );
  const after = db.prepare("SELECT * FROM inventory_items WHERE id = ? AND temple_id = ?").get(before.id, req.temple.id);
  writeAudit({ templeId: req.temple.id, entityType: "INVENTORY_ITEM", entityId: before.id, action: "UPDATE", userId: req.user.id, before, after });
  ok(res, after);
});

app.post("/api/:templeSlug/inventory/:id/purchase", requireAuth, (req, res) => {
  const item = db.prepare("SELECT * FROM inventory_items WHERE id = ? AND temple_id = ?").get(req.params.id, req.temple.id);
  if (!item) { res.status(404).json({ message: "Item not found" }); return; }
  const qty = Number(req.body.quantity ?? 0);
  if (!(qty > 0)) { res.status(400).json({ message: "Positive quantity required" }); return; }
  db.prepare("UPDATE inventory_items SET current_stock = current_stock + ?, cost_per_unit = COALESCE(?, cost_per_unit), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND temple_id = ?")
    .run(qty, req.body.costPerUnit ? Number(req.body.costPerUnit) : null, item.id, req.temple.id);
  db.prepare("INSERT INTO inventory_transactions (temple_id, item_id, type, quantity, notes, performed_by_user_id) VALUES (?, ?, 'PURCHASE', ?, ?, ?)")
    .run(req.temple.id, item.id, qty, req.body.notes || null, req.user.id);
  const after = db.prepare("SELECT * FROM inventory_items WHERE id = ? AND temple_id = ?").get(item.id, req.temple.id);
  writeAudit({ templeId: req.temple.id, entityType: "INVENTORY_ITEM", entityId: item.id, action: "UPDATE", userId: req.user.id, before: item, after, comments: `Purchase: +${qty} ${item.unit}` });
  ok(res, after);
});

app.post("/api/:templeSlug/inventory/:id/adjust", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const item = db.prepare("SELECT * FROM inventory_items WHERE id = ? AND temple_id = ?").get(req.params.id, req.temple.id);
  if (!item) { res.status(404).json({ message: "Item not found" }); return; }
  const qty = Number(req.body.quantity ?? 0);
  if (qty === 0) { res.status(400).json({ message: "Adjustment quantity cannot be zero" }); return; }
  const newStock = Math.max(0, item.current_stock + qty);
  db.prepare("UPDATE inventory_items SET current_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND temple_id = ?")
    .run(newStock, item.id, req.temple.id);
  db.prepare("INSERT INTO inventory_transactions (temple_id, item_id, type, quantity, notes, performed_by_user_id) VALUES (?, ?, 'ADJUSTMENT', ?, ?, ?)")
    .run(req.temple.id, item.id, qty, req.body.notes || "Manual adjustment", req.user.id);
  const after = db.prepare("SELECT * FROM inventory_items WHERE id = ? AND temple_id = ?").get(item.id, req.temple.id);
  writeAudit({ templeId: req.temple.id, entityType: "INVENTORY_ITEM", entityId: item.id, action: "UPDATE", userId: req.user.id, before: item, after, comments: `Adjustment: ${qty > 0 ? '+' : ''}${qty}` });
  ok(res, after);
});

app.get("/api/:templeSlug/inventory/low-stock", requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT * FROM inventory_items WHERE temple_id = ? AND active = 1 AND current_stock <= min_stock ORDER BY (current_stock / CASE WHEN min_stock = 0 THEN 1 ELSE min_stock END), name
  `).all(req.temple.id);
  ok(res, items);
});

app.get("/api/:templeSlug/inventory/log", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT it.*, ii.name itemName, ii.unit itemUnit, u.name performedByName
    FROM inventory_transactions it
    JOIN inventory_items ii ON ii.id = it.item_id
    JOIN users u ON u.id = it.performed_by_user_id
    WHERE it.temple_id = ?
    ORDER BY it.created_at DESC
    LIMIT 100
  `).all(req.temple.id);
  ok(res, rows);
});

// ─── Pooja Materials Endpoints ─────────────────────────────────────────────────

app.get("/api/:templeSlug/pooja-materials", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT pm.*, ii.name itemName, ii.unit itemUnit
    FROM pooja_materials pm
    JOIN inventory_items ii ON ii.id = pm.item_id
    WHERE pm.temple_id = ?
    ORDER BY pm.pooja_type, ii.name
  `).all(req.temple.id);
  ok(res, rows);
});

app.post("/api/:templeSlug/pooja-materials", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const poojaType = String(req.body.poojaType ?? "").trim();
  const itemId = Number(req.body.itemId || 0);
  const qty = Number(req.body.quantityPerPooja ?? 1);
  if (!poojaType || !itemId || !(qty > 0)) {
    res.status(400).json({ message: "Pooja type, item, and positive quantity are required" });
    return;
  }
  const item = db.prepare("SELECT id FROM inventory_items WHERE id = ? AND temple_id = ?").get(itemId, req.temple.id);
  if (!item) { res.status(400).json({ message: "Invalid inventory item" }); return; }
  db.prepare(`
    INSERT INTO pooja_materials (temple_id, pooja_type, item_id, quantity_per_pooja)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(temple_id, pooja_type, item_id) DO UPDATE SET quantity_per_pooja = excluded.quantity_per_pooja
  `).run(req.temple.id, poojaType, itemId, qty);
  const row = db.prepare(`
    SELECT pm.*, ii.name itemName, ii.unit itemUnit
    FROM pooja_materials pm JOIN inventory_items ii ON ii.id = pm.item_id
    WHERE pm.temple_id = ? AND pm.pooja_type = ? AND pm.item_id = ?
  `).get(req.temple.id, poojaType, itemId);
  ok(res, row);
});

app.delete("/api/:templeSlug/pooja-materials/:id", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const row = db.prepare("SELECT * FROM pooja_materials WHERE id = ? AND temple_id = ?").get(req.params.id, req.temple.id);
  if (!row) { res.status(404).json({ message: "Material mapping not found" }); return; }
  db.prepare("DELETE FROM pooja_materials WHERE id = ? AND temple_id = ?").run(row.id, req.temple.id);
  ok(res, { id: row.id });
});

app.post("/api/:templeSlug/pooja-materials/consume", requireAuth, (req, res) => {
  const poojaType = String(req.body.poojaType ?? "").trim();
  const bookingId = Number(req.body.bookingId || 0) || null;
  if (!poojaType) { res.status(400).json({ message: "Pooja type required" }); return; }
  const materials = db.prepare("SELECT * FROM pooja_materials WHERE temple_id = ? AND pooja_type = ?").all(req.temple.id, poojaType);
  if (materials.length === 0) { ok(res, { consumed: 0, message: "No materials mapped for this pooja type" }); return; }
  const consume = db.transaction(() => {
    let consumed = 0;
    for (const mat of materials) {
      const item = db.prepare("SELECT * FROM inventory_items WHERE id = ? AND temple_id = ?").get(mat.item_id, req.temple.id);
      if (!item) continue;
      const deduct = mat.quantity_per_pooja;
      const newStock = Math.max(0, item.current_stock - deduct);
      db.prepare("UPDATE inventory_items SET current_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND temple_id = ?")
        .run(newStock, item.id, req.temple.id);
      db.prepare("INSERT INTO inventory_transactions (temple_id, item_id, type, quantity, reference_type, reference_id, notes, performed_by_user_id) VALUES (?, ?, 'CONSUMPTION', ?, 'POOJA_BOOKING', ?, ?, ?)")
        .run(req.temple.id, item.id, -deduct, bookingId, `Consumed for ${poojaType}`, req.user.id);
      consumed++;
    }
    return consumed;
  });
  const count = consume();
  ok(res, { consumed: count, poojaType });
});

// ─── Events Endpoints ──────────────────────────────────────────────────────────

app.get("/api/:templeSlug/events", requireAuth, (req, res) => {
  const month = String(req.query.month ?? "").trim();
  let rows;
  if (/^\d{4}-\d{2}$/.test(month)) {
    rows = db.prepare(`
      SELECT e.*,
        (SELECT COUNT(*) FROM event_tasks WHERE event_id = e.id) totalTasks,
        (SELECT COUNT(*) FROM event_tasks WHERE event_id = e.id AND status = 'DONE') doneTasks,
        (SELECT COALESCE(SUM(amount), 0) FROM event_expenses WHERE event_id = e.id) totalExpenses,
        u.name createdByName
      FROM events e
      JOIN users u ON u.id = e.created_by_user_id
      WHERE e.temple_id = ? AND e.active = 1 AND (e.event_date LIKE ? OR e.end_date LIKE ?)
      ORDER BY e.event_date
    `).all(req.temple.id, `${month}%`, `${month}%`);
  } else {
    rows = db.prepare(`
      SELECT e.*,
        (SELECT COUNT(*) FROM event_tasks WHERE event_id = e.id) totalTasks,
        (SELECT COUNT(*) FROM event_tasks WHERE event_id = e.id AND status = 'DONE') doneTasks,
        (SELECT COALESCE(SUM(amount), 0) FROM event_expenses WHERE event_id = e.id) totalExpenses,
        u.name createdByName
      FROM events e
      JOIN users u ON u.id = e.created_by_user_id
      WHERE e.temple_id = ? AND e.active = 1
      ORDER BY e.event_date DESC
      LIMIT 50
    `).all(req.temple.id);
  }
  ok(res, rows);
});

app.post("/api/:templeSlug/events", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), uploadEvent.single("eventImage"), (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const eventDate = String(req.body.eventDate ?? "").trim();
  if (!name || !eventDate) { res.status(400).json({ message: "Event name and date are required" }); return; }
  let imageUrl = null;
  if (req.file) {
    const ext = req.file.originalname.split(".").pop() || "jpg";
    const fileName = `event-${req.temple.id}-${Date.now()}.${ext}`;
    renameSync(req.file.path, join(eventDir, fileName));
    imageUrl = `/uploads/events/${fileName}`;
  }
  const result = db.prepare(`
    INSERT INTO events (temple_id, name, event_date, end_date, description, budget, status, recurrence, image_url, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.temple.id, name, eventDate,
    req.body.endDate || null,
    req.body.description || null,
    Number(req.body.budget ?? 0),
    req.body.status || "PLANNED",
    req.body.recurrence || "NONE",
    imageUrl,
    req.user.id
  );
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND temple_id = ?").get(result.lastInsertRowid, req.temple.id);
  writeAudit({ templeId: req.temple.id, entityType: "EVENT", entityId: result.lastInsertRowid, action: "CREATE", userId: req.user.id, after: event });
  ok(res, event);
});

app.put("/api/:templeSlug/events/:id", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), uploadEvent.single("eventImage"), (req, res) => {
  const before = db.prepare("SELECT * FROM events WHERE id = ? AND temple_id = ? AND active = 1").get(req.params.id, req.temple.id);
  if (!before) { res.status(404).json({ message: "Event not found" }); return; }
  let imageUrl = before.image_url;
  if (req.file) {
    const ext = req.file.originalname.split(".").pop() || "jpg";
    const fileName = `event-${req.temple.id}-${Date.now()}.${ext}`;
    renameSync(req.file.path, join(eventDir, fileName));
    imageUrl = `/uploads/events/${fileName}`;
  }
  db.prepare(`
    UPDATE events SET name = ?, event_date = ?, end_date = ?, description = ?, budget = ?, actual_cost = ?, status = ?, recurrence = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND temple_id = ?
  `).run(
    req.body.name || before.name,
    req.body.eventDate || before.event_date,
    req.body.endDate === undefined ? before.end_date : req.body.endDate || null,
    req.body.description === undefined ? before.description : req.body.description || null,
    req.body.budget === undefined ? before.budget : Number(req.body.budget),
    req.body.actualCost === undefined ? before.actual_cost : Number(req.body.actualCost),
    req.body.status || before.status,
    req.body.recurrence || before.recurrence,
    imageUrl,
    before.id, req.temple.id
  );
  const after = db.prepare("SELECT * FROM events WHERE id = ? AND temple_id = ?").get(before.id, req.temple.id);
  writeAudit({ templeId: req.temple.id, entityType: "EVENT", entityId: before.id, action: "UPDATE", userId: req.user.id, before, after });
  ok(res, after);
});

app.delete("/api/:templeSlug/events/:id", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const before = db.prepare("SELECT * FROM events WHERE id = ? AND temple_id = ? AND active = 1").get(req.params.id, req.temple.id);
  if (!before) { res.status(404).json({ message: "Event not found" }); return; }
  db.prepare("UPDATE events SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND temple_id = ?").run(before.id, req.temple.id);
  writeAudit({ templeId: req.temple.id, entityType: "EVENT", entityId: before.id, action: "DELETE", userId: req.user.id, before });
  ok(res, { id: before.id });
});

app.get("/api/:templeSlug/events/:id", requireAuth, (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND temple_id = ? AND active = 1").get(req.params.id, req.temple.id);
  if (!event) { res.status(404).json({ message: "Event not found" }); return; }
  const tasks = db.prepare(`
    SELECT et.*, u.name assignedToName
    FROM event_tasks et LEFT JOIN users u ON u.id = et.assigned_to
    WHERE et.event_id = ? AND et.temple_id = ?
    ORDER BY et.due_date, et.title
  `).all(event.id, req.temple.id);
  const poojas = db.prepare(`
    SELECT ep.*, pb.devotee_name devoteeName
    FROM event_poojas ep LEFT JOIN pooja_bookings pb ON pb.id = ep.booking_id
    WHERE ep.event_id = ? AND ep.temple_id = ?
    ORDER BY ep.scheduled_date
  `).all(event.id, req.temple.id);
  const expenses = db.prepare(`
    SELECT ee.*, t.amount txnAmount, t.notes txnNotes, t.transaction_date txnDate
    FROM event_expenses ee LEFT JOIN transactions t ON t.id = ee.transaction_id
    WHERE ee.event_id = ? AND ee.temple_id = ?
    ORDER BY ee.created_at DESC
  `).all(event.id, req.temple.id);
  ok(res, { event, tasks, poojas, expenses });
});

app.post("/api/:templeSlug/events/:id/tasks", requireAuth, requireRole("TRUSTEE", "SUPER_TRUSTEE"), (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND temple_id = ? AND active = 1").get(req.params.id, req.temple.id);
  if (!event) { res.status(404).json({ message: "Event not found" }); return; }
  const title = String(req.body.title ?? "").trim();
  if (!title) { res.status(400).json({ message: "Task title required" }); return; }
  const result = db.prepare(`
    INSERT INTO event_tasks (temple_id, event_id, title, assigned_to, due_date, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.temple.id, event.id, title, req.body.assignedTo ? Number(req.body.assignedTo) : null, req.body.dueDate || null, req.body.notes || null);
  const task = db.prepare(`
    SELECT et.*, u.name assignedToName FROM event_tasks et LEFT JOIN users u ON u.id = et.assigned_to
    WHERE et.id = ? AND et.temple_id = ?
  `).get(result.lastInsertRowid, req.temple.id);
  writeAudit({ templeId: req.temple.id, entityType: "EVENT_TASK", entityId: result.lastInsertRowid, action: "CREATE", userId: req.user.id, after: task });
  ok(res, task);
});

app.put("/api/:templeSlug/events/:id/tasks/:taskId", requireAuth, (req, res) => {
  const task = db.prepare("SELECT * FROM event_tasks WHERE id = ? AND event_id = ? AND temple_id = ?").get(req.params.taskId, req.params.id, req.temple.id);
  if (!task) { res.status(404).json({ message: "Task not found" }); return; }
  db.prepare(`
    UPDATE event_tasks SET title = ?, assigned_to = ?, status = ?, due_date = ?, notes = ?
    WHERE id = ? AND temple_id = ?
  `).run(
    req.body.title || task.title,
    req.body.assignedTo === undefined ? task.assigned_to : (req.body.assignedTo ? Number(req.body.assignedTo) : null),
    req.body.status || task.status,
    req.body.dueDate === undefined ? task.due_date : req.body.dueDate || null,
    req.body.notes === undefined ? task.notes : req.body.notes || null,
    task.id, req.temple.id
  );
  const after = db.prepare(`
    SELECT et.*, u.name assignedToName FROM event_tasks et LEFT JOIN users u ON u.id = et.assigned_to
    WHERE et.id = ? AND et.temple_id = ?
  `).get(task.id, req.temple.id);
  writeAudit({ templeId: req.temple.id, entityType: "EVENT_TASK", entityId: task.id, action: "UPDATE", userId: req.user.id, before: task, after });
  ok(res, after);
});

app.post("/api/:templeSlug/events/:id/poojas", requireAuth, (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND temple_id = ? AND active = 1").get(req.params.id, req.temple.id);
  if (!event) { res.status(404).json({ message: "Event not found" }); return; }
  const poojaType = String(req.body.poojaType ?? "").trim();
  const scheduledDate = String(req.body.scheduledDate ?? "").trim();
  if (!poojaType || !scheduledDate) { res.status(400).json({ message: "Pooja type and date required" }); return; }
  let bookingId = null;
  if (req.body.createBooking !== false) {
    const bookingResult = db.prepare(`
      INSERT INTO pooja_bookings (temple_id, devotee_name, mobile, pooja_type, occasion, occasion_date, amount, notes, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.temple.id, req.body.devoteeName || event.name, req.body.mobile || null,
      poojaType, `Event: ${event.name}`, scheduledDate,
      Number(req.body.amount ?? 0), `Linked to event: ${event.name}`, req.user.id
    );
    bookingId = bookingResult.lastInsertRowid;
    let booking = db.prepare("SELECT * FROM pooja_bookings WHERE id = ? AND temple_id = ?").get(bookingId, req.temple.id);
    syncPoojaIncomeTransaction({ templeId: req.temple.id, booking, userId: req.user.id });
  }
  const result = db.prepare(`
    INSERT INTO event_poojas (temple_id, event_id, pooja_type, scheduled_date, amount, booking_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.temple.id, event.id, poojaType, scheduledDate, Number(req.body.amount ?? 0), bookingId);
  const row = db.prepare(`
    SELECT ep.*, pb.devotee_name devoteeName FROM event_poojas ep LEFT JOIN pooja_bookings pb ON pb.id = ep.booking_id
    WHERE ep.id = ? AND ep.temple_id = ?
  `).get(result.lastInsertRowid, req.temple.id);
  writeAudit({ templeId: req.temple.id, entityType: "EVENT_POOJA", entityId: result.lastInsertRowid, action: "CREATE", userId: req.user.id, after: row });
  ok(res, row);
});

app.post("/api/:templeSlug/events/:id/expenses", requireAuth, (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND temple_id = ? AND active = 1").get(req.params.id, req.temple.id);
  if (!event) { res.status(404).json({ message: "Event not found" }); return; }
  const amount = Number(req.body.amount ?? 0);
  if (!(amount > 0)) { res.status(400).json({ message: "Positive amount required" }); return; }
  const needsApproval = req.user.role === "MANAGER" && amount > req.temple.approval_threshold;
  const status = needsApproval ? "PENDING_APPROVAL" : "APPROVED";
  const txnResult = db.prepare(`
    INSERT INTO transactions (temple_id, type, category_id, subcategory_id, amount, transaction_date, payment_mode, counterparty_name, notes, status, entered_by_user_id, approved_by_user_id, approved_at)
    VALUES (?, 'EXPENSE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.temple.id,
    req.body.categoryId ? Number(req.body.categoryId) : null,
    req.body.subcategoryId ? Number(req.body.subcategoryId) : null,
    amount,
    req.body.transactionDate || new Date().toISOString().slice(0, 10),
    req.body.paymentMode || "CASH",
    req.body.counterpartyName || null,
    `Event: ${event.name} - ${req.body.description || ""}`,
    status,
    req.user.id,
    status === "APPROVED" ? req.user.id : null,
    status === "APPROVED" ? new Date().toISOString() : null
  );
  const txnId = txnResult.lastInsertRowid;
  if (needsApproval) {
    db.prepare("INSERT INTO approvals (temple_id, transaction_id, requested_by_user_id) VALUES (?, ?, ?)").run(req.temple.id, txnId, req.user.id);
  }
  db.prepare("UPDATE events SET actual_cost = actual_cost + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND temple_id = ?").run(amount, event.id, req.temple.id);
  const result = db.prepare(`
    INSERT INTO event_expenses (temple_id, event_id, transaction_id, description, amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.temple.id, event.id, txnId, req.body.description || null, amount);
  const row = db.prepare(`
    SELECT ee.*, t.amount txnAmount, t.notes txnNotes, t.transaction_date txnDate
    FROM event_expenses ee LEFT JOIN transactions t ON t.id = ee.transaction_id
    WHERE ee.id = ? AND ee.temple_id = ?
  `).get(result.lastInsertRowid, req.temple.id);
  writeAudit({ templeId: req.temple.id, entityType: "EVENT_EXPENSE", entityId: result.lastInsertRowid, action: "CREATE", userId: req.user.id, after: row });
  ok(res, { ...row, transactionStatus: status });
});

app.get("/api/:templeSlug/events/:id/summary", requireAuth, (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id = ? AND temple_id = ? AND active = 1").get(req.params.id, req.temple.id);
  if (!event) { res.status(404).json({ message: "Event not found" }); return; }
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM event_tasks WHERE event_id = ?) totalTasks,
      (SELECT COUNT(*) FROM event_tasks WHERE event_id = ? AND status = 'DONE') doneTasks,
      (SELECT COUNT(*) FROM event_poojas WHERE event_id = ?) totalPoojas,
      (SELECT COALESCE(SUM(amount), 0) FROM event_poojas WHERE event_id = ?) poojaRevenue,
      (SELECT COALESCE(SUM(amount), 0) FROM event_expenses WHERE event_id = ?) totalExpenses
  `).get(event.id, event.id, event.id, event.id, event.id);
  ok(res, { event, ...stats, balance: stats.poojaRevenue - stats.totalExpenses });
});

const webDist = join(process.cwd(), "web", "dist");
if (existsSync(webDist)) {
  app.get("/manifest.webmanifest", (req, res) => {
    const slug = (req.query.slug || "hanumagiri").replace(/[^a-z0-9-]/gi, "");
    res.json({
      name: "Temple Seva Ledger",
      short_name: "TSL",
      description: "Temple income, expenses, approvals, ledger, and seva calendar.",
      start_url: "/" + slug,
      scope: "/",
      display: "standalone",
      background_color: "#eef4ff",
      theme_color: "#1f6f5b",
      icons: [{ src: "/icon.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" }]
    });
  });
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api/") || req.path.startsWith("/uploads/")) return next();
    res.sendFile(join(webDist, "index.html"));
  });
}

const server = createServer(app);

server.listen(port, "0.0.0.0", () => {
  console.log(`Temple Seva Ledger API running on http://localhost:${port}`);
  console.log("API listener", server.address());
});

const keepAlive = setInterval(() => {}, 60 * 60 * 1000);

function shutdown() {
  clearInterval(keepAlive);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
