# WeClick AI — Internal Dashboard

## 🚀 Deploy on Replit (Step by Step)

### Step 1 — Import to Replit
1. Go to **https://replit.com**
2. Click **Create Repl** → **Import from GitHub** OR click **Upload folder**
3. Upload the entire `weclick-ai` folder (zip it first)

### Step 2 — Install Dependencies
In the Replit **Shell** tab, run:
```
npm install
```

### Step 3 — Run
Click the **Run** button (green ▶️) at the top.
Replit will start the server and open a preview window.

### Step 4 — Done ✅
The dashboard opens automatically. All data is seeded on first run.

---

## 📁 Project Structure
```
weclick-ai/
├── server.js          ← Express API (all routes)
├── database.js        ← SQLite schema + seed data
├── package.json       ← Dependencies
├── .replit            ← Replit config (auto-detected)
├── replit.nix         ← Node.js environment
├── public/
│   └── index.html     ← Complete SPA frontend
└── uploads/           ← Client files (auto-created)
```

## 🔑 API Routes
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/dashboard | Dashboard stats |
| GET/POST | /api/clients | List / Add clients |
| GET/PUT/DELETE | /api/clients/:id | Client detail / edit / delete |
| GET/POST | /api/campaigns | Campaigns |
| GET/POST | /api/automations | Automations |
| GET/POST | /api/collaborations | Collaborations |
| GET/POST | /api/revenue | Revenue entries |
| GET/POST | /api/finance/personal | Personal + team finance |
| GET/POST | /api/transactions | Transactions |
| GET/POST | /api/salaries | Salaries |
| POST | /api/clients/:id/files | Upload file (multer) |
| DELETE | /api/clients/:id/files/:fid | Delete file |
| POST | /api/meta/sync | Mock Meta Ads sync |

## 💰 Currency
All amounts in INR ₹ with Indian number formatting (₹3,16,400)

## 🗄️ Database
SQLite via better-sqlite3. File: `weclick.db` (auto-created).
No setup required — tables + seed data created on first run.
