import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, "temple-seva-ledger.db"));
db.pragma("foreign_keys = ON");

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = createHash("sha256").update(`${salt}:${password}`).digest("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, expectedHash] = stored.split(":");
  const actualHash = hashPassword(password, salt).split(":")[1];
  return timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash));
}

function run(sql, params = {}) {
  const statement = db.prepare(sql);
  if (Array.isArray(params)) {
    statement.run(...params);
    return;
  }
  statement.run(params);
}

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS temples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      address TEXT,
      logo_url TEXT,
      approval_threshold REAL NOT NULL DEFAULT 2000,
      default_language TEXT NOT NULL DEFAULT 'en',
      currency TEXT NOT NULL DEFAULT 'INR',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      temple_id INTEGER NOT NULL REFERENCES temples(id),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      role TEXT NOT NULL CHECK (role IN ('MANAGER','TRUSTEE','SUPER_TRUSTEE')),
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      temple_id INTEGER NOT NULL REFERENCES temples(id),
      type TEXT NOT NULL CHECK (type IN ('INCOME','EXPENSE')),
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES categories(id),
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      temple_id INTEGER NOT NULL REFERENCES temples(id),
      type TEXT NOT NULL CHECK (type IN ('INCOME','EXPENSE')),
      category_id INTEGER REFERENCES categories(id),
      subcategory_id INTEGER REFERENCES categories(id),
      amount REAL NOT NULL,
      transaction_date TEXT NOT NULL,
      payment_mode TEXT NOT NULL DEFAULT 'CASH',
      counterparty_name TEXT,
      notes TEXT,
      status TEXT NOT NULL CHECK (status IN ('APPROVED','PENDING_APPROVAL','REJECTED')) DEFAULT 'APPROVED',
      entered_by_user_id INTEGER NOT NULL REFERENCES users(id),
      approved_by_user_id INTEGER REFERENCES users(id),
      approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      temple_id INTEGER NOT NULL REFERENCES temples(id),
      transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
      decided_by_user_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')) DEFAULT 'PENDING',
      comments TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      temple_id INTEGER NOT NULL REFERENCES temples(id),
      transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      file_path TEXT NOT NULL,
      original_file_name TEXT NOT NULL,
      mime_type TEXT,
      uploaded_by_user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pooja_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      temple_id INTEGER NOT NULL REFERENCES temples(id),
      devotee_name TEXT NOT NULL,
      mobile TEXT,
      pooja_type TEXT NOT NULL,
      occasion TEXT NOT NULL,
      occasion_date TEXT NOT NULL,
      amount REAL DEFAULT 0,
      recurring_yearly INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_by_user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      temple_id INTEGER NOT NULL REFERENCES temples(id),
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      performed_by_user_id INTEGER NOT NULL REFERENCES users(id),
      before_json TEXT,
      after_json TEXT,
      comments TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  addColumnIfMissing("transactions", "unlocked", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("transactions", "deleted", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("transactions", "updated_at", "TEXT");
  addColumnIfMissing("pooja_bookings", "updated_at", "TEXT");
  addColumnIfMissing("pooja_bookings", "income_transaction_id", "INTEGER REFERENCES transactions(id)");
  addColumnIfMissing("users", "updated_at", "TEXT");
  addColumnIfMissing("temples", "currency", "TEXT NOT NULL DEFAULT 'INR'");

  const existing = db.prepare("SELECT id FROM temples WHERE slug = ?").get("hanumagiri");
  if (existing) return;

  run(
    "INSERT INTO temples (slug, name, address, approval_threshold) VALUES (?, ?, ?, ?)",
    ["hanumagiri", "Hanumagiri Temple", "Locality temple trust", 2000],
  );
  const templeId = db.prepare("SELECT id FROM temples WHERE slug = ?").get("hanumagiri").id;
  const passwordHash = hashPassword("Temple123#");

  [
    ["Hanumagiri Manager", "manager@hanumagiri.org", "MANAGER"],
    ["Hanumagiri Trustee", "trustee@hanumagiri.org", "TRUSTEE"],
    ["Hanumagiri Super Trustee", "super@hanumagiri.org", "SUPER_TRUSTEE"],
  ].forEach(([name, email, role]) => {
    run(
      "INSERT INTO users (temple_id, name, email, role, password_hash) VALUES (?, ?, ?, ?, ?)",
      [templeId, name, email, role, passwordHash],
    );
  });

  seedCategories(templeId);
}

export function seedCategories(templeId) {
  const expenseMain = [
    "Daily Pooja Expense",
    "Monthly Expense",
    "House Keeping Expense",
    "Salary and Allowances",
    "Temple Maintenance",
    "Special Pooja Expense",
    "Event Expenses",
    "Temple Construction",
  ];
  const incomeMain = [
    "Daily Income",
    "Monthly Income",
    "Special Pooja Income",
    "Donations",
    "Event Income",
  ];
  const subcategories = {
    "Daily Income": ["Hundi", "Archane", "General Seva", "Prasada"],
    "Special Pooja Income": ["Abhisheka", "Alankara", "Sankalpa Pooja", "Festival Pooja"],
    Donations: ["General Donation", "Festival Donation", "Construction Donation"],
    "Daily Pooja Expense": ["Flowers", "Oil", "Camphor", "Coconut", "Pooja Items", "Prasadam"],
    "House Keeping Expense": ["Cleaning Items", "Water", "Waste Collection"],
    "Temple Maintenance": ["Electrical", "Plumbing", "Repairs", "Painting"],
    "Salary and Allowances": ["Priest Honorarium", "Staff Salary", "Allowance"],
    "Event Expenses": ["Decoration", "Sound System", "Annadanam", "Festival Purchase"],
    "Temple Construction": ["Materials", "Labour", "Contractor Payment"],
  };

  const insert = db.prepare("INSERT INTO categories (temple_id, type, name, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)");
  expenseMain.forEach((name, index) => insert.run(templeId, "EXPENSE", name, null, index + 1));
  incomeMain.forEach((name, index) => insert.run(templeId, "INCOME", name, null, index + 1));

  Object.entries(subcategories).forEach(([parentName, children]) => {
    const parent = db.prepare("SELECT id, type FROM categories WHERE temple_id = ? AND name = ?").get(templeId, parentName);
    if (!parent) return;
    children.forEach((child, index) => insert.run(templeId, parent.type, child, parent.id, index + 1));
  });
}

export function getTempleBySlug(slug) {
  return db.prepare("SELECT * FROM temples WHERE slug = ? AND active = 1").get(slug);
}
