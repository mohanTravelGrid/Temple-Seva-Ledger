import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Category,
  ApprovalRow,
  AdminTemple,
  CategoryRow,
  LedgerRow,
  PoojaBooking,
  Session,
  TempleSettings,
  TransactionType,
  UserRow,
  InventoryItem,
  InventoryLog,
  PoojaMaterial,
  EventRow,
  EventDetail,
  createAdminCategory,
  createAdminTemple,
  createAdminUser,
  createPoojaBooking,
  createTransaction,
  deletePoojaBooking,
  deleteTransaction,
  decideApproval,
  fetchAdminCategories,
  fetchAdminTemples,
  fetchAdminUsers,
  fetchApprovals,
  fetchCategories,
  fetchDashboardForMonth,
  fetchPoojaBookings,
  fetchTemplePublic,
  fetchTransactions,
  getTempleSlug,
  loadSession,
  login,
  saveSession,
  unlockTransaction,
  updateAdminCategory,
  updateAdminUser,
  updatePoojaBooking,
  updateTemple,
  updateTransaction,
  fetchInventory,
  createInventoryItem,
  updateInventoryItem,
  purchaseInventoryItem,
  adjustInventoryItem,
  fetchLowStockItems,
  fetchInventoryLog,
  fetchPoojaMaterials,
  upsertPoojaMaterial,
  deletePoojaMaterial,
  consumePoojaMaterials,
  fetchEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  fetchEventDetail,
  createEventTask,
  updateEventTask,
  createEventPooja,
  createEventExpense,
  fetchEventSummary
} from "./api/client";
import { allLabels, LangCode } from "./i18n";
import "./styles/app.css";

const CURRENCY_MAP: Record<string, { locale: string; code: string }> = {
  INR: { locale: "en-IN", code: "INR" },
  GBP: { locale: "en-GB", code: "GBP" },
  USD: { locale: "en-US", code: "USD" },
};

const formatCurrency = (value: number, currency = "INR") => {
  const cfg = CURRENCY_MAP[currency] || CURRENCY_MAP.INR;
  return new Intl.NumberFormat(cfg.locale, { style: "currency", currency: cfg.code, maximumFractionDigits: 0 }).format(Number(value || 0));
};

const isWithinCorrectionWindow = (createdAt?: string) => {
  if (!createdAt) return false;
  const timestamp = Date.parse(`${createdAt.replace(" ", "T")}Z`);
  return !Number.isNaN(timestamp) && Date.now() - timestamp <= 2 * 60 * 60 * 1000;
};

const LangContext = createContext<LangCode>("en");

function useLabels() {
  return allLabels[useContext(LangContext)];
}

type View = "home" | "income" | "expense" | "ledger" | "approvals" | "pooja" | "admin" | "inventory" | "events";
type LedgerFilterType = "ALL" | "INCOME" | "EXPENSE";

const toDateInputValue = (date: Date) => date.toISOString().slice(0, 10);

const getDefaultLedgerRange = () => {
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - 7);
  return {
    from: toDateInputValue(from),
    to: toDateInputValue(to),
  };
};

function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [temple, setTemple] = useState<{ name: string; approvalThreshold: number; defaultLanguage?: string; currency?: string } | null>(null);
  const [view, setView] = useState<View>("home");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    fetchTemplePublic()
      .then(setTemple)
      .catch(() => setTemple({ name: "Temple Seva Ledger", approvalThreshold: 2000, defaultLanguage: "en", currency: "INR" }));
  }, []);

  const onLogin = (next: Session) => {
    saveSession(next);
    setSession(next);
  };

  const onLogout = () => {
    saveSession(null);
    setSession(null);
    setView("home");
  };

  const lang = ((temple?.defaultLanguage ?? session?.temple.defaultLanguage ?? "en") as LangCode);
  const l = allLabels[lang];

  return (
    <LangContext.Provider value={lang}>
      {!session ? (
        <LoginScreen templeName={temple?.name ?? "Temple Seva Ledger"} onLogin={onLogin} />
      ) : (
        <div className="app-shell">
          <header className="topbar">
            <div>
              <p className="eyebrow">{l.appName}</p>
              <h1>{temple?.name ?? session.temple.name}</h1>
              <p className="subtle">/{getTempleSlug()} · {session.user.role.replaceAll("_", " ")}</p>
            </div>
            <button className="ghost-button" onClick={onLogout}>{l.logout}</button>
          </header>

          <main>
            {view === "home" ? <HomeView session={session} onNavigate={setView} refreshKey={refreshKey} currency={temple?.currency} /> : null}
            {view === "income" ? <TransactionForm type="INCOME" onDone={() => { setRefreshKey((x) => x + 1); setView("ledger"); }} /> : null}
            {view === "expense" ? <TransactionForm type="EXPENSE" onDone={() => { setRefreshKey((x) => x + 1); setView("ledger"); }} /> : null}
            {view === "ledger" ? <LedgerView session={session} refreshKey={refreshKey} onDone={() => setRefreshKey((x) => x + 1)} currency={temple?.currency} /> : null}
            {view === "approvals" ? <ApprovalsView onDone={() => setRefreshKey((x) => x + 1)} currency={temple?.currency} /> : null}
            {view === "pooja" ? <PoojaCalendarView onDone={() => setRefreshKey((x) => x + 1)} /> : null}
            {view === "inventory" ? <InventoryView session={session} /> : null}
            {view === "events" ? <EventsView session={session} /> : null}
            {view === "admin" ? <AdminView session={session} onSettingsChange={(next) => setTemple((current) => ({
              name: next.name ?? current?.name ?? "Temple Seva Ledger",
              approvalThreshold: next.approvalThreshold ?? current?.approvalThreshold ?? 2000,
              defaultLanguage: next.defaultLanguage ?? current?.defaultLanguage ?? "en",
              currency: next.currency ?? current?.currency ?? "INR",
            }))} /> : null}
          </main>

          <BottomNav view={view} onNavigate={setView} />
        </div>
      )}
    </LangContext.Provider>
  );
}

