export type Role = "MANAGER" | "TRUSTEE" | "SUPER_TRUSTEE";
export type TransactionType = "INCOME" | "EXPENSE";

export type Session = {
  token: string;
  user: { id: number; name: string; email: string; role: Role };
  temple: { id: number; slug: string; name: string; approvalThreshold: number; defaultLanguage: string };
};

export type Category = {
  id: number;
  type: TransactionType;
  name: string;
  parentId?: number | null;
  children?: Category[];
};

export type DashboardSummary = {
  todayIncome: number;
  todayExpense: number;
  monthIncome: number;
  monthExpense: number;
  balance: number;
  pendingApprovals: number;
  todayPoojas: number;
  monthPoojas: number;
  todayPoojaBookings: PoojaBooking[];
  monthPoojaBookings: PoojaBooking[];
};

export type LedgerRow = {
  id: number;
  type: TransactionType;
  category_id?: number | null;
  subcategory_id?: number | null;
  amount: number;
  transaction_date: string;
  payment_mode: string;
  counterparty_name?: string | null;
  notes?: string | null;
  status: string;
  unlocked?: number;
  created_at?: string;
  categoryName?: string | null;
  subcategoryName?: string | null;
  enteredByName: string;
};

export type ApprovalRow = {
  id: number;
  transaction_id: number;
  amount: number;
  transactionDate: string;
  notes?: string | null;
  categoryName?: string | null;
  requestedByName: string;
};

export type PoojaBooking = {
  id: number;
  devotee_name: string;
  mobile?: string | null;
  pooja_type: string;
  occasion: string;
  occasion_date: string;
  amount?: number | null;
  notes?: string | null;
};

export type UserRow = {
  id: number;
  name: string;
  email: string;
  phone?: string | null;
  role: Role;
  active: number;
  created_at?: string;
  updated_at?: string | null;
};

export type CategoryRow = {
  id: number;
  type: TransactionType;
  name: string;
  parentId: number | null;
  active: number;
  sortOrder: number;
};

export type TempleSettings = {
  id: number;
  slug: string;
  name: string;
  address?: string | null;
  logoUrl?: string | null;
  approvalThreshold: number;
  defaultLanguage: string;
  currency: string;
};

export type AdminTemple = {
  id: number;
  slug: string;
  name: string;
  address?: string | null;
  approvalThreshold: number;
  defaultLanguage: string;
  currency: string;
  active: number;
};

const storageKey = "temple-seva-ledger-session";

export function getTempleSlug() {
  const first = window.location.pathname.split("/").filter(Boolean)[0];
  return first || "hanumagiri";
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null) {
  if (!session) {
    localStorage.removeItem(storageKey);
    return;
  }
  localStorage.setItem(storageKey, JSON.stringify(session));
}

async function request<T>(path: string, options: RequestInit = {}) {
  const session = loadSession();
  const response = await fetch(`/api/${getTempleSlug()}${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...options.headers
    }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Request failed" }));
    if (response.status === 401) {
      saveSession(null);
      window.location.reload();
    }
    throw new Error(error.message || "Request failed");
  }
  const payload = await response.json();
  return payload.data as T;
}

export function fetchTemplePublic() {
  return request<{ slug: string; name: string; address?: string; logoUrl?: string; approvalThreshold: number; defaultLanguage: string; currency: string }>("/public");
}

export function login(email: string, password: string) {
  return request<Session>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export function fetchDashboard() {
  return request<DashboardSummary>("/dashboard");
}

export function fetchDashboardForMonth(month: string) {
  return request<DashboardSummary>(`/dashboard?month=${encodeURIComponent(month)}`);
}

export function fetchCategories() {
  return request<{ income: Category[]; expense: Category[] }>("/categories");
}

export function fetchTransactions() {
  return request<LedgerRow[]>("/transactions");
}

export function createTransaction(formData: FormData) {
  return request<{ id: number; status: string }>("/transactions", {
    method: "POST",
    body: formData
  });
}

export function unlockTransaction(id: number) {
  return request<{ id: number; unlocked: boolean }>(`/transactions/${id}/unlock`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function updateTransaction(id: number, payload: Record<string, string | number>) {
  return request<{ id: number }>(`/transactions/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function deleteTransaction(id: number) {
  return request<{ id: number }>(`/transactions/${id}`, {
    method: "DELETE"
  });
}

export function fetchApprovals() {
  return request<ApprovalRow[]>("/approvals");
}

export function decideApproval(id: number, decision: "APPROVED" | "REJECTED", comments?: string) {
  return request<{ status: string }>(`/approvals/${id}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, comments })
  });
}

export function fetchPoojaBookings() {
  return request<PoojaBooking[]>("/pooja-bookings");
}

export function createPoojaBooking(payload: Record<string, string | number>) {
  return request<{ id: number }>("/pooja-bookings", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updatePoojaBooking(id: number, payload: Record<string, string | number>) {
  return request<{ id: number }>(`/pooja-bookings/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function deletePoojaBooking(id: number) {
  return request<{ id: number }>(`/pooja-bookings/${id}`, {
    method: "DELETE"
  });
}

export function fetchAdminUsers() {
  return request<UserRow[]>("/admin/users");
}

export function createAdminUser(payload: Record<string, string | number>) {
  return request<UserRow>("/admin/users", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateAdminUser(id: number, payload: Record<string, string | number>) {
  return request<UserRow>(`/admin/users/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function fetchAdminCategories() {
  return request<CategoryRow[]>("/admin/categories");
}

export function createAdminCategory(payload: Record<string, string | number>) {
  return request<CategoryRow>("/admin/categories", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateAdminCategory(id: number, payload: Record<string, string | number>) {
  return request<CategoryRow>(`/admin/categories/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function updateTemple(payload: Record<string, string | number>) {
  return request<TempleSettings>("/temple", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function fetchAdminTemples() {
  return request<AdminTemple[]>("/admin/temples");
}

export function createAdminTemple(payload: Record<string, string | number>) {
  return request<{ id: number; slug: string; name: string; adminUser: { id: number; name: string; email: string } }>("/admin/temples", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
