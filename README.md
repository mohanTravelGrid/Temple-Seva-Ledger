# Temple Seva Ledger

Mobile-first web application for temple income, expenses, approvals, reports, and annual pooja reminders.

## Stack

- React + Vite
- Node.js + Express
- SQLite via Node's built-in `node:sqlite`

## Local Start

```bash
npm install
npm run dev:server
```

In another terminal:

```bash
npm run dev:web
```

Default tenant:

```text
http://localhost:5173/hanumagiri
```

Seed users:

```text
manager@hanumagiri.org / Temple123#
trustee@hanumagiri.org / Temple123#
super@hanumagiri.org / Temple123#
```

## Version 1 Scope

- Multi-tenant base using `templeId`
- Roles: Manager, Trustee, Super Trustee
- Income and expense entry
- Approval queue for larger expenses
- Ledger and dashboard summaries
- Pooja calendar for birthdays, anniversaries, and annual sevas
