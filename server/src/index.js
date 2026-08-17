import express from "express";
import cors from "cors";
import multer from "multer";
import { mkdirSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createSession, requireAuth, requireRole } from "./auth.js";
import { db, getTempleBySlug, hashPassword, initDb, seedCategories, verifyPassword } from "./db.js";

initDb();

const app = express();
const port = Number(process.env.PORT ?? 4000);
const uploadDir = join(process.cwd(), "uploads", "receipts");
mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 8 * 1024 * 1024 } });

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
  });
});

app.get("/api/:templeSlug/public/temples", (req, res) => {
  const temples = db.prepare("SELECT slug, name FROM temples WHERE active = 1 ORDER BY name").all();
  ok(res, temples);
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
    temple: { id: temple.id, slug: temple.slug, name: temple.name, approvalThreshold: temple.approval_threshold, defaultLanguage: temple.default_language },
  });
});

app.get("/api/:templeSlug/me", requireAuth, (req, res) => {
  ok(res, { user: req.user, temple: req.temple });
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
  db.prepare(`
    UPDATE temples
    SET name = ?, address = ?, logo_url = ?, approval_threshold = ?, default_language = ?
    WHERE id = ?
  `).run(
    name,
    req.body.address === undefined ? before.address : (req.body.address || null),
    req.body.logoUrl === undefined ? before.logo_url : (req.body.logoUrl || null),
    threshold,
    defaultLanguage,
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
  });
});

app.get("/api/:templeSlug/admin/temples", requireAuth, requireRole("SUPER_TRUSTEE"), (req, res) => {
  ok(res, db.prepare(`
    SELECT id, slug, name, address, approval_threshold AS approvalThreshold,
           default_language AS defaultLanguage, active
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
    INSERT INTO temples (slug, name, address, approval_threshold, default_language)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    slug,
    name,
    req.body.address || null,
    Number(req.body.approvalThreshold ?? 2000),
    ["en", "kn"].includes(req.body.defaultLanguage) ? req.body.defaultLanguage : "en",
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

const webDist = join(process.cwd(), "web", "dist");
if (existsSync(webDist)) {
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