function BottomNav({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  const l = useLabels();
  const items: [View, string][] = [
    ["home", l.navHome],
    ["inventory", l.navInventory],
    ["pooja", l.navPooja],
    ["events", l.navEvents],
    ["ledger", l.navLedger]
  ];
  return (
    <nav className="bottom-nav">
      {items.map(([key, label]) => (
        <button key={key} className={view === key ? "active" : ""} onClick={() => onNavigate(key)}>{label}</button>
      ))}
    </nav>
  );
}

function LoginScreen({ templeName, onLogin }: { templeName: string; onLogin: (session: Session) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const l = useLabels();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      onLogin(await login(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="logo-mark">ॐ</div>
        <p className="eyebrow">{l.appName}</p>
        <h1>{templeName}</h1>
        <p className="subtle">{l.appTagline}</p>
        <form onSubmit={submit} className="form-stack">
          <label>{l.email}<input value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>{l.password}<input value={password} type="password" onChange={(event) => setPassword(event.target.value)} /></label>
          {error ? <p className="error">{error}</p> : null}
          <button className="primary-button">{l.signIn}</button>
        </form>
        <a href="/tsl-seva-control.html" target="_blank" rel="noopener noreferrer" className="control-story-link">{l.tslSevaControl}</a>
        <a href="/tsl-isolation-proof.html" target="_blank" rel="noopener noreferrer" className="control-story-link">{l.tslIsolationProof}</a>
      </section>
    </main>
  );
}

function HomeView({ session, onNavigate, refreshKey, currency }: { session: Session; onNavigate: (view: View) => void; refreshKey: number; currency?: string }) {
  const [summary, setSummary] = useState({
    todayIncome: 0,
    todayExpense: 0,
    monthIncome: 0,
    monthExpense: 0,
    balance: 0,
    pendingApprovals: 0,
    todayPoojas: 0,
    monthPoojas: 0,
    todayPoojaBookings: [] as PoojaBooking[],
    monthPoojaBookings: [] as PoojaBooking[],
  });
  const [dashboardMonth, setDashboardMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const l = useLabels();

  useEffect(() => {
    fetchDashboardForMonth(dashboardMonth).then(setSummary).catch(console.error);
  }, [dashboardMonth, refreshKey]);

  const cards = [
    { key: "expense", title: l.expenses, value: formatCurrency(summary.monthExpense, currency), text: l.expensesText, tone: "expense" },
    { key: "income", title: l.income, value: formatCurrency(summary.monthIncome, currency), text: l.incomeText, tone: "income" },
    { key: "ledger", title: l.reports, value: formatCurrency(summary.balance, currency), text: l.reportsText, tone: "report" },
    { key: "pooja", title: l.poojaCalendar, value: String(summary.monthPoojas), text: l.poojaCalendarText, tone: "pooja" },
    { key: session.user.role === "MANAGER" ? "approvals" : "admin", title: session.user.role === "MANAGER" ? l.approvals : l.admin, value: String(summary.pendingApprovals), text: l.approvalsText, tone: "admin" }
  ];

  return (
    <section className="content-stack">
      <div className="dashboard-filter panel compact-panel">
        <label>{l.dashboardMonth}<input type="month" value={dashboardMonth} onChange={(event) => setDashboardMonth(event.target.value)} /></label>
      </div>
      <div className="home-grid">
        {cards.map((card) => (
          <button key={card.title} className={`home-card ${card.tone}`} onClick={() => onNavigate(card.key as View)}>
            <span>{card.title}</span>
            <strong>{card.value}</strong>
            <small>{card.text}</small>
          </button>
        ))}
      </div>
      {summary.monthPoojaBookings.length > 0 ? (
        <div className="today-pooja-strip">
          <div>
            <p className="eyebrow">{l.selectedMonthPoojas}</p>
            <h2>{summary.monthPoojaBookings.length} {l.sevaReminders}</h2>
          </div>
          <div className="today-pooja-list">
            {summary.monthPoojaBookings.map((pooja) => (
              <button key={pooja.id} className="today-pooja-item" type="button" onClick={() => onNavigate("pooja")}>
                <strong>{pooja.devotee_name}</strong>
                <span>{pooja.occasion_date.slice(5)} · {pooja.occasion} · {pooja.pooja_type}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TransactionForm({ type, onDone }: { type: "INCOME" | "EXPENSE"; onDone: () => void }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [transactionDate, setTransactionDate] = useState(new Date().toISOString().slice(0, 10));
  const [paymentMode, setPaymentMode] = useState("CASH");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [notes, setNotes] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const l = useLabels();

  useEffect(() => {
    fetchCategories().then((data) => {
      const list = type === "INCOME" ? data.income : data.expense;
      setCategories(list);
      setCategoryId(String(list[0]?.id ?? ""));
    });
  }, [type]);

  const selectedCategory = useMemo(() => categories.find((item) => String(item.id) === categoryId), [categories, categoryId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    const formData = new FormData();
    formData.append("type", type);
    formData.append("categoryId", categoryId);
    formData.append("subcategoryId", subcategoryId);
    formData.append("amount", amount);
    formData.append("transactionDate", transactionDate);
    formData.append("paymentMode", paymentMode);
    formData.append("counterpartyName", counterpartyName);
    formData.append("notes", notes);
    if (receipt) formData.append("receipt", receipt);
    try {
      const result = await createTransaction(formData);
      setMessage(result.status === "PENDING_APPROVAL" ? "Saved and sent for trustee approval." : "Saved to ledger.");
      window.setTimeout(onDone, 700);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save");
    }
  }

  return (
    <section className="panel">
      <p className="eyebrow">{type === "INCOME" ? l.income : l.expenses}</p>
      <h2>{type === "INCOME" ? l.addIncome : l.addExpense}</h2>
      <form className="form-stack" onSubmit={submit}>
        <label>{l.mainCategory}<select value={categoryId} onChange={(event) => { setCategoryId(event.target.value); setSubcategoryId(""); }}>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>{l.subCategory}<select value={subcategoryId} onChange={(event) => setSubcategoryId(event.target.value)}><option value="">Select optional subcategory</option>{selectedCategory?.children?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className="two-col">
          <label>{l.amount}<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0" /></label>
          <label>{l.date}<input type="date" value={transactionDate} onChange={(event) => setTransactionDate(event.target.value)} /></label>
        </div>
        <label>{l.paymentMode}<select value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)}><option>CASH</option><option>UPI</option><option>BANK</option><option>CHEQUE</option></select></label>
        <label>{type === "INCOME" ? l.devoteeSource : l.shopVendor}<input value={counterpartyName} onChange={(event) => setCounterpartyName(event.target.value)} /></label>
        <label>{l.notes}<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} /></label>
        <label>{l.receiptPhoto}<input type="file" accept="image/*,.pdf" onChange={(event) => setReceipt(event.target.files?.[0] ?? null)} /></label>
        {message ? <p className="notice">{message}</p> : null}
        <button className="primary-button">{type === "INCOME" ? l.saveIncome : l.saveExpense}</button>
      </form>
    </section>
  );
}

function LedgerView({ session, refreshKey, onDone, currency }: { session: Session; refreshKey: number; onDone: () => void; currency?: string }) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [categories, setCategories] = useState<{ income: Category[]; expense: Category[] }>({ income: [], expense: [] });
  const [editing, setEditing] = useState<LedgerRow | null>(null);
  const [form, setForm] = useState({ type: "EXPENSE", categoryId: "", subcategoryId: "", amount: "", transactionDate: "", paymentMode: "CASH", counterpartyName: "", notes: "" });
  const [message, setMessage] = useState("");
  const [dateRange, setDateRange] = useState(() => getDefaultLedgerRange());
  const [ledgerType, setLedgerType] = useState<LedgerFilterType>("ALL");
  const l = useLabels();

  const load = async () => {
    setRows(await fetchTransactions());
  };

  useEffect(() => {
    void load().catch(console.error);
  }, [refreshKey]);

  useEffect(() => {
    fetchCategories().then(setCategories).catch(console.error);
  }, []);

  const selectedCategories = form.type === "INCOME" ? categories.income : categories.expense;
  const selectedCategory = selectedCategories.find((item) => String(item.id) === form.categoryId);
  const canUnlock = session.user.role === "TRUSTEE" || session.user.role === "SUPER_TRUSTEE";
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const inType = ledgerType === "ALL" || row.type === ledgerType;
      const inFrom = !dateRange.from || row.transaction_date >= dateRange.from;
      const inTo = !dateRange.to || row.transaction_date <= dateRange.to;
      return inType && inFrom && inTo;
    });
  }, [dateRange.from, dateRange.to, ledgerType, rows]);

  const filterSummary = `${filteredRows.length} ${l.of} ${rows.length} ${l.entries}`;

  function startEdit(row: LedgerRow) {
    setMessage("");
    setEditing(row);
    setForm({
      type: row.type,
      categoryId: String(row.category_id ?? ""),
      subcategoryId: String(row.subcategory_id ?? ""),
      amount: String(row.amount ?? ""),
      transactionDate: row.transaction_date,
      paymentMode: row.payment_mode || "CASH",
      counterpartyName: row.counterparty_name || "",
      notes: row.notes || "",
    });
  }

  async function unlock(row: LedgerRow) {
    try {
      setMessage("");
      await unlockTransaction(row.id);
      setMessage("Entry unlocked. It can now be corrected or removed.");
      await load();
      onDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to unlock entry");
    }
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    try {
      setMessage("");
      await updateTransaction(editing.id, {
        type: form.type,
        categoryId: form.categoryId || editing.category_id || "",
        subcategoryId: form.subcategoryId || editing.subcategory_id || "",
        amount: Number(form.amount || 0),
        transactionDate: form.transactionDate,
        paymentMode: form.paymentMode,
        counterpartyName: form.counterpartyName,
        notes: form.notes,
      });
      setEditing(null);
      setMessage("Ledger entry updated. Audit trail captured.");
      await load();
      onDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to update entry");
    }
  }

  async function remove(row: LedgerRow) {
    if (!window.confirm("Remove this ledger entry? The audit trail will be preserved.")) return;
    try {
      setMessage("");
      await deleteTransaction(row.id);
      setMessage("Ledger entry removed. Audit trail captured.");
      await load();
      onDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to remove entry");
    }
  }

  return (
    <section className="content-stack">
      <div className="section-title ledger-heading">
        <div>
          <h2>{l.ledger}</h2>
          <p className="subtle">{l.showing} {filterSummary}</p>
        </div>
        <button className="text-button" type="button" onClick={() => setDateRange(getDefaultLedgerRange())}>{l.thisWeek}</button>
      </div>
      <div className="ledger-filters panel compact-panel">
        <label>{l.fromDate}<input type="date" value={dateRange.from} onChange={(event) => setDateRange((current) => ({ ...current, from: event.target.value }))} /></label>
        <label>{l.toDate}<input type="date" value={dateRange.to} onChange={(event) => setDateRange((current) => ({ ...current, to: event.target.value }))} /></label>
        <label>{l.type}<select value={ledgerType} onChange={(event) => setLedgerType(event.target.value as LedgerFilterType)}><option value="ALL">{l.all}</option><option value="INCOME">{l.income}</option><option value="EXPENSE">{l.expenses}</option></select></label>
      </div>
      {message ? <p className="notice">{message}</p> : null}
      {editing ? (
        <div className="panel compact-panel">
          <div className="section-title">
            <div>
              <p className="eyebrow">Unlocked correction</p>
              <h2>{l.editLedgerEntry}</h2>
            </div>
            <button className="text-button" type="button" onClick={() => setEditing(null)}>{l.cancel}</button>
          </div>
          <form className="form-stack" onSubmit={saveEdit}>
            <label>{l.type}<select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value, categoryId: "", subcategoryId: "" })}><option>INCOME</option><option>EXPENSE</option></select></label>
            <label>{l.mainCategory}<select value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value, subcategoryId: "" })}><option value="">Select category</option>{selectedCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>{l.subCategory}<select value={form.subcategoryId} onChange={(event) => setForm({ ...form, subcategoryId: event.target.value })}><option value="">Select optional subcategory</option>{selectedCategory?.children?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <div className="two-col">
              <label>{l.amount}<input inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
              <label>{l.date}<input type="date" value={form.transactionDate} onChange={(event) => setForm({ ...form, transactionDate: event.target.value })} /></label>
            </div>
            <label>{l.paymentMode}<select value={form.paymentMode} onChange={(event) => setForm({ ...form, paymentMode: event.target.value })}><option>CASH</option><option>UPI</option><option>BANK</option><option>CHEQUE</option></select></label>
            <label>{l.devoteeSource}<input value={form.counterpartyName} onChange={(event) => setForm({ ...form, counterpartyName: event.target.value })} /></label>
            <label>{l.notes}<textarea rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
            <button className="primary-button">{l.updateEntry}</button>
          </form>
        </div>
      ) : null}
      {filteredRows.map((row) => (
        <article key={row.id} className={`ledger-row ${row.type.toLowerCase()}`}>
          <div>
            <strong>{row.categoryName ?? row.type}</strong>
            <p>{row.subcategoryName || row.notes || row.counterparty_name || "No notes"}</p>
            <small>{row.transaction_date} · {row.enteredByName} · {row.status.replaceAll("_", " ")}</small>
            <div className="row-actions">
              {row.unlocked || isWithinCorrectionWindow(row.created_at) ? (
                <>
                  <button className="mini-button" type="button" onClick={() => startEdit(row)}>{l.edit}</button>
                  <button className="mini-button danger" type="button" onClick={() => remove(row)}>{l.remove}</button>
                </>
              ) : canUnlock ? (
                <button className="mini-button" type="button" onClick={() => unlock(row)}>{l.unlock}</button>
              ) : (
                <span className="locked-note">Older than 2 hours. Trustee unlock required.</span>
              )}
            </div>
          </div>
          <strong>{formatCurrency(row.amount, currency)}</strong>
        </article>
      ))}
      {rows.length === 0 ? <p className="subtle">No ledger entries yet.</p> : null}
      {rows.length > 0 && filteredRows.length === 0 ? <p className="subtle">No ledger entries found for the selected date range and type.</p> : null}
    </section>
  );
}

function ApprovalsView({ onDone, currency }: { onDone: () => void; currency?: string }) {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const l = useLabels();
  const load = () => fetchApprovals().then(setRows).catch(console.error);
  useEffect(() => {
    void load();
  }, []);

  async function decide(id: number, decision: "APPROVED" | "REJECTED") {
    await decideApproval(id, decision);
    await load();
    onDone();
  }

  return (
    <section className="content-stack">
      <h2>{l.pendingApprovals}</h2>
      {rows.map((row) => (
        <article key={row.id} className="approval-card">
          <p className="eyebrow">{row.categoryName ?? "Expense"} · {row.transactionDate}</p>
          <h3>{formatCurrency(row.amount, currency)}</h3>
          <p>{row.notes || "Approval requested"}</p>
          <small>{l.requestedBy} {row.requestedByName}</small>
          <div className="button-row">
            <button className="ghost-button" onClick={() => decide(row.id, "REJECTED")}>{l.reject}</button>
            <button className="primary-button" onClick={() => decide(row.id, "APPROVED")}>{l.approve}</button>
          </div>
        </article>
      ))}
      {rows.length === 0 ? <p className="subtle">No pending approvals.</p> : null}
    </section>
  );
}

function PoojaCalendarView({ onDone }: { onDone: () => void }) {
  const [rows, setRows] = useState<PoojaBooking[]>([]);
  const l = useLabels();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [poojaMonth, setPoojaMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [form, setForm] = useState({ devoteeName: "", mobile: "", poojaType: "Annual Pooja", occasion: "Birthday", occasionDate: "", amount: "", notes: "" });
  const load = () => fetchPoojaBookings().then(setRows).catch(console.error);
  useEffect(() => {
    void load();
  }, []);

  const filteredRows = useMemo(
    () => rows.filter((row) => row.occasion_date.slice(5, 7) === poojaMonth.slice(5, 7)),
    [poojaMonth, rows],
  );

  function resetForm() {
    setEditingId(null);
    setForm({ devoteeName: "", mobile: "", poojaType: "Annual Pooja", occasion: "Birthday", occasionDate: "", amount: "", notes: "" });
  }

  function openAddBooking() {
    resetForm();
    setIsFormOpen(true);
  }

  function closeForm() {
    setIsFormOpen(false);
    resetForm();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (editingId) {
      await updatePoojaBooking(editingId, { ...form, amount: Number(form.amount || 0) });
    } else {
      await createPoojaBooking({ ...form, amount: Number(form.amount || 0) });
    }
    closeForm();
    await load();
    onDone();
  }

  function startEdit(row: PoojaBooking) {
    setEditingId(row.id);
    setForm({
      devoteeName: row.devotee_name,
      mobile: row.mobile || "",
      poojaType: row.pooja_type,
      occasion: row.occasion,
      occasionDate: row.occasion_date,
      amount: String(row.amount ?? ""),
      notes: row.notes || "",
    });
    setIsFormOpen(true);
  }

  async function remove(row: PoojaBooking) {
    if (!window.confirm("Remove this pooja calendar record?")) return;
    await deletePoojaBooking(row.id);
    await load();
    onDone();
  }

  return (
    <section className="content-stack">
      <div className="section-title">
        <div>
          <p className="eyebrow">Seva Calendar</p>
          <h2>{l.monthlyBoard}</h2>
        </div>
        <button className="primary-button" type="button" onClick={openAddBooking}>{l.addBooking}</button>
      </div>
      <div className="dashboard-filter panel compact-panel">
        <label>{l.poojaMonth}<input type="month" value={poojaMonth} onChange={(event) => setPoojaMonth(event.target.value)} /></label>
      </div>
      {filteredRows.map((row) => (
        <article key={row.id} className="ledger-row pooja">
          <div>
            <strong>{row.devotee_name}</strong>
            <p>{row.occasion} · {row.pooja_type}</p>
            <small>{row.occasion_date}</small>
            <div className="row-actions">
              <button className="mini-button" type="button" onClick={() => startEdit(row)}>{l.edit}</button>
              <button className="mini-button danger" type="button" onClick={() => remove(row)}>{l.remove}</button>
            </div>
          </div>
        </article>
      ))}
      {filteredRows.length === 0 ? <p className="subtle">No pooja bookings found for the selected month.</p> : null}
      {isFormOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">Seva Calendar</p>
                <h2>{editingId ? l.editBooking : l.addBookingTitle}</h2>
              </div>
              <button className="text-button" type="button" onClick={closeForm}>{l.close}</button>
            </div>
            <form className="form-stack" onSubmit={submit}>
              <label>{l.devoteeName}<input value={form.devoteeName} onChange={(event) => setForm({ ...form, devoteeName: event.target.value })} /></label>
              <label>{l.mobile}<input value={form.mobile} onChange={(event) => setForm({ ...form, mobile: event.target.value })} /></label>
              <div className="two-col">
                <label>{l.occasion}<select value={form.occasion} onChange={(event) => setForm({ ...form, occasion: event.target.value })}><option>Birthday</option><option>Wedding Anniversary</option><option>Memorial</option><option>Other</option></select></label>
                <label>{l.date}<input type="date" value={form.occasionDate} onChange={(event) => setForm({ ...form, occasionDate: event.target.value })} /></label>
              </div>
              <label>{l.poojaType}<input value={form.poojaType} onChange={(event) => setForm({ ...form, poojaType: event.target.value })} /></label>
              <div className="two-col">
                <label>{l.amount}<input inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
                <label>{l.notes}<input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
              </div>
              <button className="primary-button">{editingId ? l.updateBooking : l.addBooking}</button>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function InventoryView({ session }: { session: Session }) {
  const l = useLabels();
  const [tab, setTab] = useState<"stock" | "materials" | "log">("stock");
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [lowItems, setLowItems] = useState<InventoryItem[]>([]);
  const [materials, setMaterials] = useState<PoojaMaterial[]>([]);
  const [logs, setLogs] = useState<InventoryLog[]>([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [purchaseItem, setPurchaseItem] = useState<InventoryItem | null>(null);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ name: "", unit: "PIECE", currentStock: "0", minStock: "0", costPerUnit: "0", category: "POOJA_ITEM" });
  const [purchaseForm, setPurchaseForm] = useState({ quantity: "", costPerUnit: "", notes: "" });
  const [matForm, setMatForm] = useState({ poojaType: "", itemId: "", quantityPerPooja: "1" });
  const isTrustee = session.user.role === "TRUSTEE" || session.user.role === "SUPER_TRUSTEE";

  const loadAll = () => {
    fetchInventory().then(setItems).catch(console.error);
    fetchLowStockItems().then(setLowItems).catch(console.error);
    fetchPoojaMaterials().then(setMaterials).catch(console.error);
    fetchInventoryLog().then(setLogs).catch(console.error);
  };
  useEffect(() => { void loadAll(); }, []);

  function openAdd() {
    setEditing(null);
    setForm({ name: "", unit: "PIECE", currentStock: "0", minStock: "0", costPerUnit: "0", category: "POOJA_ITEM" });
    setIsFormOpen(true);
  }
  function openEdit(item: InventoryItem) {
    setEditing(item);
    setForm({ name: item.name, unit: item.unit, currentStock: String(item.current_stock), minStock: String(item.min_stock), costPerUnit: String(item.cost_per_unit), category: item.category });
    setIsFormOpen(true);
  }
  function openPurchase(item: InventoryItem) {
    setPurchaseItem(item);
    setPurchaseForm({ quantity: "", costPerUnit: String(item.cost_per_unit), notes: "" });
  }

  async function submitItem(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      if (editing) {
        await updateInventoryItem(editing.id, { name: form.name, unit: form.unit, minStock: Number(form.minStock), costPerUnit: Number(form.costPerUnit), category: form.category });
      } else {
        await createInventoryItem({ name: form.name, unit: form.unit, currentStock: Number(form.currentStock), minStock: Number(form.minStock), costPerUnit: Number(form.costPerUnit), category: form.category });
      }
      setIsFormOpen(false);
      loadAll();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save"); }
  }

  async function submitPurchase(event: React.FormEvent) {
    event.preventDefault();
    if (!purchaseItem) return;
    setMessage("");
    try {
      await purchaseInventoryItem(purchaseItem.id, { quantity: Number(purchaseForm.quantity), costPerUnit: Number(purchaseForm.costPerUnit), notes: purchaseForm.notes });
      setPurchaseItem(null);
      setMessage("Stock purchased successfully.");
      loadAll();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to purchase"); }
  }

  async function submitMaterial(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      await upsertPoojaMaterial({ poojaType: matForm.poojaType, itemId: Number(matForm.itemId), quantityPerPooja: Number(matForm.quantityPerPooja) });
      setMatForm({ poojaType: "", itemId: "", quantityPerPooja: "1" });
      setMessage("Material mapping saved.");
      loadAll();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save"); }
  }

  async function removeMaterial(id: number) {
    if (!window.confirm("Remove this material mapping?")) return;
    await deletePoojaMaterial(id);
    loadAll();
  }

  const uniquePoojaTypes = [...new Set(materials.map((m) => m.pooja_type))];
  const groupedMaterials = uniquePoojaTypes.map((pt) => ({ poojaType: pt, items: materials.filter((m) => m.pooja_type === pt) }));

  return (
    <section className="content-stack">
      <div className="section-title">
        <div>
          <p className="eyebrow">{l.inventory}</p>
          <h2>{l.stockList}</h2>
        </div>
        {isTrustee ? <button className="primary-button" type="button" onClick={openAdd}>{l.addNewItem}</button> : null}
      </div>
      <div className="detail-tabs">
        <button className={tab === "stock" ? "active" : ""} onClick={() => setTab("stock")}>{l.stockList}</button>
        <button className={tab === "materials" ? "active" : ""} onClick={() => setTab("materials")}>{l.poojaMaterials}</button>
        <button className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>{l.stockLog}</button>
      </div>
      {message ? <p className="notice">{message}</p> : null}
      {tab === "stock" ? (
        <>
          {lowItems.length > 0 ? (
            <div className="panel compact-panel" style={{ borderLeft: "5px solid #ef4444", background: "linear-gradient(135deg, #ffffff, #fef2f2)" }}>
              <p className="eyebrow" style={{ color: "#ef4444" }}>{l.lowStock} — {lowItems.length} {l.items} {l.belowMinStock}</p>
            </div>
          ) : null}
          {items.map((item) => (
            <article key={item.id} className={`stock-card ${item.current_stock <= item.min_stock ? "low" : "ok"}`}>
              <div className="stock-info">
                <strong>{item.name}</strong>
                <p>{item.unit} · {item.category} · ₹{item.cost_per_unit}/{item.unit}</p>
                {isTrustee ? (
                  <div className="stock-actions">
                    <button className="mini-button" type="button" onClick={() => openPurchase(item)}>{l.purchase}</button>
                    <button className="mini-button" type="button" onClick={() => openEdit(item)}>{l.edit}</button>
                  </div>
                ) : null}
              </div>
              <div className="stock-value">
                <strong>{item.current_stock}</strong>
                <small>min: {item.min_stock}</small>
              </div>
            </article>
          ))}
          {items.length === 0 ? <p className="subtle">No inventory items yet.</p> : null}
        </>
      ) : null}
      {tab === "materials" ? (
        <>
          {isTrustee ? (
            <div className="panel compact-panel">
              <p className="eyebrow">{l.mapMaterials}</p>
              <form className="form-stack" onSubmit={submitMaterial}>
                <div className="two-col">
                  <label>{l.poojaTypeLabel}<input value={matForm.poojaType} onChange={(e) => setMatForm({ ...matForm, poojaType: e.target.value })} placeholder="e.g. Abhisheka" /></label>
                  <label>{l.materialItem}<select value={matForm.itemId} onChange={(e) => setMatForm({ ...matForm, itemId: e.target.value })}><option value="">Select</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}</select></label>
                </div>
                <div className="two-col">
                  <label>{l.qtyPerPooja}<input inputMode="decimal" value={matForm.quantityPerPooja} onChange={(e) => setMatForm({ ...matForm, quantityPerPooja: e.target.value })} /></label>
                  <button className="primary-button" style={{ alignSelf: "end" }}>{l.save}</button>
                </div>
              </form>
            </div>
          ) : null}
          {groupedMaterials.map((group) => (
            <div key={group.poojaType} className="panel compact-panel">
              <p className="eyebrow">{group.poojaType}</p>
              {group.items.map((mat) => (
                <div key={mat.id} className="subcategory-row">
                  <span>{mat.itemName} — {mat.quantity_per_pooja} {mat.itemUnit}</span>
                  {isTrustee ? <button className="mini-button danger" type="button" onClick={() => removeMaterial(mat.id)}>{l.remove}</button> : null}
                </div>
              ))}
            </div>
          ))}
          {groupedMaterials.length === 0 ? <p className="subtle">No material mappings yet. Map pooja types to inventory items above.</p> : null}
        </>
      ) : null}
      {tab === "log" ? (
        logs.map((log) => (
          <article key={log.id} className={`ledger-row ${log.type === "PURCHASE" ? "income" : log.type === "CONSUMPTION" ? "expense" : ""}`}>
            <div>
              <strong>{log.itemName}</strong>
              <p>{log.type} · {log.performedByName} · {log.notes || "-"}</p>
              <small>{log.created_at}</small>
            </div>
            <strong style={{ color: log.quantity > 0 ? "#059669" : "#ef4444" }}>{log.quantity > 0 ? "+" : ""}{log.quantity} {log.itemUnit}</strong>
          </article>
        ))
      ) : null}
      {isFormOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">{l.inventory}</p>
                <h2>{editing ? l.edit : l.addNewItem}</h2>
              </div>
              <button className="text-button" type="button" onClick={() => setIsFormOpen(false)}>{l.close}</button>
            </div>
            <form className="form-stack" onSubmit={submitItem}>
              <label>{l.itemName}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <div className="two-col">
                <label>{l.unit}<select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}><option>PIECE</option><option>KG</option><option>LITRE</option><option>PACKET</option><option>DOZEN</option></select></label>
                <label>{l.category}<select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}><option>POOJA_ITEM</option><option>CLEANING</option><option>DECORATION</option><option>FOOD</option></select></label>
              </div>
              <div className="two-col">
                <label>{l.minStock}<input inputMode="decimal" value={form.minStock} onChange={(e) => setForm({ ...form, minStock: e.target.value })} /></label>
                <label>{l.costPerUnit}<input inputMode="decimal" value={form.costPerUnit} onChange={(e) => setForm({ ...form, costPerUnit: e.target.value })} /></label>
              </div>
              {!editing ? <label>{l.currentStock}<input inputMode="decimal" value={form.currentStock} onChange={(e) => setForm({ ...form, currentStock: e.target.value })} /></label> : null}
              <button className="primary-button">{editing ? l.update : l.save}</button>
            </form>
          </div>
        </div>
      ) : null}
      {purchaseItem ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">{l.purchaseStock}</p>
                <h2>{purchaseItem.name}</h2>
              </div>
              <button className="text-button" type="button" onClick={() => setPurchaseItem(null)}>{l.close}</button>
            </div>
            <form className="form-stack" onSubmit={submitPurchase}>
              <div className="two-col">
                <label>{l.quantity}<input inputMode="decimal" value={purchaseForm.quantity} onChange={(e) => setPurchaseForm({ ...purchaseForm, quantity: e.target.value })} /></label>
                <label>{l.costPerUnit}<input inputMode="decimal" value={purchaseForm.costPerUnit} onChange={(e) => setPurchaseForm({ ...purchaseForm, costPerUnit: e.target.value })} /></label>
              </div>
              <label>{l.notes}<input value={purchaseForm.notes} onChange={(e) => setPurchaseForm({ ...purchaseForm, notes: e.target.value })} /></label>
              <button className="primary-button">{l.purchase}</button>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function EventsView({ session }: { session: Session }) {
  const l = useLabels();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [summary, setSummary] = useState<{ totalTasks: number; doneTasks: number; totalPoojas: number; poojaRevenue: number; totalExpenses: number; balance: number } | null>(null);
  const [eventMonth, setEventMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"summary" | "tasks" | "poojas" | "expenses">("summary");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ name: "", eventDate: "", endDate: "", description: "", budget: "", status: "PLANNED", recurrence: "NONE" });
  const [taskForm, setTaskForm] = useState({ title: "", assignedTo: "", dueDate: "", notes: "" });
  const [poojaForm, setPoojaForm] = useState({ poojaType: "", scheduledDate: "", amount: "", devoteeName: "", createBooking: true });
  const [expenseForm, setExpenseForm] = useState({ description: "", amount: "", transactionDate: new Date().toISOString().slice(0, 10), paymentMode: "CASH" });
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  const isTrustee = session.user.role === "TRUSTEE" || session.user.role === "SUPER_TRUSTEE";

  const loadEvents = () => fetchEvents(eventMonth).then(setEvents).catch(console.error);
  useEffect(() => { void loadEvents(); }, [eventMonth]);
  useEffect(() => { if (isTrustee) fetchAdminUsers().then(setUsers).catch(console.error); }, []);

  const loadDetail = (id: number) => {
    setSelectedId(id);
    setDetailTab("summary");
    fetchEventDetail(id).then(setDetail).catch(console.error);
    fetchEventSummary(id).then((s) => setSummary({ totalTasks: s.totalTasks, doneTasks: s.doneTasks, totalPoojas: s.totalPoojas, poojaRevenue: s.poojaRevenue, totalExpenses: s.totalExpenses, balance: s.balance })).catch(console.error);
  };

  function openAdd() {
    setForm({ name: "", eventDate: "", endDate: "", description: "", budget: "", status: "PLANNED", recurrence: "NONE" });
    setIsFormOpen(true);
  }

  async function submitEvent(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      await createEvent({ ...form, budget: Number(form.budget || 0) });
      setIsFormOpen(false);
      loadEvents();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save"); }
  }

  async function removeEvent(id: number) {
    if (!window.confirm("Remove this event?")) return;
    await deleteEvent(id);
    setSelectedId(null);
    setDetail(null);
    loadEvents();
  }

  async function submitTask(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    setMessage("");
    try {
      await createEventTask(selectedId, { ...taskForm, assignedTo: Number(taskForm.assignedTo || 0) });
      setTaskForm({ title: "", assignedTo: "", dueDate: "", notes: "" });
      loadDetail(selectedId);
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save"); }
  }

  async function toggleTask(taskId: number, currentStatus: string) {
    if (!selectedId) return;
    const next = currentStatus === "DONE" ? "PENDING" : "DONE";
    await updateEventTask(selectedId, taskId, { status: next });
    loadDetail(selectedId);
  }

  async function submitPooja(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    setMessage("");
    try {
      await createEventPooja(selectedId, { ...poojaForm, amount: Number(poojaForm.amount || 0), createBooking: poojaForm.createBooking });
      setPoojaForm({ poojaType: "", scheduledDate: "", amount: "", devoteeName: "", createBooking: true });
      loadDetail(selectedId);
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save"); }
  }

  async function submitExpense(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    setMessage("");
    try {
      const result = await createEventExpense(selectedId, { ...expenseForm, amount: Number(expenseForm.amount || 0) });
      setExpenseForm({ description: "", amount: "", transactionDate: new Date().toISOString().slice(0, 10), paymentMode: "CASH" });
      if (result.transactionStatus === "PENDING_APPROVAL") setMessage("Expense saved. Sent for trustee approval.");
      loadDetail(selectedId);
    } catch (err) { setMessage(err instanceof Error ? err.message : "Unable to save"); }
  }

  const pct = summary && summary.totalTasks > 0 ? Math.round((summary.doneTasks / summary.totalTasks) * 100) : 0;

  if (selectedId && detail) {
    return (
      <section className="content-stack">
        <div className="section-title">
          <div>
            <p className="eyebrow">{l.events}</p>
            <h2>{detail.event.name}</h2>
          </div>
          <div className="button-row" style={{ marginTop: 0 }}>
            {isTrustee ? <button className="mini-button danger" type="button" onClick={() => removeEvent(detail.event.id)}>{l.remove}</button> : null}
            <button className="text-button" type="button" onClick={() => { setSelectedId(null); setDetail(null); }}>← Back</button>
          </div>
        </div>
        <div className="detail-tabs">
          <button className={detailTab === "summary" ? "active" : ""} onClick={() => setDetailTab("summary")}>{l.eventSummary}</button>
          <button className={detailTab === "tasks" ? "active" : ""} onClick={() => setDetailTab("tasks")}>{l.tasks} ({summary?.doneTasks ?? 0}/{summary?.totalTasks ?? 0})</button>
          <button className={detailTab === "poojas" ? "active" : ""} onClick={() => setDetailTab("poojas")}>{l.eventPoojas}</button>
          <button className={detailTab === "expenses" ? "active" : ""} onClick={() => setDetailTab("expenses")}>{l.eventExpenses}</button>
        </div>
        {message ? <p className="notice">{message}</p> : null}
        {detailTab === "summary" && summary ? (
          <div className="summary-grid">
            <div className="summary-stat"><span>{l.budget}</span><strong>{formatCurrency(detail.event.budget)}</strong></div>
            <div className="summary-stat"><span>{l.actualCost}</span><strong>{formatCurrency(summary.totalExpenses)}</strong></div>
            <div className="summary-stat"><span>{l.totalTasks}</span><strong>{summary.doneTasks}/{summary.totalTasks} ({pct}%)</strong></div>
            <div className="summary-stat"><span>{l.eventBalance}</span><strong style={{ color: summary.balance >= 0 ? "#059669" : "#ef4444" }}>{formatCurrency(summary.balance)}</strong></div>
            <div className="summary-stat" style={{ gridColumn: "1 / -1" }}>
              <span>{l.taskProgress}</span>
              <div className="progress-bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
            </div>
          </div>
        ) : null}
        {detailTab === "tasks" ? (
          <>
            {isTrustee ? (
              <div className="panel compact-panel">
                <form className="form-stack" onSubmit={submitTask}>
                  <label>{l.taskTitle}<input value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })} /></label>
                  <div className="two-col">
                    <label>{l.assignTo}<select value={taskForm.assignedTo} onChange={(e) => setTaskForm({ ...taskForm, assignedTo: e.target.value })}><option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
                    <label>{l.dueDate}<input type="date" value={taskForm.dueDate} onChange={(e) => setTaskForm({ ...taskForm, dueDate: e.target.value })} /></label>
                  </div>
                  <button className="primary-button">{l.addTask}</button>
                </form>
              </div>
            ) : null}
            {detail.tasks.map((task) => (
              <div key={task.id} className={`task-row ${task.status === "DONE" ? "done" : ""}`}>
                <button className={`task-check ${task.status === "DONE" ? "checked" : ""}`} onClick={() => toggleTask(task.id, task.status)}>{task.status === "DONE" ? "✓" : ""}</button>
                <div style={{ flex: 1 }}>
                  <strong>{task.title}</strong>
                  <p className="subtle">{task.assignedToName || "Unassigned"}{task.due_date ? ` · Due: ${task.due_date}` : ""}</p>
                </div>
              </div>
            ))}
            {detail.tasks.length === 0 ? <p className="subtle">No tasks yet.</p> : null}
          </>
        ) : null}
        {detailTab === "poojas" ? (
          <>
            {isTrustee ? (
              <div className="panel compact-panel">
                <form className="form-stack" onSubmit={submitPooja}>
                  <div className="two-col">
                    <label>{l.poojaTypeLabel}<input value={poojaForm.poojaType} onChange={(e) => setPoojaForm({ ...poojaForm, poojaType: e.target.value })} /></label>
                    <label>{l.scheduledDate}<input type="date" value={poojaForm.scheduledDate} onChange={(e) => setPoojaForm({ ...poojaForm, scheduledDate: e.target.value })} /></label>
                  </div>
                  <div className="two-col">
                    <label>{l.amount}<input inputMode="decimal" value={poojaForm.amount} onChange={(e) => setPoojaForm({ ...poojaForm, amount: e.target.value })} /></label>
                    <label>{l.devoteeName}<input value={poojaForm.devoteeName} onChange={(e) => setPoojaForm({ ...poojaForm, devoteeName: e.target.value })} /></label>
                  </div>
                  <button className="primary-button">{l.addEventPooja}</button>
                </form>
              </div>
            ) : null}
            {detail.poojas.map((pj) => (
              <article key={pj.id} className="ledger-row pooja">
                <div>
                  <strong>{pj.pooja_type}</strong>
                  <p>{pj.scheduled_date}{pj.devoteeName ? ` · ${pj.devoteeName}` : ""}</p>
                </div>
                <strong>{formatCurrency(pj.amount)}</strong>
              </article>
            ))}
            {detail.poojas.length === 0 ? <p className="subtle">No poojas linked yet.</p> : null}
          </>
        ) : null}
        {detailTab === "expenses" ? (
          <>
            {isTrustee ? (
              <div className="panel compact-panel">
                <form className="form-stack" onSubmit={submitExpense}>
                  <div className="two-col">
                    <label>{l.description}<input value={expenseForm.description} onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })} /></label>
                    <label>{l.amount}<input inputMode="decimal" value={expenseForm.amount} onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })} /></label>
                  </div>
                  <div className="two-col">
                    <label>{l.date}<input type="date" value={expenseForm.transactionDate} onChange={(e) => setExpenseForm({ ...expenseForm, transactionDate: e.target.value })} /></label>
                    <label>{l.paymentMode}<select value={expenseForm.paymentMode} onChange={(e) => setExpenseForm({ ...expenseForm, paymentMode: e.target.value })}><option>CASH</option><option>UPI</option><option>BANK</option><option>CHEQUE</option></select></label>
                  </div>
                  <button className="primary-button">{l.addEventExpense}</button>
                </form>
              </div>
            ) : null}
            {detail.expenses.map((ex) => (
              <article key={ex.id} className="ledger-row expense">
                <div>
                  <strong>{ex.description || "Event Expense"}</strong>
                  <p>{ex.txnDate || ex.created_at}</p>
                </div>
                <strong>{formatCurrency(ex.amount)}</strong>
              </article>
            ))}
            {detail.expenses.length === 0 ? <p className="subtle">No expenses yet.</p> : null}
          </>
        ) : null}
      </section>
    );
  }

  return (
    <section className="content-stack">
      <div className="section-title">
        <div>
          <p className="eyebrow">{l.events}</p>
          <h2>{l.eventList}</h2>
        </div>
        {isTrustee ? <button className="primary-button" type="button" onClick={openAdd}>{l.addEvent}</button> : null}
      </div>
      <div className="dashboard-filter panel compact-panel">
        <label>{l.poojaMonth}<input type="month" value={eventMonth} onChange={(e) => setEventMonth(e.target.value)} /></label>
      </div>
      {message ? <p className="notice">{message}</p> : null}
      {events.map((ev) => (
        <article key={ev.id} className="event-card" onClick={() => loadDetail(ev.id)} style={{ cursor: "pointer" }}>
          <div className="event-header">
            <div>
              <strong>{ev.name}</strong>
              <p>{ev.event_date}{ev.end_date ? ` — ${ev.end_date}` : ""} · {ev.createdByName}</p>
              <small>{ev.budget > 0 ? `Budget: ${formatCurrency(ev.budget)}` : ""}{ev.totalExpenses ? ` · Spent: ${formatCurrency(ev.totalExpenses)}` : ""}</small>
            </div>
            <span className={`status-badge ${ev.status.toLowerCase()}`}>{ev.status}</span>
          </div>
          {ev.totalTasks ? (
            <div className="progress-bar"><div className="fill" style={{ width: `${Math.round((ev.doneTasks ?? 0) / ev.totalTasks * 100)}%` }} /></div>
          ) : null}
        </article>
      ))}
      {events.length === 0 ? <p className="subtle">No events found for this month.</p> : null}
      {isFormOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">{l.events}</p>
                <h2>{l.addEvent}</h2>
              </div>
              <button className="text-button" type="button" onClick={() => setIsFormOpen(false)}>{l.close}</button>
            </div>
            <form className="form-stack" onSubmit={submitEvent}>
              <label>{l.eventName}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <div className="two-col">
                <label>{l.eventDate}<input type="date" value={form.eventDate} onChange={(e) => setForm({ ...form, eventDate: e.target.value })} /></label>
                <label>{l.endDate}<input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></label>
              </div>
              <label>{l.eventDescription}<textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
              <div className="two-col">
                <label>{l.budget}<input inputMode="decimal" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} /></label>
                <label>{l.recurrence}<select value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value })}><option value="NONE">{l.none}</option><option value="YEARLY">{l.yearly}</option></select></label>
              </div>
              <button className="primary-button">{l.addEvent}</button>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function AdminView({ session, onSettingsChange }: { session: Session; onSettingsChange: (settings: Partial<TempleSettings>) => void }) {
  const l = useLabels();
  const isSuper = session.user.role === "SUPER_TRUSTEE";
  const [tab, setTab] = useState<"settings" | "users" | "categories" | "temples">("settings");

  return (
    <section className="content-stack">
      <div className="section-title">
        <div>
          <p className="eyebrow">{l.admin}</p>
          <h2>{l.templeSettings}</h2>
        </div>
      </div>
      <div className={isSuper ? "admin-tabs four" : "admin-tabs"}>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>{l.settings}</button>
        <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>{l.users}</button>
        <button className={tab === "categories" ? "active" : ""} onClick={() => setTab("categories")}>{l.categories}</button>
        {isSuper ? <button className={tab === "temples" ? "active" : ""} onClick={() => setTab("temples")}>{l.temples}</button> : null}
      </div>
      {tab === "settings" ? <SettingsTab onSettingsChange={onSettingsChange} /> : null}
      {tab === "users" ? <UsersTab session={session} /> : null}
      {tab === "categories" ? <CategoriesTab /> : null}
      {tab === "temples" ? <TemplesTab /> : null}
    </section>
  );
}

