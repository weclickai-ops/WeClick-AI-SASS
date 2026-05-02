const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'weclick.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company TEXT NOT NULL,
    email TEXT,
    status TEXT DEFAULT 'Active',
    revenue REAL DEFAULT 0,
    spend REAL DEFAULT 0,
    profit REAL DEFAULT 0,
    expected_revenue REAL DEFAULT 0,
    color TEXT DEFAULT '#FF6A00',
    avatar_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    budget REAL DEFAULT 0,
    spend REAL DEFAULT 0,
    status TEXT DEFAULT 'Draft',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS automations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'Running',
    notes TEXT,
    revenue REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS collaborations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner TEXT NOT NULL,
    revenue REAL DEFAULT 0,
    status TEXT DEFAULT 'Active',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS revenue_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    source TEXT DEFAULT 'manual',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    role TEXT DEFAULT 'member',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('income','expense')),
    category TEXT DEFAULT 'Other',
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS salaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS client_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_size TEXT,
    file_type TEXT DEFAULT 'report',
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS meta_spend (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_name TEXT,
    spend REAL DEFAULT 0,
    date TEXT,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS quotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    quotation_no TEXT,
    items TEXT NOT NULL,
    subtotal REAL DEFAULT 0,
    gst_pct REAL DEFAULT 18,
    gst_amount REAL DEFAULT 0,
    total REAL DEFAULT 0,
    notes TEXT,
    valid_until TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS content_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    platform TEXT NOT NULL,
    content_type TEXT NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS client_meta_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
    ad_account_id TEXT NOT NULL,
    access_token TEXT NOT NULL,
    daily_budget REAL DEFAULT 0,
    total_funds REAL DEFAULT 0,
    alert_threshold REAL DEFAULT 500,
    balance REAL DEFAULT NULL,
    currency TEXT DEFAULT 'INR',
    balance_synced_at DATETIME,
    is_active INTEGER DEFAULT 1,
    last_synced DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS client_meta_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    spend REAL DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    ctr REAL DEFAULT 0,
    cpc REAL DEFAULT 0,
    reach INTEGER DEFAULT 0,
    leads INTEGER DEFAULT 0,
    roas REAL DEFAULT 0,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_id, date)
  );
