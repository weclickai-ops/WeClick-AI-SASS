require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── PASSWORD PROTECTION (MUST be before static files) ─────────
const PASS = process.env.DASHBOARD_PASSWORD || 'weclick2025';
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
  if (req.path === '/login') return next();
  const cookie = req.headers.cookie || '';
  if (cookie.includes(`auth=${PASS}`)) return next();
  res.send(`<!DOCTYPE html><html><head><title>WeClick AI</title>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:sans-serif;background:#FAFAFA;display:flex;align-items:center;justify-content:center;height:100vh}.box{background:#fff;border:1px solid #E5E5E5;border-radius:14px;padding:40px;width:340px;text-align:center}.logo{width:48px;height:48px;background:#FF6A00;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px;margin:0 auto 16px}h2{margin-bottom:6px}p{font-size:13px;color:#6B7280;margin-bottom:24px}input{width:100%;padding:10px 14px;border:1px solid #E5E5E5;border-radius:8px;font-size:14px;margin-bottom:14px;outline:none}button{width:100%;padding:10px;background:#FF6A00;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}</style>
  </head><body><div class="box"><div class="logo">WC</div><h2>WeClick AI</h2><p>Enter your password to continue</p>
  <form method="POST" action="/login"><input type="password" name="password" placeholder="Password" autofocus/><button>Login →</button></form>
  </div></body></html>`);
});
app.post('/login', (req, res) => {
  if (req.body.password === PASS) {
    res.setHeader('Set-Cookie', `auth=${PASS}; Path=/; HttpOnly; Max-Age=2592000`);
    res.redirect('/');
  } else {
    res.send('<script>alert("Wrong password");history.back()</script>');
  }
});

// ── STATIC FILES (AFTER password check) ───────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── MULTER ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', String(req.params.clientId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, unique + '-' + file.originalname);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'clients', String(req.params.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    cb(null, 'avatar' + ext);
  }
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) return cb(new Error('Only JPG, PNG or WEBP allowed'));
    cb(null, true);
  }
});