function TemplesTab() {
  const l = useLabels();
  const [rows, setRows] = useState<AdminTemple[]>([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<{ slug: string; name: string; adminUser: { email: string } } | null>(null);
  const [form, setForm] = useState({
    name: "",
    slug: "",
    address: "",
    approvalThreshold: "2000",
    defaultLanguage: "en",
    currency: "INR",
    adminName: "",
    adminEmail: "",
    adminPassword: "",
  });

  const load = () => fetchAdminTemples()
    .then(setRows)
    .catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load temples"));

  useEffect(() => {
    void load();
  }, []);

  function openForm() {
    setCreated(null);
    setMessage("");
    setForm({ name: "", slug: "", address: "", approvalThreshold: "2000", defaultLanguage: "en", currency: "INR", adminName: "", adminEmail: "", adminPassword: "" });
    setIsFormOpen(true);
  }

  function closeForm() {
    setIsFormOpen(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      const saved = await createAdminTemple({
        name: form.name,
        slug: form.slug,
        address: form.address,
        approvalThreshold: Number(form.approvalThreshold || 2000),
        defaultLanguage: form.defaultLanguage,
        currency: form.currency,
        adminName: form.adminName,
        adminEmail: form.adminEmail,
        adminPassword: form.adminPassword,
      });
      setIsFormOpen(false);
      setCreated(saved);
      setMessage(`${l.templeCreated} ${saved.slug}`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to create temple");
    }
  }

  const origin = window.location.origin;

  return (
    <div className="content-stack">
      <div className="section-title">
        <h2>{l.temples}</h2>
        <button className="primary-button" type="button" onClick={openForm}>{l.addTemple}</button>
      </div>
      {message ? <p className="notice">{message}</p> : null}
      {created ? (
        <div className="panel compact-panel">
          <p className="eyebrow">{l.templeCreated}</p>
          <p className="notice">{created.name}</p>
          <p className="subtle">{l.logOutAndOpen}</p>
          <p>
            <a className="text-button" href={`/${created.slug}`}>{origin}/{created.slug} {l.open}</a>
          </p>
          <small>Admin: {created.adminUser.email}</small>
        </div>
      ) : null}
      {rows.map((temple) => (
        <article key={temple.id} className="ledger-row">
          <div>
            <strong>{temple.name}</strong>
            <p>/{temple.slug} · {temple.defaultLanguage === "kn" ? l.kannada : l.english}</p>
            <small>{temple.active ? l.activeBadge : l.inactiveBadge}</small>
          </div>
          <a className="text-button" href={`/${temple.slug}`}>{l.open}</a>
        </article>
      ))}
      {rows.length === 0 && !message ? <p className="subtle">No temples yet.</p> : null}
      {isFormOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">{l.admin}</p>
                <h2>{l.addTemple}</h2>
              </div>
              <button className="text-button" type="button" onClick={closeForm}>{l.close}</button>
            </div>
            <form className="form-stack" onSubmit={submit}>
              <label>{l.templeName}<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label>{l.templeSlug}<input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} placeholder="temple-slug" /></label>
              <p className="subtle">{l.slugHint}</p>
              <label>{l.address}<input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label>
              <div className="two-col">
                <label>{l.approvalThreshold}<input inputMode="decimal" value={form.approvalThreshold} onChange={(event) => setForm({ ...form, approvalThreshold: event.target.value })} /></label>
                <label>{l.defaultLanguage}<select value={form.defaultLanguage} onChange={(event) => setForm({ ...form, defaultLanguage: event.target.value })}><option value="en">{l.english}</option><option value="kn">{l.kannada}</option></select></label>
              </div>
              <label>{l.currency}<select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}><option value="INR">{l.indianRupee}</option><option value="GBP">{l.britishPound}</option><option value="USD">{l.usDollar}</option></select></label>
              <div className="section-title">
                <h2>{l.admin}</h2>
              </div>
              <label>{l.adminName}<input value={form.adminName} onChange={(event) => setForm({ ...form, adminName: event.target.value })} /></label>
              <label>{l.adminEmail}<input type="email" value={form.adminEmail} onChange={(event) => setForm({ ...form, adminEmail: event.target.value })} /></label>
              <label>{l.adminPassword}<input type="password" value={form.adminPassword} onChange={(event) => setForm({ ...form, adminPassword: event.target.value })} /></label>
              {form.adminPassword && form.adminPassword.length < 8 ? <p className="error">Password must be at least 8 characters</p> : null}
              <button className="primary-button">{l.createTemple}</button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SettingsTab({ onSettingsChange }: { onSettingsChange: (settings: Partial<TempleSettings>) => void }) {
  const l = useLabels();
  const [form, setForm] = useState({ name: "", address: "", logoUrl: "", approvalThreshold: "", defaultLanguage: "en", currency: "INR" });
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetchTemplePublic()
      .then((temple) => setForm({
        name: temple.name,
        address: temple.address ?? "",
        logoUrl: temple.logoUrl ?? "",
        approvalThreshold: String(temple.approvalThreshold),
        defaultLanguage: temple.defaultLanguage || "en",
        currency: temple.currency || "INR",
      }))
      .catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load temple settings"));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      const saved = await updateTemple({
        name: form.name,
        address: form.address,
        logoUrl: form.logoUrl,
        approvalThreshold: Number(form.approvalThreshold || 0),
        defaultLanguage: form.defaultLanguage,
        currency: form.currency,
      });
      onSettingsChange(saved);
      setMessage("Temple settings saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save temple settings");
    }
  }

  return (
    <form className="panel form-stack" onSubmit={submit}>
      <label>{l.templeName}<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label>{l.address}<input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label>
      <label>{l.logoUrl}<input value={form.logoUrl} onChange={(event) => setForm({ ...form, logoUrl: event.target.value })} /></label>
      <div className="two-col">
        <label>{l.approvalThreshold}<input inputMode="decimal" value={form.approvalThreshold} onChange={(event) => setForm({ ...form, approvalThreshold: event.target.value })} /></label>
        <label>{l.defaultLanguage}<select value={form.defaultLanguage} onChange={(event) => setForm({ ...form, defaultLanguage: event.target.value })}><option value="en">{l.english}</option><option value="kn">{l.kannada}</option></select></label>
      </div>
      <label>{l.currency}<select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}><option value="INR">{l.indianRupee}</option><option value="GBP">{l.britishPound}</option><option value="USD">{l.usDollar}</option></select></label>
      {message ? <p className="notice">{message}</p> : null}
      <button className="primary-button">{l.saveChanges}</button>
    </form>
  );
}