`);

// ── MIGRATIONS ────────────────────────────────────────────────
try {
  const cols = db.prepare("PRAGMA table_info(clients)").all().map(c => c.name);
  if (!cols.includes('avatar_url')) db.exec("ALTER TABLE clients ADD COLUMN avatar_url TEXT");
  if (!cols.includes('email')) db.exec("ALTER TABLE clients ADD COLUMN email TEXT");
} catch (e) { console.error('Client migration:', e.message); }

try {
  const mc = db.prepare("PRAGMA table_info(client_meta_accounts)").all().map(c => c.name);
  if (!mc.includes('total_funds')) db.exec("ALTER TABLE client_meta_accounts ADD COLUMN total_funds REAL DEFAULT 0");
  if (!mc.includes('alert_threshold')) db.exec("ALTER TABLE client_meta_accounts ADD COLUMN alert_threshold REAL DEFAULT 500");
  if (!mc.includes('balance')) db.exec("ALTER TABLE client_meta_accounts ADD COLUMN balance REAL DEFAULT NULL");
  if (!mc.includes('currency')) db.exec("ALTER TABLE client_meta_accounts ADD COLUMN currency TEXT DEFAULT 'INR'");
  if (!mc.includes('balance_synced_at')) db.exec("ALTER TABLE client_meta_accounts ADD COLUMN balance_synced_at DATETIME");
} catch (e) { console.error('Meta migration:', e.message); }

// ── SEED (only if empty) ──────────────────────────────────────
const clientCount = db.prepare('SELECT COUNT(*) as count FROM clients').get();
if (clientCount.count === 0) {
  try {
    const u1 = db.prepare('INSERT INTO users (name,email,role) VALUES (?,?,?)').run('Arjun Kapoor','arjun@weclick.ai','owner');
    const u2 = db.prepare('INSERT INTO users (name,email,role) VALUES (?,?,?)').run('Siya Verma','siya@weclick.ai','manager');
    const u3 = db.prepare('INSERT INTO users (name,email,role) VALUES (?,?,?)').run('Karan Singh','karan@weclick.ai','analyst');

    const ic = db.prepare('INSERT INTO clients (name,company,email,status,revenue,spend,profit,expected_revenue,color) VALUES (?,?,?,?,?,?,?,?,?)');
    const c1 = ic.run('Priya Sharma','Growfast Retail','priya@growfast.in','Active',316400,89000,227400,380000,'#FF6A00');
    const c2 = ic.run('Ravi Mehta','TechNova Labs','ravi@technova.in','Active',245000,72000,173000,290000,'#3B82F6');
    const c3 = ic.run('Ananya Iyer','StyleHive','ananya@stylehive.in','Active',198500,58000,140500,210000,'#10B981');
    const c4 = ic.run('Suresh Kumar','FoodBox India','suresh@foodbox.in','Paused',145000,51000,94000,160000,'#8B5CF6');
    const c5 = ic.run('Neha Gupta','EduSpark','neha@eduspark.in','Active',82000,38000,44000,95000,'#F59E0B');

    const icamp = db.prepare('INSERT INTO campaigns (name,client_id,channel,budget,spend,status) VALUES (?,?,?,?,?,?)');
    icamp.run('Diwali Mega Sale',c1.lastInsertRowid,'Meta Ads',120000,89000,'Active');
    icamp.run('Product Launch Q2',c2.lastInsertRowid,'Google Ads',80000,72000,'Active');
    icamp.run('Brand Awareness',c3.lastInsertRowid,'Instagram',60000,42000,'Active');
    icamp.run('Summer Campaign',c4.lastInsertRowid,'Meta Ads',55000,51000,'Paused');
    icamp.run('Admission Drive',c5.lastInsertRowid,'LinkedIn',40000,28000,'Draft');

    const ia = db.prepare('INSERT INTO automations (name,client_id,status,notes,revenue) VALUES (?,?,?,?,?)');
    ia.run('Lead Follow-up Bot',c1.lastInsertRowid,'Running','WhatsApp + Email sequence',28000);
    ia.run('Retargeting Flow',c2.lastInsertRowid,'Running','7-day cart abandon',22000);
    ia.run('Review Collector',c3.lastInsertRowid,'Paused','Post-purchase review ask',15000);
    ia.run('Appointment Bot',c5.lastInsertRowid,'Running','Demo booking automation',18000);

    const ico = db.prepare('INSERT INTO collaborations (partner,revenue,status,notes) VALUES (?,?,?,?)');
    ico.run('Digital Nest Agency',95000,'Active','White-label campaigns');
    ico.run('Spark Creative Studio',68000,'Active','Content production');
    ico.run('GrowthHackers Co.',42000,'Ended','SEO project Q1');

    const ir = db.prepare('INSERT INTO revenue_entries (client_id,amount,date,source,notes) VALUES (?,?,?,?,?)');
    ir.run(c1.lastInsertRowid,50000,'2025-04-10','manual','Strategy consulting');
    ir.run(c3.lastInsertRowid,35000,'2025-04-18','manual','Monthly retainer');

    const it = db.prepare('INSERT INTO transactions (user_id,type,category,amount,date) VALUES (?,?,?,?,?)');
    it.run(u1.lastInsertRowid,'income','Salary',85000,'2025-04-01');
    it.run(u1.lastInsertRowid,'expense','Software',12000,'2025-04-05');
    it.run(u2.lastInsertRowid,'income','Bonus',30000,'2025-04-08');
    it.run(u1.lastInsertRowid,'expense','Travel',8500,'2025-04-12');
    it.run(u2.lastInsertRowid,'expense','Equipment',22000,'2025-04-15');

    const is = db.prepare('INSERT INTO salaries (user_id,amount,date,notes) VALUES (?,?,?,?)');
    is.run(u1.lastInsertRowid,85000,'2025-04-01','April salary');
    is.run(u2.lastInsertRowid,65000,'2025-04-01','April salary');
    is.run(u3.lastInsertRowid,55000,'2025-04-01','April salary');

    console.log('✅ Database seeded');
  } catch (err) {
    console.error('❌ Seed failed:', err);
  }
}

module.exports = db;