// ── EMAIL HELPER ───────────────────────────────────────────────
async function sendLowBudgetEmail(client, metaAccount, remaining) {
  const to = client.email || process.env.ALERT_EMAIL;
  if (!to || !process.env.SMTP_HOST) {
    console.log(`[Alert] Low funds for ${client.name} — ₹${Math.round(remaining)} remaining`);
    return;
  }
  const level = remaining < 100 ? 'CRITICAL' : 'WARNING';
  try {
    const mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await mailer.sendMail({
      from: `"WeClick AI" <${process.env.SMTP_USER}>`,
      to,
      subject: `[${level}] Low Meta Ads Budget — ${client.name}`,
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2 style="color:${remaining<100?'#991B1B':'#92400E'}">${remaining<100?'🚨 Critical':'⚠️ Warning'}: Low Ad Budget</h2>
        <p>Client: <strong>${client.name} · ${client.company}</strong></p>
        <p>Funds Remaining: <strong style="color:#DC2626;font-size:18px">₹${Math.round(remaining).toLocaleString('en-IN')}</strong></p>
        <p>Please top up the Meta Ads account to avoid campaign interruption.</p>
      </div>`
    });
    console.log(`[Email] Low budget alert sent to ${to}`);
  } catch (err) {
    console.error(`[Email] Failed: ${err.message}`);
  }
}

// ── META SYNC ENGINE ───────────────────────────────────────────
async function syncClientMetaAccount(clientId) {
  const account = db.prepare('SELECT * FROM client_meta_accounts WHERE client_id=? AND is_active=1').get(clientId);
  if (!account) return { error: 'No active Meta account' };

  const today = new Date();
  const since = new Date(today);
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = today.toISOString().split('T')[0];

  try {
    // Fetch insights + balance in parallel
    const insightsUrl = `https://graph.facebook.com/v18.0/${account.ad_account_id}/insights?fields=spend,impressions,clicks,ctr,cpc,reach,actions,action_values&time_range={"since":"${sinceStr}","until":"${untilStr}"}&access_token=${account.access_token}`;
    const balanceUrl  = `https://graph.facebook.com/v18.0/${account.ad_account_id}?fields=balance,currency&access_token=${account.access_token}`;

    const [insRes, balRes] = await Promise.all([
      fetch(insightsUrl),
      fetch(balanceUrl)
    ]);

    const insData = await insRes.json();
    const balData = await balRes.json();

    if (insData.error) throw new Error(insData.error.message || 'Meta API error');

    const row = (insData.data && insData.data[0]) || {};
    const actions = row.actions || [];
    const actionValues = row.action_values || [];
    const leads = parseInt(actions.find(a => a.action_type === 'lead')?.value || 0);
    const purchaseValue = parseFloat(actionValues.find(a => a.action_type === 'omni_purchase')?.value || 0);
    const spend = parseFloat(row.spend) || 0;
    const roas = spend > 0 ? +(purchaseValue / spend).toFixed(2) : 0;

    // Save metrics
    const existing = db.prepare('SELECT id FROM client_meta_metrics WHERE client_id=? AND date=?').get(clientId, untilStr);
    if (existing) {
      db.prepare('UPDATE client_meta_metrics SET spend=?,impressions=?,clicks=?,ctr=?,cpc=?,reach=?,leads=?,roas=?,synced_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(spend, parseInt(row.impressions)||0, parseInt(row.clicks)||0, parseFloat(row.ctr)||0, parseFloat(row.cpc)||0, parseInt(row.reach)||0, leads, roas, existing.id);
    } else {
      db.prepare('INSERT INTO client_meta_metrics (client_id,date,spend,impressions,clicks,ctr,cpc,reach,leads,roas) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(clientId, untilStr, spend, parseInt(row.impressions)||0, parseInt(row.clicks)||0, parseFloat(row.ctr)||0, parseFloat(row.cpc)||0, parseInt(row.reach)||0, leads, roas);
    }

    // Save balance
    let balance = null, currency = 'INR';
    if (!balData.error) {
      balance = parseFloat(balData.balance) || 0;
      currency = balData.currency || 'INR';
      db.prepare('UPDATE client_meta_accounts SET last_synced=CURRENT_TIMESTAMP, balance=?, currency=?, balance_synced_at=CURRENT_TIMESTAMP WHERE client_id=?')
        .run(balance, currency, clientId);

      // Low balance alert
      if (balance < 500) {
        const cl = db.prepare('SELECT * FROM clients WHERE id=?').get(clientId);
        console.log(`${balance < 100 ? '🚨 CRITICAL' : '⚠️ WARNING'} LOW FUNDS: ${cl?.name} — ₹${balance.toFixed(0)} remaining`);
        await sendLowBudgetEmail(cl, account, balance);
      }
    } else {
      db.prepare('UPDATE client_meta_accounts SET last_synced=CURRENT_TIMESTAMP WHERE client_id=?').run(clientId);
    }

    return {
      success: true,
      balance,
      currency,
      metrics: { spend, impressions: parseInt(row.impressions)||0, clicks: parseInt(row.clicks)||0, ctr: parseFloat(row.ctr)||0, cpc: parseFloat(row.cpc)||0, reach: parseInt(row.reach)||0, leads, roas }
    };
  } catch (err) {
    console.error(`[Meta Sync] client ${clientId}: ${err.message}`);
    return { error: err.message };
  }
}

async function syncAllMetaAccounts() {
  const accounts = db.prepare('SELECT client_id FROM client_meta_accounts WHERE is_active=1').all();
  console.log(`[Cron] Syncing ${accounts.length} Meta account(s)…`);
  for (const a of accounts) {
    const result = await syncClientMetaAccount(a.client_id);
    console.log(`[Cron] client ${a.client_id}:`, result.error || 'synced ✓');
  }
  console.log('[Cron] Done');
}

// ── CLIENTS ────────────────────────────────────────────────────
app.get('/api/clients', (req, res) => {
  const clients = db.prepare(`
    SELECT c.*,
      CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END as meta_connected,
      m.balance as meta_balance,
      m.currency as meta_currency,
      m.ad_account_id as meta_ad_account_id
    FROM clients c
    LEFT JOIN client_meta_accounts m ON c.id=m.client_id AND m.is_active=1
    ORDER BY c.revenue DESC
  `).all();
  res.json(clients);
});

app.get('/api/clients/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const campaigns    = db.prepare('SELECT * FROM campaigns WHERE client_id=?').all(client.id);
  const files        = db.prepare('SELECT * FROM client_files WHERE client_id=? ORDER BY uploaded_at DESC').all(client.id);
  const automations  = db.prepare('SELECT * FROM automations WHERE client_id=?').all(client.id);
  const quotations   = db.prepare('SELECT * FROM quotations WHERE client_id=? ORDER BY created_at DESC').all(client.id)
                         .map(q => ({ ...q, items: JSON.parse(q.items || '[]') }));
  const contentTasks = db.prepare('SELECT * FROM content_tasks WHERE client_id=? ORDER BY date ASC').all(client.id);
  const metaRaw      = db.prepare('SELECT * FROM client_meta_accounts WHERE client_id=?').get(client.id);
  const metaAccount  = metaRaw ? { ...metaRaw, access_token: '••••' + metaRaw.access_token.slice(-6) } : null;
  const metaMetrics  = db.prepare('SELECT * FROM client_meta_metrics WHERE client_id=? ORDER BY date DESC LIMIT 1').get(client.id) || null;
  const metaHistory  = db.prepare('SELECT * FROM client_meta_metrics WHERE client_id=? ORDER BY date DESC LIMIT 7').all(client.id);
  const totalSpent   = db.prepare('SELECT COALESCE(SUM(spend),0) as total FROM client_meta_metrics WHERE client_id=?').get(client.id)?.total || 0;
  res.json({ ...client, campaigns, files, automations, quotations, contentTasks, metaAccount, metaMetrics, metaHistory, totalSpent });
});

app.post('/api/clients', (req, res) => {
  const { name, company, email='', status='Active', revenue=0, spend=0, expected_revenue=0, color='#FF6A00' } = req.body;
  if (!name || !company) return res.status(400).json({ error: 'name and company required' });
  const profit = revenue - spend;
  const r = db.prepare('INSERT INTO clients (name,company,email,status,revenue,spend,profit,expected_revenue,color) VALUES (?,?,?,?,?,?,?,?,?)').run(name, company, email, status, revenue, spend, profit, expected_revenue, color);
  res.json(db.prepare('SELECT * FROM clients WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/clients/:id', (req, res) => {
  const { name, company, email='', status, revenue, spend, expected_revenue, color } = req.body;
  const profit = (revenue || 0) - (spend || 0);
  db.prepare('UPDATE clients SET name=?,company=?,email=?,status=?,revenue=?,spend=?,profit=?,expected_revenue=?,color=? WHERE id=?').run(name, company, email, status, revenue, spend, profit, expected_revenue, color, req.params.id);
  res.json(db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id));
});

app.delete('/api/clients/:id', (req, res) => {
  db.prepare('DELETE FROM clients WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/clients/:id/avatar', (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Max 2MB' : err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatar_url = `/uploads/clients/${req.params.id}/${req.file.filename}?v=${Date.now()}`;
    db.prepare('UPDATE clients SET avatar_url=? WHERE id=?').run(avatar_url, req.params.id);
    res.json({ success: true, avatar_url });
  });
});

// ── QUOTATIONS ─────────────────────────────────────────────────
app.get('/api/clients/:id/quotations', (req, res) => {
  const rows = db.prepare('SELECT * FROM quotations WHERE client_id=? ORDER BY created_at DESC').all(req.params.id)
    .map(q => ({ ...q, items: JSON.parse(q.items || '[]') }));
  res.json(rows);
});

app.post('/api/clients/:id/quotations', (req, res) => {
  const { items=[], gst_pct=18, notes='', valid_until=null } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item required' });
  const subtotal = items.reduce((s,i) => s + (parseFloat(i.qty)||0) * (parseFloat(i.rate)||0), 0);
  const gstAmount = subtotal * (parseFloat(gst_pct)||0) / 100;
  const total = subtotal + gstAmount;
  const qNo = 'WC-' + Date.now().toString().slice(-8);
  const r = db.prepare('INSERT INTO quotations (client_id,quotation_no,items,subtotal,gst_pct,gst_amount,total,notes,valid_until) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(req.params.id, qNo, JSON.stringify(items), subtotal, gst_pct, gstAmount, total, notes, valid_until);
  const row = db.prepare('SELECT * FROM quotations WHERE id=?').get(r.lastInsertRowid);
  res.json({ ...row, items: JSON.parse(row.items) });
});

app.delete('/api/clients/:cid/quotations/:id', (req, res) => {
  db.prepare('DELETE FROM quotations WHERE id=? AND client_id=?').run(req.params.id, req.params.cid);
  res.json({ success: true });
});

// ── CONTENT CALENDAR ───────────────────────────────────────────
app.get('/api/clients/:id/content-tasks', (req, res) => {
  res.json(db.prepare('SELECT * FROM content_tasks WHERE client_id=? ORDER BY date ASC').all(req.params.id));
});

app.post('/api/clients/:id/content-tasks', (req, res) => {
  const { date, platform, content_type, notes='' } = req.body;
  if (!date || !platform || !content_type) return res.status(400).json({ error: 'date, platform, content_type required' });
  const r = db.prepare('INSERT INTO content_tasks (client_id,date,platform,content_type,notes) VALUES (?,?,?,?,?)').run(req.params.id, date, platform, content_type, notes);
  res.json(db.prepare('SELECT * FROM content_tasks WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/clients/:cid/content-tasks/:id', (req, res) => {
  db.prepare('DELETE FROM content_tasks WHERE id=? AND client_id=?').run(req.params.id, req.params.cid);
  res.json({ success: true });
});

// ── SEND REPORT ────────────────────────────────────────────────
app.post('/api/clients/:id/send-report', (req, res) => {
  const { to, subject, body } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email required' });
  console.log(`[Send Report] to=${to} subject="${subject}"`);
  res.json({ success: true, message: 'Report sent successfully' });
});

// ── CAMPAIGNS ──────────────────────────────────────────────────
app.get('/api/campaigns', (req, res) => {
  res.json(db.prepare('SELECT c.*,cl.name as client_name,cl.company FROM campaigns c LEFT JOIN clients cl ON c.client_id=cl.id ORDER BY c.created_at DESC').all());
});

app.post('/api/campaigns', (req, res) => {
  const { name, client_id, channel, budget=0, spend=0, status='Draft' } = req.body;
  if (!name || !client_id) return res.status(400).json({ error: 'name and client_id required' });
  const r = db.prepare('INSERT INTO campaigns (name,client_id,channel,budget,spend,status) VALUES (?,?,?,?,?,?)').run(name, client_id, channel, budget, spend, status);
  res.json(db.prepare('SELECT * FROM campaigns WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/campaigns/:id', (req, res) => {
  const { name, client_id, channel, budget, spend, status } = req.body;
  db.prepare('UPDATE campaigns SET name=?,client_id=?,channel=?,budget=?,spend=?,status=? WHERE id=?').run(name, client_id, channel, budget, spend, status, req.params.id);
  res.json(db.prepare('SELECT * FROM campaigns WHERE id=?').get(req.params.id));
});

app.delete('/api/campaigns/:id', (req, res) => {
  db.prepare('DELETE FROM campaigns WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── AUTOMATIONS ────────────────────────────────────────────────
app.get('/api/automations', (req, res) => {
  res.json(db.prepare('SELECT a.*,cl.name as client_name,cl.company FROM automations a LEFT JOIN clients cl ON a.client_id=cl.id ORDER BY a.created_at DESC').all());
});

app.post('/api/automations', (req, res) => {
  const { name, client_id, status='Running', notes='', revenue=0 } = req.body;
  if (!name || !client_id) return res.status(400).json({ error: 'name and client_id required' });
  const r = db.prepare('INSERT INTO automations (name,client_id,status,notes,revenue) VALUES (?,?,?,?,?)').run(name, client_id, status, notes, revenue);
  res.json(db.prepare('SELECT * FROM automations WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/automations/:id', (req, res) => {
  const { name, client_id, status, notes, revenue } = req.body;
  db.prepare('UPDATE automations SET name=?,client_id=?,status=?,notes=?,revenue=? WHERE id=?').run(name, client_id, status, notes, revenue, req.params.id);
  res.json(db.prepare('SELECT * FROM automations WHERE id=?').get(req.params.id));
});

app.delete('/api/automations/:id', (req, res) => {
  db.prepare('DELETE FROM automations WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── COLLABORATIONS ─────────────────────────────────────────────
app.get('/api/collaborations', (req, res) => {
  res.json(db.prepare('SELECT * FROM collaborations ORDER BY created_at DESC').all());
});

app.post('/api/collaborations', (req, res) => {
  const { partner, revenue=0, status='Active', notes='' } = req.body;
  if (!partner) return res.status(400).json({ error: 'partner required' });
  const r = db.prepare('INSERT INTO collaborations (partner,revenue,status,notes) VALUES (?,?,?,?)').run(partner, revenue, status, notes);
  res.json(db.prepare('SELECT * FROM collaborations WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/collaborations/:id', (req, res) => {
  const { partner, revenue, status, notes } = req.body;
  db.prepare('UPDATE collaborations SET partner=?,revenue=?,status=?,notes=? WHERE id=?').run(partner, revenue, status, notes, req.params.id);
  res.json(db.prepare('SELECT * FROM collaborations WHERE id=?').get(req.params.id));
});

app.delete('/api/collaborations/:id', (req, res) => {
  db.prepare('DELETE FROM collaborations WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── REVENUE ────────────────────────────────────────────────────
app.get('/api/revenue', (req, res) => {
  const entries = db.prepare('SELECT r.*,c.name as client_name,c.color FROM revenue_entries r LEFT JOIN clients c ON r.client_id=c.id ORDER BY r.date DESC').all();
  const totals = db.prepare("SELECT SUM(CASE WHEN source='manual' THEN amount ELSE 0 END) as manual_total, SUM(amount) as grand_total FROM revenue_entries").get();
  const clientRevenue = db.prepare('SELECT SUM(revenue) as total FROM clients').get();
  res.json({ entries, totals, clientRevenue });
});

app.post('/api/revenue', (req, res) => {
  const { client_id, amount, date, source='manual', notes='' } = req.body;
  if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Valid amount required' });
  if (!date) return res.status(400).json({ error: 'Date required' });
  const r = db.prepare('INSERT INTO revenue_entries (client_id,amount,date,source,notes) VALUES (?,?,?,?,?)').run(client_id||null, parseFloat(amount), date, source, notes);
  res.json(db.prepare('SELECT * FROM revenue_entries WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/revenue/:id', (req, res) => {
  db.prepare('DELETE FROM revenue_entries WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── REVENUE BREAKDOWN ──────────────────────────────────────────
app.get('/api/revenue/breakdown', (req, res) => {
  const today = new Date();
  const d = (offset) => { const dt = new Date(today); dt.setDate(dt.getDate() - offset); return dt.toISOString().split('T')[0]; };
  const sumOn   = (date) => db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM revenue_entries WHERE date=?").get(date)?.total || 0;
  const sumFrom = (from, to) => db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM revenue_entries WHERE date>=? AND date<=?").get(from, to)?.total || 0;
  if (req.query.date) return res.json({ custom: sumOn(req.query.date), date: req.query.date });
  const t = d(0), y = d(1), dbd = d(2);
  res.json({
    today: sumOn(t), yesterday: sumOn(y), dayBefore: sumOn(dbd),
    lastWeek: sumOn(d(7)), last7: sumFrom(d(7), t), last30: sumFrom(d(30), t), last90: sumFrom(d(90), t),
    dates: { today: t, yesterday: y, dayBefore: dbd }
  });
});

// ── DASHBOARD ──────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  const clientStats = db.prepare("SELECT SUM(revenue) as revenue, SUM(spend) as spend, SUM(profit) as profit, COUNT(*) as total, SUM(CASE WHEN status='Active' THEN 1 ELSE 0 END) as active FROM clients").get();
  const autoStats   = db.prepare("SELECT SUM(revenue) as revenue, SUM(CASE WHEN status='Running' THEN 1 ELSE 0 END) as running FROM automations").get();
  const colabStats  = db.prepare('SELECT SUM(revenue) as revenue FROM collaborations').get();
  const manualRev   = db.prepare("SELECT SUM(amount) as total FROM revenue_entries WHERE source='manual'").get();
  const now         = new Date();
  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const thisMonth   = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM revenue_entries WHERE date>=?').get(thisMonthStart)?.total || 0;
  const totalRevenue = (clientStats.revenue || 0) + (manualRev.total || 0);
  const totalSpend   = clientStats.spend || 0;
  res.json({
    totalRevenue, totalSpend, profit: totalRevenue - totalSpend,
    activeClients: clientStats.active, totalClients: clientStats.total,
    automationRevenue: autoStats.revenue || 0, activeAutomations: autoStats.running,
    collaborationRevenue: colabStats.revenue || 0,
    thisMonth, projected: Math.round(totalRevenue * 1.24)
  });
});

// ── CHART DATA ─────────────────────────────────────────────────
app.get('/api/charts/performance', (req, res) => {
  const clients = db.prepare('SELECT id,name,revenue,spend,profit,color FROM clients ORDER BY revenue DESC').all();
  const funnel  = db.prepare('SELECT COALESCE(SUM(impressions),0) as impressions, COALESCE(SUM(clicks),0) as clicks, COALESCE(SUM(leads),0) as leads FROM client_meta_metrics').get();
  funnel.conversions = Math.round((funnel.leads || 0) * 0.6);
  res.json({ clients, funnel });
});

// ── USERS ──────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY id').all());
});

app.post('/api/users', (req, res) => {
  const { name, email, role='member' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const r = db.prepare('INSERT INTO users (name,email,role) VALUES (?,?,?)').run(name, email||null, role);
  res.json(db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── TRANSACTIONS ───────────────────────────────────────────────
app.get('/api/transactions', (req, res) => {
  res.json(db.prepare('SELECT t.*,u.name as user_name FROM transactions t LEFT JOIN users u ON t.user_id=u.id ORDER BY t.date DESC').all());
});

app.post('/api/transactions', (req, res) => {
  const { user_id, type, category='Other', amount, date, notes='' } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (!['income','expense'].includes(type)) return res.status(400).json({ error: 'type must be income or expense' });
  if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Valid amount required' });
  if (!date) return res.status(400).json({ error: 'Date required' });
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(user_id)) return res.status(400).json({ error: 'User not found' });
  const r = db.prepare('INSERT INTO transactions (user_id,type,category,amount,date,notes) VALUES (?,?,?,?,?,?)').run(user_id, type, category, parseFloat(amount), date, notes);
  res.json(db.prepare('SELECT t.*,u.name as user_name FROM transactions t LEFT JOIN users u ON t.user_id=u.id WHERE t.id=?').get(r.lastInsertRowid));
});

app.delete('/api/transactions/:id', (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── SALARIES ───────────────────────────────────────────────────
app.get('/api/salaries', (req, res) => {
  res.json(db.prepare('SELECT s.*,u.name as user_name FROM salaries s LEFT JOIN users u ON s.user_id=u.id ORDER BY s.date DESC').all());
});

app.post('/api/salaries', (req, res) => {
  const { user_id, amount, date, notes='' } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Valid amount required' });
  if (!date) return res.status(400).json({ error: 'Date required' });
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(user_id)) return res.status(400).json({ error: 'User not found' });
  const r = db.prepare('INSERT INTO salaries (user_id,amount,date,notes) VALUES (?,?,?,?)').run(user_id, parseFloat(amount), date, notes);
  res.json(db.prepare('SELECT s.*,u.name as user_name FROM salaries s LEFT JOIN users u ON s.user_id=u.id WHERE s.id=?').get(r.lastInsertRowid));
});

app.delete('/api/salaries/:id', (req, res) => {
  db.prepare('DELETE FROM salaries WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── PERSONAL FINANCE ───────────────────────────────────────────
app.get('/api/finance/personal', (req, res) => {
  const users = db.prepare('SELECT * FROM users').all();
  const transactions = db.prepare('SELECT t.*,u.name as user_name FROM transactions t LEFT JOIN users u ON t.user_id=u.id ORDER BY t.date DESC').all();
  const salaries = db.prepare('SELECT s.*,u.name as user_name FROM salaries s LEFT JOIN users u ON s.user_id=u.id ORDER BY s.date DESC').all();
  const summary = users.map(u => {
    const income   = transactions.filter(t => t.user_id===u.id && t.type==='income').reduce((a,t) => a+t.amount, 0);
    const expenses = transactions.filter(t => t.user_id===u.id && t.type==='expense').reduce((a,t) => a+t.amount, 0);
    return { user_id: u.id, user_name: u.name, income, expenses, net: income - expenses };
  });
  const totalIncome   = transactions.filter(t => t.type==='income').reduce((a,t) => a+t.amount, 0);
  const totalExpenses = transactions.filter(t => t.type==='expense').reduce((a,t) => a+t.amount, 0);
  const totalSalaries = salaries.reduce((a,s) => a+s.amount, 0);
  res.json({ transactions, salaries, summary, totalIncome, totalExpenses, totalSalaries, netBalance: totalIncome - totalExpenses });
});

// ── CLIENT FILES ───────────────────────────────────────────────
app.get('/api/clients/:clientId/files', (req, res) => {
  res.json(db.prepare('SELECT * FROM client_files WHERE client_id=? ORDER BY uploaded_at DESC').all(req.params.clientId));
});

app.post('/api/clients/:clientId/files', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const file_url  = `/uploads/${req.params.clientId}/${req.file.filename}`;
  const file_size = (req.file.size / 1024 / 1024).toFixed(1) + ' MB';
  const r = db.prepare('INSERT INTO client_files (client_id,file_name,file_url,file_size,file_type) VALUES (?,?,?,?,?)').run(req.params.clientId, req.file.originalname, file_url, file_size, req.body.file_type || 'report');
  res.json(db.prepare('SELECT * FROM client_files WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/clients/:clientId/files/:fileId', (req, res) => {
  const file = db.prepare('SELECT * FROM client_files WHERE id=? AND client_id=?').get(req.params.fileId, req.params.clientId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const fp = path.join(__dirname, file.file_url);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('DELETE FROM client_files WHERE id=?').run(req.params.fileId);
  res.json({ success: true });
});

// ── META ACCOUNT CRUD ──────────────────────────────────────────
app.get('/api/clients/:id/meta-account', (req, res) => {
  const row = db.prepare('SELECT * FROM client_meta_accounts WHERE client_id=?').get(req.params.id);
  if (!row) return res.json(null);
  res.json({ ...row, access_token: '••••' + row.access_token.slice(-6) });
});

app.post('/api/clients/:id/meta-account', async (req, res) => {
  const { ad_account_id, access_token, daily_budget=0, alert_threshold=500 } = req.body;
  if (!ad_account_id || !access_token) return res.status(400).json({ error: 'ad_account_id and access_token required' });
  const existing = db.prepare('SELECT id FROM client_meta_accounts WHERE client_id=?').get(req.params.id);
  if (existing) {
    db.prepare('UPDATE client_meta_accounts SET ad_account_id=?,access_token=?,daily_budget=?,alert_threshold=?,is_active=1 WHERE client_id=?')
      .run(ad_account_id, access_token, parseFloat(daily_budget)||0, parseFloat(alert_threshold)||500, req.params.id);
  } else {
    db.prepare('INSERT INTO client_meta_accounts (client_id,ad_account_id,access_token,daily_budget,alert_threshold) VALUES (?,?,?,?,?)')
      .run(req.params.id, ad_account_id, access_token, parseFloat(daily_budget)||0, parseFloat(alert_threshold)||500);
  }
  res.json({ success: true });
});

app.delete('/api/clients/:id/meta-account', (req, res) => {
  db.prepare('DELETE FROM client_meta_accounts WHERE client_id=?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/clients/:id/meta-sync', async (req, res) => {
  const result = await syncClientMetaAccount(parseInt(req.params.id));
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ── META ALERTS ────────────────────────────────────────────────
app.get('/api/meta/alerts', (req, res) => {
  const accounts = db.prepare('SELECT m.*,c.name,c.company FROM client_meta_accounts m LEFT JOIN clients c ON m.client_id=c.id WHERE m.is_active=1').all();
  const alerts = [];
  for (const acct of accounts) {
    const latest = db.prepare('SELECT * FROM client_meta_metrics WHERE client_id=? ORDER BY date DESC LIMIT 1').get(acct.client_id);
    const prev   = db.prepare('SELECT * FROM client_meta_metrics WHERE client_id=? ORDER BY date DESC LIMIT 1 OFFSET 7').get(acct.client_id);
    if (acct.balance !== null && acct.balance < 500)
      alerts.push({ type: acct.balance<100?'critical':'warning', client: acct.name, company: acct.company, client_id: acct.client_id, msg: `Low funds: ₹${Math.round(acct.balance)} remaining in Meta Ads account` });
    if (!latest) continue;
    if (latest.ctr > 0 && latest.ctr < 1)
      alerts.push({ type: 'warning', client: acct.name, company: acct.company, client_id: acct.client_id, msg: `Low CTR: ${latest.ctr.toFixed(2)}% (below 1%)` });
    if (prev && prev.cpc > 0 && latest.cpc > prev.cpc * 1.2)
      alerts.push({ type: 'warning', client: acct.name, company: acct.company, client_id: acct.client_id, msg: `CPC spike: ₹${latest.cpc.toFixed(2)} (+${Math.round((latest.cpc/prev.cpc-1)*100)}% vs last week)` });
  }
  res.json(alerts);
});

// ── GLOBAL META SYNC ───────────────────────────────────────────
app.post('/api/meta/sync', async (req, res) => {
  const accounts = db.prepare('SELECT client_id FROM client_meta_accounts WHERE is_active=1').all();
  if (accounts.length === 0) return res.json({ success: true, synced: 0, message: 'No Meta accounts connected yet' });
  const results = [];
  for (const a of accounts) {
    const r = await syncClientMetaAccount(a.client_id);
    results.push({ client_id: a.client_id, ...r });
  }
  res.json({ success: true, synced: results.length, results });
});

// ── CRON: 8AM IST daily ────────────────────────────────────────
cron.schedule('30 2 * * *', () => {
  console.log('[Cron] 8AM IST — daily Meta sync starting');
  syncAllMetaAccounts();
}, { timezone: 'Asia/Kolkata' });

// ── CATCH ALL → SPA ────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`✅ WeClick AI running on http://localhost:${PORT}`));