function UsersTab({ session }: { session: Session }) {
  const l = useLabels();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ name: "", email: "", phone: "", role: "MANAGER", password: "" });
  const isSuper = session.user.role === "SUPER_TRUSTEE";

  const load = () => fetchAdminUsers()
    .then(setRows)
    .catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load users"));

  useEffect(() => {
    void load();
  }, []);

  function openAdd() {
    setEditing(null);
    setForm({ name: "", email: "", phone: "", role: "MANAGER", password: "" });
    setIsFormOpen(true);
  }

  function openEdit(user: UserRow) {
    setEditing(user);
    setForm({ name: user.name, email: user.email, phone: user.phone ?? "", role: user.role, password: "" });
    setIsFormOpen(true);
  }

  function closeForm() {
    setIsFormOpen(false);
    setEditing(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      if (editing) {
        await updateAdminUser(editing.id, { ...form, active: editing.active });
      } else {
        await createAdminUser(form);
      }
      setIsFormOpen(false);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save user");
    }
  }

  async function toggleActive(user: UserRow) {
    setMessage("");
    try {
      await updateAdminUser(user.id, { active: user.active ? 0 : 1 });
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to update user");
    }
  }

  return (
    <div className="content-stack">
      <div className="section-title">
        <h2>{l.users}</h2>
        <button className="primary-button" type="button" onClick={openAdd}>{l.addUser}</button>
      </div>
      {message ? <p className="notice">{message}</p> : null}
      {rows.map((user) => (
        <article key={user.id} className="ledger-row">
          <div>
            <strong>{user.name}</strong>
            <p>{user.email}{user.phone ? ` · ${user.phone}` : ""}</p>
            <small>{user.role.replaceAll("_", " ")} · {user.active ? l.activeBadge : l.inactiveBadge}</small>
            <div className="row-actions">
              {user.id === session.user.id ? (
                <span className="locked-note">{l.you}</span>
              ) : (
                <>
                  <button className="mini-button" type="button" onClick={() => openEdit(user)}>{l.edit}</button>
                  <button className="mini-button danger" type="button" onClick={() => toggleActive(user)}>{user.active ? l.inactiveBadge : l.activeBadge}</button>
                </>
              )}
            </div>
          </div>
        </article>
      ))}
      {rows.length === 0 && !message ? <p className="subtle">No users yet.</p> : null}
      {isFormOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">{l.admin}</p>
                <h2>{editing ? l.editUser : l.addUser}</h2>
              </div>
              <button className="text-button" type="button" onClick={closeForm}>{l.close}</button>
            </div>
            <form className="form-stack" onSubmit={submit}>
              <label>{l.name}<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label>{l.email}<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} disabled={Boolean(editing)} /></label>
              <label>{l.mobile}<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
              <label>{l.role}<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>{isSuper ? <option>SUPER_TRUSTEE</option> : null}<option>TRUSTEE</option><option>MANAGER</option></select></label>
              <label>{l.resetPassword}<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
              {!editing && form.password && form.password.length < 8 ? <p className="error">Password must be at least 8 characters</p> : null}
              <button className="primary-button">{editing ? l.update : l.save}</button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CategoriesTab() {
  const l = useLabels();
  const [rows, setRows] = useState<CategoryRow[]>([]);
  const [filterType, setFilterType] = useState<TransactionType>("INCOME");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<CategoryRow | null>(null);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ type: "INCOME" as TransactionType, name: "", parentId: "", sortOrder: "" });

  const load = () => fetchAdminCategories()
    .then(setRows)
    .catch((err) => setMessage(err instanceof Error ? err.message : "Unable to load categories"));

  useEffect(() => {
    void load();
  }, []);

  const typed = rows.filter((row) => row.type === filterType);
  const parents = typed.filter((row) => !row.parentId);

  function openAddMain() {
    setEditing(null);
    setForm({ type: filterType, name: "", parentId: "", sortOrder: "" });
    setIsFormOpen(true);
  }

  function openAddSub(parent: CategoryRow) {
    setEditing(null);
    setForm({ type: parent.type, name: "", parentId: String(parent.id), sortOrder: "" });
    setIsFormOpen(true);
  }

  function openEdit(row: CategoryRow) {
    setEditing(row);
    setForm({ type: row.type, name: row.name, parentId: String(row.parentId ?? ""), sortOrder: String(row.sortOrder ?? "") });
    setIsFormOpen(true);
  }

  function closeForm() {
    setIsFormOpen(false);
    setEditing(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      if (editing) {
        await updateAdminCategory(editing.id, { name: form.name, sortOrder: Number(form.sortOrder || 0), active: editing.active });
      } else {
        await createAdminCategory({ type: form.type, name: form.name, parentId: form.parentId ? Number(form.parentId) : "", sortOrder: Number(form.sortOrder || 0) });
      }
      setIsFormOpen(false);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save category");
    }
  }

  async function toggleActive(row: CategoryRow) {
    setMessage("");
    try {
      await updateAdminCategory(row.id, { active: row.active ? 0 : 1 });
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to update category");
    }
  }

  return (
    <div className="content-stack">
      <div className="section-title">
        <h2>{l.categories}</h2>
        <button className="primary-button" type="button" onClick={openAddMain}>{l.addMainCategory}</button>
      </div>
      <div className="ledger-filters panel compact-panel">
        <label>{l.type}<select value={filterType} onChange={(event) => setFilterType(event.target.value as TransactionType)}><option>INCOME</option><option>EXPENSE</option></select></label>
      </div>
      {message ? <p className="notice">{message}</p> : null}
      {parents.map((parent) => (
        <article key={parent.id} className="ledger-row">
          <div>
            <strong>{parent.name} <span className={`badge ${parent.active ? "" : "inactive"}`}>{parent.active ? l.activeBadge : l.inactiveBadge}</span></strong>
            <div className="row-actions">
              <button className="mini-button" type="button" onClick={() => openAddSub(parent)}>{l.addSubCategory}</button>
              <button className="mini-button" type="button" onClick={() => openEdit(parent)}>{l.edit}</button>
              <button className="mini-button danger" type="button" onClick={() => toggleActive(parent)}>{parent.active ? l.inactiveBadge : l.activeBadge}</button>
            </div>
            <div className="subcategory-list">
              {typed.filter((row) => row.parentId === parent.id).map((child) => (
                <div key={child.id} className="subcategory-row">
                  <span>{child.name}</span>
                  <div className="row-actions">
                    <button className="mini-button" type="button" onClick={() => openEdit(child)}>{l.edit}</button>
                    <button className="mini-button danger" type="button" onClick={() => toggleActive(child)}>{child.active ? l.inactiveBadge : l.activeBadge}</button>
                  </div>
                </div>
              ))}
              {typed.filter((row) => row.parentId === parent.id).length === 0 ? <p className="subtle">No subcategories.</p> : null}
            </div>
          </div>
        </article>
      ))}
      {parents.length === 0 && !message ? <p className="subtle">No categories yet.</p> : null}
      {isFormOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">{l.admin}</p>
                <h2>{editing ? l.edit : l.addCategory}</h2>
              </div>
              <button className="text-button" type="button" onClick={closeForm}>{l.close}</button>
            </div>
            <form className="form-stack" onSubmit={submit}>
              <label>{l.type}<select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as TransactionType, parentId: "" })}><option>INCOME</option><option>EXPENSE</option></select></label>
              {editing ? null : (
                <label>{l.parentCategory}<select value={form.parentId} onChange={(event) => setForm({ ...form, parentId: event.target.value })}><option value="">{l.none}</option>{rows.filter((row) => row.type === form.type && !row.parentId).map((parent) => <option key={parent.id} value={parent.id}>{parent.name}</option>)}</select></label>
              )}
              <label>{l.name}<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label>{l.sortOrder}<input inputMode="numeric" value={form.sortOrder} onChange={(event) => setForm({ ...form, sortOrder: event.target.value })} placeholder="0" /></label>
              <button className="primary-button">{editing ? l.update : l.save}</button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
