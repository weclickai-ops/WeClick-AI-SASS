# WeClick AI — Marketing Agency Dashboard

A single-page marketing-agency management dashboard. Tracks clients, campaigns, automations, collaborations, revenue, team finance, content calendars, and quotations. Indian agency context (₹ INR, GST, lakh formatting).

## Stack
- **Backend**: Node.js + Express, served on port `5000` (set `PORT` env var to override)
- **Database**: SQLite via `better-sqlite3` (file: `weclick.db`, WAL mode)
- **Frontend**: Single `public/index.html` — vanilla JS SPA, DM Sans, custom CSS
- **File uploads**: `multer`, stored under `uploads/<clientId>/`

## Entry points
- `server.js` — all routes are defined inline here (the `routes/` folder is legacy/unused; it targets Postgres and is not mounted)
- `database.js` — schema (CREATE IF NOT EXISTS) + idempotent seed (wrapped in try/catch)
- `db.js` — legacy pg pool (not used by the running server)

## Run
- Workflow `Start application` runs `PORT=5000 node server.js`
- Restart after changes via the workflow restart tool

## Design system
- Primary: `#FF6A00` (orange)
- Font: DM Sans
- Cards: white surface, 1px `#E5E5E5` border, 10px radius
- Currency formatter: `fmt(n)` returns `₹X,XX,XXX` (Indian grouping)

## Key features (current)
1. Dashboard: stat cards + smooth area/line revenue chart with **client filter dropdown** (defaults to "All Clients"), 30D/90D toggle, animated gradient fill, hover tooltips on data points
2. Clients CRUD + per-client detail page with files, campaigns, **quotations**, **content calendar**, and **send report**
3. Quotation builder: line items (service/desc/qty/rate), GST %, validity date, auto-calc subtotal/GST/total in INR, branded preview modal, **PDF download via `window.print()`** (print-only CSS hides everything except `#print-area`)
4. Monthly content calendar per client: clickable days, tasks with platform (Instagram/Meta/LinkedIn/YouTube) + content type (Reel/Post/Story/Ad), colored dots per platform, month navigation
5. Send Report: per-client modal with pre-filled subject/body, posts to `/api/clients/:id/send-report` (currently a stub that logs and toasts success — wire SMTP later)
9. Client photo/avatar: clickable avatar circle in client header opens a file picker (JPG/PNG/WEBP, max 2MB). Photo is uploaded to `/uploads/clients/:id/avatar.<ext>` and the URL is stored in `clients.avatar_url`. Camera icon overlay indicates clickability. Client list rows and dashboard top-clients show the real photo when present, otherwise fall back to colored initials.
6. Campaigns, Automations, Collaborations CRUD
7. Revenue hub: company finance + personal/team finance tabs, manual revenue entries, transactions, salaries
8. Meta Ads sync (mock data into `meta_spend`)

## API surface (selected new endpoints)
- `GET/POST /api/clients/:id/quotations`
- `DELETE /api/clients/:cid/quotations/:id`
- `GET/POST /api/clients/:id/content-tasks`
- `DELETE /api/clients/:cid/content-tasks/:id`
- `POST /api/clients/:id/send-report` (stub)

## Notes / gotchas
- SQLite treats double-quoted strings as identifiers; always use single quotes for string literals in SQL.
- `.replit` cannot be edited directly by the agent — port mappings are managed via tools. Port 5000 is already exposed.
- The chart uses a deterministic seeded series derived from each client's totals (no real time-series table yet) so visualizations are stable across reloads.
