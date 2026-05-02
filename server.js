require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { pool, initDb } = require('./database');

// ── EMAIL HELPER ───────────────────────────────────────────────
function createMailer() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
async function sendLowBudgetEmail(client, metaAccount, remaining, spent) {
  const to = client.email || process.env.ALERT_EMAIL;
  const level = remaining <= 100 ? 'CRITICAL' : 'WARNING';
  if (!to) {
    console.log(`[Email] No email configured for ${client.name} — set client email or ALERT_EMAIL env var`);
    return;
  }
  const mailer = createMailer();
  if (!mailer) {
    console.log(`[Email] SMTP not configured — would send ${level} alert to ${to} (₹${remaining.toFixed(0)} remaining)`);
    return;
  }
  try {
    await mailer.sendMail({
      from: `"WeClick AI" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: `[${level}] Low Meta Ads Budget — ${client.name} (${client.company})`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <div style="background:${remaining<=100?'#FEF2F2':'#FFFBEB'};border-radius:8px;padding:24px;margin-bottom:20px">
          <h2 style="margin:0 0 8px;color:${remaining<=100?'#991B1B':'#92400E'}">${remaining<=100?'🚨 Critical':'⚠️ Warning'}: Low Ad Budget</h2>
          <p style="margin:0;color:${remaining<=100?'#B91C1C':'#B45309'}">Your Meta Ads account is running low on funds.</p>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:10px;border-bottom:1px solid #E5E5E5;color:#666">Client</td><td style="padding:10px;border-bottom:1px solid #E5E5E5;font-weight:600">${client.name} · ${client.company}</td></tr>
          <tr><td style="padding:10px;border-bottom:1px solid #E5E5E5;color:#666">Ad Account</td><td style="padding:10px;border-bottom:1px solid #E5E5E5">${metaAccount.ad_account_id}</td></tr>
          <tr><td style="padding:10px;border-bottom:1px solid #E5E5E5;color:#666">Daily Budget</td><td style="padding:10px;border-bottom:1px solid #E5E5E5">₹${(metaAccount.daily_budget||0).toLocaleString('en-IN')}</td></tr>
          <tr><td style="padding:10px;border-bottom:1px solid #E5E5E5;color:#666">Amount Spent</td><td style="padding:10px;border-bottom:1px solid #E5E5E5;color:#FF6A00;font-weight:600">₹${spent.toLocaleString('en-IN')}</td></tr>
          <tr style="background:#FEF2F2"><td style="padding:10px;color:#991B1B;font-weight:700">Remaining</td><td style="padding:10px;color:#991B1B;font-weight:700;font-size:18px">₹${Math.round(remaining).toLocaleString('en-IN')}</td></tr>
        </table>
        <p style="margin:20px 0 0;color:#666;font-size:12px">Please top up your Meta Ads account to avoid campaign interruption.</p>
        <p style="color:#999;font-size:11px">Sent by WeClick AI — Marketing Agency Dashboard</p>
      </div>`
    });
    console.log(`[Email] ✅ Low budget alert sent to ${to}`);
  } catch (err) {
    console.error(`[Email] ❌ Failed to send: ${err.message}`);
  }
}

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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

app.use(express.urlencoded({ extended: false }));

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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
// Multer storage
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

// Avatar storage: /uploads/clients/:id/avatar.<ext>
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
    if (!allowed.includes(file.mimetype)) return cb(new Error('Only JPG, PNG or WEBP images are allowed'));
    cb(null, true);
  }
});

// ── META ADS SYNC ENGINE ──────────────────────────────────────
async function fetchMetaBalance(adAccountId, accessToken) {
  try {
    const url = `https://graph.facebook.com/v18.0/${adAccountId}?fields=balance,currency&access_token=${accessToken}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) { console.warn(`[Meta Balance] ${adAccountId}: ${data.error.message}`); return null; }
    return { balance: parseFloat(data.balance) || 0, currency: data.currency || 'INR' };
  } catch (err) {
    console.warn(`[Meta Balance] fetch failed: ${err.message}`);
    return null;
  }
}

async function syncClientMetaAccount(clientId) {
  const { rows: acctRows } = await pool.query('SELECT * FROM client_meta_accounts WHERE client_id=$1 AND is_active=1', [clientId]);
  const account = acctRows[0];
  if (!account) return { error: 'No active Meta account' };

  const today = new Date();
  const since = new Date(today);
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = today.toISOString().split('T')[0];

  const url = `https://graph.facebook.com/v18.0/${account.ad_account_id}/insights?fields=spend,impressions,clicks,ctr,cpc,reach,actions,action_values&time_range={"since":"${sinceStr}","until":"${untilStr}"}&access_token=${account.access_token}`;

  try {
    const [response, balanceData] = await Promise.all([
      fetch(url),
      fetchMetaBalance(account.ad_account_id, account.access_token)
    ]);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'Meta API error');

    const row = (data.data && data.data[0]) || {};
    const actions = row.actions || [];
    const actionValues = row.action_values || [];
    const leads = parseInt(actions.find(a => a.action_type === 'lead')?.value || 0);
    const purchaseValue = parseFloat(actionValues.find(a => a.action_type === 'omni_purchase')?.value || 0);
    const spend = parseFloat(row.spend) || 0;
    const roas = spend > 0 ? +(purchaseValue / spend).toFixed(2) : 0;
    const dateStr = untilStr;

    const { rows: existRows } = await pool.query('SELECT id FROM client_meta_metrics WHERE client_id=$1 AND date=$2', [clientId, dateStr]);
    if (existRows[0]) {
      await pool.query(
        'UPDATE client_meta_metrics SET spend=$1,impressions=$2,clicks=$3,ctr=$4,cpc=$5,reach=$6,leads=$7,roas=$8,synced_at=CURRENT_TIMESTAMP WHERE id=$9',
        [spend, parseInt(row.impressions)||0, parseInt(row.clicks)||0, parseFloat(row.ctr)||0, parseFloat(row.cpc)||0, parseInt(row.reach)||0, leads, roas, existRows[0].id]
      );
    } else {
      await pool.query(
        'INSERT INTO client_meta_metrics (client_id,date,spend,impressions,clicks,ctr,cpc,reach,leads,roas) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [clientId, dateStr, spend, parseInt(row.impressions)||0, parseInt(row.clicks)||0, parseFloat(row.ctr)||0, parseFloat(row.cpc)||0, parseInt(row.reach)||0, leads, roas]
      );
    }

    if (balanceData !== null) {
      await pool.query(
        'UPDATE client_meta_accounts SET last_synced=CURRENT_TIMESTAMP,balance=$1,currency=$2,balance_synced_at=CURRENT_TIMESTAMP WHERE client_id=$3',
        [balanceData.balance, balanceData.currency, clientId]
      );
      if (balanceData.balance < 500) {
        const { rows: clRows } = await pool.query('SELECT * FROM clients WHERE id=$1', [clientId]);
        const cl = clRows[0];
        const level = balanceData.balance < 100 ? '🚨 CRITICAL' : '⚠️  WARNING';
        console.log(`${level} LOW FUNDS: ${cl?.name} (${cl?.company}) — ₹${balanceData.balance.toFixed(0)} remaining`);
        await sendLowBudgetEmail(cl, account, balanceData.balance, spend);
      }
    } else {
      await pool.query('UPDATE client_meta_accounts SET last_synced=CURRENT_TIMESTAMP WHERE client_id=$1', [clientId]);
    }

    return {
      success: true,
      balance: balanceData?.balance ?? null,
      currency: balanceData?.currency ?? 'INR',
      metrics: { spend, impressions: parseInt(row.impressions)||0, clicks: parseInt(row.clicks)||0, ctr: parseFloat(row.ctr)||0, cpc: parseFloat(row.cpc)||0, reach: parseInt(row.reach)||0, leads, roas }
    };
  } catch (err) {
    console.error(`[Meta Sync] client ${clientId}: ${err.message}`);
    return { error: err.message };
  }
}

async function syncAllMetaAccounts() {
  const { rows: accounts } = await pool.query('SELECT client_id FROM client_meta_accounts WHERE is_active=1');
  console.log(`[Cron] Syncing ${accounts.length} Meta account(s)…`);
  for (const a of accounts) await syncClientMetaAccount(a.client_id);
  console.log('[Cron] Meta sync complete');
}

// ── CLIENTS ──────────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
        CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END as meta_connected,
        m.balance as meta_balance,
        m.currency as meta_currency,
        m.ad_account_id as meta_ad_account_id
      FROM clients c
      LEFT JOIN client_meta_accounts m ON c.id=m.client_id AND m.is_active=1
      ORDER BY c.revenue DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clients/:id', async (req, res) => {
  try {
    const { rows: cl } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    if (!cl[0]) return res.status(404).json({ error: 'Not found' });
    const client = cl[0];
    const [
      { rows: campaigns },
      { rows: files },
      { rows: automations },
      { rows: quotationRows },
      { rows: contentTasks },
      { rows: metaAcctRows },
      { rows: metaMetricsRows },
      { rows: metaHistory },
      { rows: totalSpentRows }
    ] = await Promise.all([
      pool.query('SELECT * FROM campaigns WHERE client_id=$1', [client.id]),
      pool.query('SELECT * FROM client_files WHERE client_id=$1 ORDER BY uploaded_at DESC', [client.id]),
      pool.query('SELECT * FROM automations WHERE client_id=$1', [client.id]),
      pool.query('SELECT * FROM quotations WHERE client_id=$1 ORDER BY created_at DESC', [client.id]),
      pool.query('SELECT * FROM content_tasks WHERE client_id=$1 ORDER BY date ASC', [client.id]),
      pool.query('SELECT * FROM client_meta_accounts WHERE client_id=$1', [client.id]),
      pool.query('SELECT * FROM client_meta_metrics WHERE client_id=$1 ORDER BY date DESC LIMIT 1', [client.id]),
      pool.query('SELECT * FROM client_meta_metrics WHERE client_id=$1 ORDER BY date DESC LIMIT 7', [client.id]),
      pool.query('SELECT COALESCE(SUM(spend),0) as total FROM client_meta_metrics WHERE client_id=$1', [client.id])
    ]);
    const quotations = quotationRows.map(q => ({ ...q, items: JSON.parse(q.items || '[]') }));
    const metaRaw = metaAcctRows[0] || null;
    const metaAccount = metaRaw ? { ...metaRaw, access_token: '••••' + metaRaw.access_token.slice(-6) } : null;
    const metaMetrics = metaMetricsRows[0] || null;
    const totalSpent = parseFloat(totalSpentRows[0]?.total) || 0;
    res.json({ ...client, campaigns, files, automations, quotations, contentTasks, metaAccount, metaMetrics, metaHistory, totalSpent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients', async (req, res) => {
  try {
    const { name, company, email='', status='Active', revenue=0, spend=0, expected_revenue=0, color='#FF6A00' } = req.body;
    if (!name || !company) return res.status(400).json({ error: 'name and company required' });
    const profit = revenue - spend;
    const { rows } = await pool.query(
      'INSERT INTO clients (name,company,email,status,revenue,spend,profit,expected_revenue,color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [name, company, email, status, revenue, spend, profit, expected_revenue, color]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/clients/:id', async (req, res) => {
  try {
    const { name, company, email='', status, revenue, spend, expected_revenue, color } = req.body;
    const profit = (revenue || 0) - (spend || 0);
    await pool.query(
      'UPDATE clients SET name=$1,company=$2,email=$3,status=$4,revenue=$5,spend=$6,profit=$7,expected_revenue=$8,color=$9 WHERE id=$10',
      [name, company, email, status, revenue, spend, profit, expected_revenue, color, req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM clients WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Avatar upload
app.post('/api/clients/:id/avatar', (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 2MB)' : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const { rows } = await pool.query('SELECT id FROM clients WHERE id=$1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
      const avatar_url = `/uploads/clients/${req.params.id}/${req.file.filename}?v=${Date.now()}`;
      await pool.query('UPDATE clients SET avatar_url=$1 WHERE id=$2', [avatar_url, req.params.id]);
      res.json({ success: true, avatar_url });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// ── QUOTATIONS ────────────────────────────────────────────────
app.get('/api/clients/:id/quotations', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM quotations WHERE client_id=$1 ORDER BY created_at DESC', [req.params.id]);
    res.json(rows.map(q => ({ ...q, items: JSON.parse(q.items || '[]') })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients/:id/quotations', async (req, res) => {
  try {
    const { items=[], gst_pct=18, notes='', valid_until=null } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item required' });
    const subtotal = items.reduce((s,i) => s + (parseFloat(i.qty)||0) * (parseFloat(i.rate)||0), 0);
    const gstAmount = subtotal * (parseFloat(gst_pct)||0) / 100;
    const total = subtotal + gstAmount;
    const qNo = 'WC-' + Date.now().toString().slice(-8);
    const { rows } = await pool.query(
      'INSERT INTO quotations (client_id,quotation_no,items,subtotal,gst_pct,gst_amount,total,notes,valid_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [req.params.id, qNo, JSON.stringify(items), subtotal, gst_pct, gstAmount, total, notes, valid_until]
    );
    res.json({ ...rows[0], items: JSON.parse(rows[0].items) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:cid/quotations/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM quotations WHERE id=$1 AND client_id=$2', [req.params.id, req.params.cid]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CONTENT CALENDAR ──────────────────────────────────────────
app.get('/api/clients/:id/content-tasks', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM content_tasks WHERE client_id=$1 ORDER BY date ASC', [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients/:id/content-tasks', async (req, res) => {
  try {
    const { date, platform, content_type, notes='' } = req.body;
    if (!date || !platform || !content_type) return res.status(400).json({ error: 'date, platform, content_type required' });
    const { rows } = await pool.query(
      'INSERT INTO content_tasks (client_id,date,platform,content_type,notes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.id, date, platform, content_type, notes]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:cid/content-tasks/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM content_tasks WHERE id=$1 AND client_id=$2', [req.params.id, req.params.cid]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SEND REPORT (stub) ────────────────────────────────────────
app.post('/api/clients/:id/send-report', (req, res) => {
  const { to, subject, body } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email required' });
  console.log(`[Send Report stub] to=${to} subject="${subject}"`);
  res.json({ success: true, message: 'Report queued (SMTP not configured)' });
});

// ── CAMPAIGNS ─────────────────────────────────────────────────
app.get('/api/campaigns', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT c.*,cl.name as client_name,cl.company FROM campaigns c LEFT JOIN clients cl ON c.client_id=cl.id ORDER BY c.created_at DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaigns', async (req, res) => {
  try {
    const { name, client_id, channel, budget=0, spend=0, status='Draft' } = req.body;
    if (!name || !client_id) return res.status(400).json({ error: 'name and client_id required' });
    const { rows } = await pool.query(
      'INSERT INTO campaigns (name,client_id,channel,budget,spend,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name, client_id, channel, budget, spend, status]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/campaigns/:id', async (req, res) => {
  try {
    const { name, client_id, channel, budget, spend, status } = req.body;
    await pool.query(
      'UPDATE campaigns SET name=$1,client_id=$2,channel=$3,budget=$4,spend=$5,status=$6 WHERE id=$7',
      [name, client_id, channel, budget, spend, status, req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM campaigns WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/campaigns/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM campaigns WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AUTOMATIONS ───────────────────────────────────────────────
app.get('/api/automations', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT a.*,cl.name as client_name,cl.company FROM automations a LEFT JOIN clients cl ON a.client_id=cl.id ORDER BY a.created_at DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/automations', async (req, res) => {
  try {
    const { name, client_id, status='Running', notes='', revenue=0 } = req.body;
    if (!name || !client_id) return res.status(400).json({ error: 'name and client_id required' });
    const { rows } = await pool.query(
      'INSERT INTO automations (name,client_id,status,notes,revenue) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, client_id, status, notes, revenue]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/automations/:id', async (req, res) => {
  try {
    const { name, client_id, status, notes, revenue } = req.body;
    await pool.query(
      'UPDATE automations SET name=$1,client_id=$2,status=$3,notes=$4,revenue=$5 WHERE id=$6',
      [name, client_id, status, notes, revenue, req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM automations WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/automations/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM automations WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── COLLABORATIONS ────────────────────────────────────────────
app.get('/api/collaborations', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM collaborations ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/collaborations', async (req, res) => {
  try {
    const { partner, revenue=0, status='Active', notes='' } = req.body;
    if (!partner) return res.status(400).json({ error: 'partner required' });
    const { rows } = await pool.query(
      'INSERT INTO collaborations (partner,revenue,status,notes) VALUES ($1,$2,$3,$4) RETURNING *',
      [partner, revenue, status, notes]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/collaborations/:id', async (req, res) => {
  try {
    const { partner, revenue, status, notes } = req.body;
    await pool.query(
      'UPDATE collaborations SET partner=$1,revenue=$2,status=$3,notes=$4 WHERE id=$5',
      [partner, revenue, status, notes, req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM collaborations WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/collaborations/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM collaborations WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── REVENUE ───────────────────────────────────────────────────
app.get('/api/revenue', async (req, res) => {
  try {
    const [{ rows: entries }, { rows: totalsRows }, { rows: clientRevRows }] = await Promise.all([
      pool.query(`SELECT r.*,c.name as client_name,c.color FROM revenue_entries r LEFT JOIN clients c ON r.client_id=c.id ORDER BY r.date DESC`),
      pool.query(`SELECT SUM(CASE WHEN source='manual' THEN amount ELSE 0 END) as manual_total, SUM(amount) as grand_total FROM revenue_entries`),
      pool.query('SELECT SUM(revenue) as total FROM clients')
    ]);
    res.json({ entries, totals: totalsRows[0], clientRevenue: clientRevRows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/revenue', async (req, res) => {
  try {
    const { client_id, amount, date, source='manual', notes='' } = req.body;
    if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Valid amount required' });
    if (!date) return res.status(400).json({ error: 'Date required' });
    const { rows } = await pool.query(
      'INSERT INTO revenue_entries (client_id,amount,date,source,notes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [client_id||null, parseFloat(amount), date, source, notes]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/revenue/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM revenue_entries WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── REVENUE DAILY BREAKDOWN ───────────────────────────────────
app.get('/api/revenue/breakdown', async (req, res) => {
  try {
    const today = new Date();
    const d = (offset) => { const dt = new Date(today); dt.setDate(dt.getDate() - offset); return dt.toISOString().split('T')[0]; };
    const sumOn = async (date) => {
      const { rows } = await pool.query('SELECT COALESCE(SUM(amount),0) as total FROM revenue_entries WHERE date=$1', [date]);
      return parseFloat(rows[0].total) || 0;
    };
    const sumFrom = async (from, to) => {
      const { rows } = await pool.query('SELECT COALESCE(SUM(amount),0) as total FROM revenue_entries WHERE date>=$1 AND date<=$2', [from, to]);
      return parseFloat(rows[0].total) || 0;
    };
    if (req.query.date) {
      const val = await sumOn(req.query.date);
      return res.json({ custom: val, date: req.query.date });
    }
    const [todayV, yestV, dbdV, lwdV, l7V, l30V, l90V] = await Promise.all([
      sumOn(d(0)), sumOn(d(1)), sumOn(d(2)), sumOn(d(7)),
      sumFrom(d(7), d(0)), sumFrom(d(30), d(0)), sumFrom(d(90), d(0))
    ]);
    res.json({
      today: todayV, yesterday: yestV, dayBefore: dbdV, lastWeek: lwdV,
      last7: l7V, last30: l30V, last90: l90V,
      dates: { today: d(0), yesterday: d(1), dayBefore: d(2), lastWeekDay: d(7) }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DASHBOARD STATS ───────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const [{ rows: csRows }, { rows: asRows }, { rows: colRows }, { rows: mrRows }] = await Promise.all([
      pool.query("SELECT SUM(revenue) as revenue, SUM(spend) as spend, SUM(profit) as profit, COUNT(*) as total, SUM(CASE WHEN status='Active' THEN 1 ELSE 0 END) as active FROM clients"),
      pool.query("SELECT SUM(revenue) as revenue, COUNT(*) as total, SUM(CASE WHEN status='Running' THEN 1 ELSE 0 END) as running FROM automations"),
      pool.query('SELECT SUM(revenue) as revenue FROM collaborations'),
      pool.query("SELECT SUM(amount) as total FROM revenue_entries WHERE source='manual'")
    ]);
    const cs = csRows[0], as_ = asRows[0];
    const totalRevenue = (parseFloat(cs.revenue) || 0) + (parseFloat(mrRows[0].total) || 0);
    const totalSpend = parseFloat(cs.spend) || 0;
    res.json({
      totalRevenue,
      totalSpend,
      profit: totalRevenue - totalSpend,
      activeClients: parseInt(cs.active) || 0,
      totalClients: parseInt(cs.total) || 0,
      automationRevenue: parseFloat(as_.revenue) || 0,
      activeAutomations: parseInt(as_.running) || 0,
      collaborationRevenue: parseFloat(colRows[0].revenue) || 0,
      thisMonth: 316400,
      projected: Math.round(totalRevenue * 1.24)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CHART DATA ────────────────────────────────────────────────
app.get('/api/charts/performance', async (req, res) => {
  try {
    const [{ rows: clients }, { rows: funnelRows }] = await Promise.all([
      pool.query('SELECT id, name, revenue, spend, profit, color FROM clients ORDER BY revenue DESC'),
      pool.query(`SELECT COALESCE(SUM(impressions),0) as impressions, COALESCE(SUM(clicks),0) as clicks, COALESCE(SUM(leads),0) as leads FROM client_meta_metrics`)
    ]);
    const funnel = funnelRows[0];
    funnel.conversions = Math.round((parseFloat(funnel.leads) || 0) * 0.6);
    res.json({ clients, funnel });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── USERS ─────────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY id');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', async (req, res) => {
  try {
    const { name, email, role='member' } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await pool.query(
      'INSERT INTO users (name,email,role) VALUES ($1,$2,$3) RETURNING *',
      [name, email||null, role]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TRANSACTIONS ──────────────────────────────────────────────
app.get('/api/transactions', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT t.*,u.name as user_name FROM transactions t LEFT JOIN users u ON t.user_id=u.id ORDER BY t.date DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/transactions', async (req, res) => {
  try {
    const { user_id, type, category='Other', amount, date, notes='' } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    if (!type || !['income','expense'].includes(type)) return res.status(400).json({ error: 'type must be income or expense' });
    if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Valid amount required' });
    if (!date) return res.status(400).json({ error: 'Date required' });
    const { rows: uRows } = await pool.query('SELECT id FROM users WHERE id=$1', [user_id]);
    if (!uRows[0]) return res.status(400).json({ error: 'User not found' });
    const { rows } = await pool.query(
      'INSERT INTO transactions (user_id,type,category,amount,date,notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [user_id, type, category, parseFloat(amount), date, notes]
    );
    const { rows: full } = await pool.query(`SELECT t.*,u.name as user_name FROM transactions t LEFT JOIN users u ON t.user_id=u.id WHERE t.id=$1`, [rows[0].id]);
    res.json(full[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/transactions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM transactions WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SALARIES ──────────────────────────────────────────────────
app.get('/api/salaries', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT s.*,u.name as user_name FROM salaries s LEFT JOIN users u ON s.user_id=u.id ORDER BY s.date DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/salaries', async (req, res) => {
  try {
    const { user_id, amount, date, notes='' } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Valid amount required' });
    if (!date) return res.status(400).json({ error: 'Date required' });
    const { rows: uRows } = await pool.query('SELECT id FROM users WHERE id=$1', [user_id]);
    if (!uRows[0]) return res.status(400).json({ error: 'User not found' });
    const { rows } = await pool.query(
      'INSERT INTO salaries (user_id,amount,date,notes) VALUES ($1,$2,$3,$4) RETURNING id',
      [user_id, parseFloat(amount), date, notes]
    );
    const { rows: full } = await pool.query(`SELECT s.*,u.name as user_name FROM salaries s LEFT JOIN users u ON s.user_id=u.id WHERE s.id=$1`, [rows[0].id]);
    res.json(full[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/salaries/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM salaries WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PERSONAL FINANCE SUMMARY ──────────────────────────────────
app.get('/api/finance/personal', async (req, res) => {
  try {
    const [{ rows: users }, { rows: transactions }, { rows: salaries }] = await Promise.all([
      pool.query('SELECT * FROM users'),
      pool.query(`SELECT t.*,u.name as user_name FROM transactions t LEFT JOIN users u ON t.user_id=u.id ORDER BY t.date DESC`),
      pool.query(`SELECT s.*,u.name as user_name FROM salaries s LEFT JOIN users u ON s.user_id=u.id ORDER BY s.date DESC`)
    ]);
    const summary = users.map(u => {
      const income   = transactions.filter(t => t.user_id === u.id && t.type === 'income').reduce((a,t) => a + parseFloat(t.amount), 0);
      const expenses = transactions.filter(t => t.user_id === u.id && t.type === 'expense').reduce((a,t) => a + parseFloat(t.amount), 0);
      return { user_id: u.id, user_name: u.name, income, expenses, net: income - expenses };
    });
    const totalIncome   = transactions.filter(t => t.type === 'income').reduce((a,t) => a + parseFloat(t.amount), 0);
    const totalExpenses = transactions.filter(t => t.type === 'expense').reduce((a,t) => a + parseFloat(t.amount), 0);
    const totalSalaries = salaries.reduce((a,s) => a + parseFloat(s.amount), 0);
    res.json({ transactions, salaries, summary, totalIncome, totalExpenses, totalSalaries, netBalance: totalIncome - totalExpenses });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CLIENT FILES ──────────────────────────────────────────────
app.get('/api/clients/:clientId/files', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM client_files WHERE client_id=$1 ORDER BY uploaded_at DESC', [req.params.clientId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients/:clientId/files', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { file_type = 'report' } = req.body;
    const file_url  = `/uploads/${req.params.clientId}/${req.file.filename}`;
    const file_size = (req.file.size / 1024 / 1024).toFixed(1) + ' MB';
    const { rows } = await pool.query(
      'INSERT INTO client_files (client_id,file_name,file_url,file_size,file_type) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.clientId, req.file.originalname, file_url, file_size, file_type]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:clientId/files/:fileId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM client_files WHERE id=$1 AND client_id=$2', [req.params.fileId, req.params.clientId]);
    if (!rows[0]) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(__dirname, rows[0].file_url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await pool.query('DELETE FROM client_files WHERE id=$1', [req.params.fileId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── META ACCOUNT CRUD ─────────────────────────────────────────
app.get('/api/clients/:id/meta-account', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM client_meta_accounts WHERE client_id=$1', [req.params.id]);
    if (!rows[0]) return res.json(null);
    res.json({ ...rows[0], access_token: '••••' + rows[0].access_token.slice(-6) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients/:id/meta-account', async (req, res) => {
  try {
    const { ad_account_id, access_token, daily_budget=0, total_funds=0, alert_threshold=1000 } = req.body;
    if (!ad_account_id || !access_token) return res.status(400).json({ error: 'ad_account_id and access_token required' });
    const { rows } = await pool.query('SELECT id FROM client_meta_accounts WHERE client_id=$1', [req.params.id]);
    if (rows[0]) {
      await pool.query(
        'UPDATE client_meta_accounts SET ad_account_id=$1,access_token=$2,daily_budget=$3,total_funds=$4,alert_threshold=$5,is_active=1 WHERE client_id=$6',
        [ad_account_id, access_token, parseFloat(daily_budget)||0, parseFloat(total_funds)||0, parseFloat(alert_threshold)||1000, req.params.id]
      );
    } else {
      await pool.query(
        'INSERT INTO client_meta_accounts (client_id,ad_account_id,access_token,daily_budget,total_funds,alert_threshold) VALUES ($1,$2,$3,$4,$5,$6)',
        [req.params.id, ad_account_id, access_token, parseFloat(daily_budget)||0, parseFloat(total_funds)||0, parseFloat(alert_threshold)||1000]
      );
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:id/meta-account', async (req, res) => {
  try {
    await pool.query('DELETE FROM client_meta_accounts WHERE client_id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients/:id/meta-sync', async (req, res) => {
  try {
    const result = await syncClientMetaAccount(parseInt(req.params.id));
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GLOBAL META SYNC (all connected accounts) ─────────────────
app.post('/api/meta/sync', async (req, res) => {
  try {
    const { rows: accounts } = await pool.query('SELECT client_id FROM client_meta_accounts WHERE is_active=1');
    if (accounts.length === 0) {
      const mockData = [
        { campaign_name: 'Diwali Mega Sale', spend: 89000, date: new Date().toISOString().split('T')[0] },
        { campaign_name: 'Product Launch Q2', spend: 72000, date: new Date().toISOString().split('T')[0] },
      ];
      for (const d of mockData) {
        await pool.query('INSERT INTO meta_spend (campaign_name,spend,date) VALUES ($1,$2,$3)', [d.campaign_name, d.spend, d.date]);
      }
      return res.json({ success: true, synced: mockData.length, data: mockData });
    }
    const results = [];
    for (const a of accounts) {
      const r = await syncClientMetaAccount(a.client_id);
      results.push({ client_id: a.client_id, ...r });
    }
    res.json({ success: true, synced: results.length, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── META ALERTS ───────────────────────────────────────────────
app.get('/api/meta/alerts', async (req, res) => {
  try {
    const { rows: accounts } = await pool.query('SELECT m.*, c.name, c.company FROM client_meta_accounts m LEFT JOIN clients c ON m.client_id=c.id WHERE m.is_active=1');
    const alerts = [];
    for (const acct of accounts) {
      const { rows: latestRows } = await pool.query('SELECT * FROM client_meta_metrics WHERE client_id=$1 ORDER BY date DESC LIMIT 1', [acct.client_id]);
      const { rows: prevRows }   = await pool.query('SELECT * FROM client_meta_metrics WHERE client_id=$1 ORDER BY date DESC LIMIT 1 OFFSET 7', [acct.client_id]);
      const latest = latestRows[0];
      const prev   = prevRows[0];
      if (!latest) continue;
      const remaining = (parseFloat(acct.daily_budget)||0) - (parseFloat(latest.spend)||0);
      if (acct.daily_budget > 0 && remaining <= 200)
        alerts.push({ type: remaining<=100?'critical':'warning', client: acct.name, company: acct.company, client_id: acct.client_id, msg: `Low budget: ₹${Math.round(remaining)} remaining of ₹${acct.daily_budget} daily budget` });
      if (latest.ctr > 0 && latest.ctr < 1)
        alerts.push({ type: 'warning', client: acct.name, company: acct.company, client_id: acct.client_id, msg: `Low CTR: ${parseFloat(latest.ctr).toFixed(2)}% (below 1% threshold)` });
      if (prev && prev.cpc > 0 && latest.cpc > prev.cpc * 1.2)
        alerts.push({ type: 'warning', client: acct.name, company: acct.company, client_id: acct.client_id, msg: `CPC spike: ₹${parseFloat(latest.cpc).toFixed(2)} (+${Math.round((latest.cpc/prev.cpc-1)*100)}% vs last week)` });
      if (acct.daily_budget > 0 && latest.spend >= acct.daily_budget * 0.9)
        alerts.push({ type: 'warning', client: acct.name, company: acct.company, client_id: acct.client_id, msg: `Budget 90%+ used: ₹${latest.spend} of ₹${acct.daily_budget} spent` });
    }
    res.json(alerts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CRON: Daily Meta sync 8AM IST = 02:30 UTC ─────────────────
cron.schedule('30 2 * * *', () => {
  console.log('[Cron] 8AM IST — running daily Meta sync');
  syncAllMetaAccounts();
});

// ── BACKUP: EXPORT ────────────────────────────────────────────
app.get('/api/backup/export', async (req, res) => {
  try {
    const [
      { rows: clients },
      { rows: campaigns },
      { rows: automations },
      { rows: collaborations },
      { rows: revenue_entries },
      { rows: quotationRows },
      { rows: content_tasks },
      { rows: transactions },
      { rows: salaries },
      { rows: users }
    ] = await Promise.all([
      pool.query('SELECT * FROM clients ORDER BY id'),
      pool.query('SELECT * FROM campaigns ORDER BY id'),
      pool.query('SELECT * FROM automations ORDER BY id'),
      pool.query('SELECT * FROM collaborations ORDER BY id'),
      pool.query('SELECT * FROM revenue_entries ORDER BY id'),
      pool.query('SELECT * FROM quotations ORDER BY id'),
      pool.query('SELECT * FROM content_tasks ORDER BY id'),
      pool.query('SELECT * FROM transactions ORDER BY id'),
      pool.query('SELECT * FROM salaries ORDER BY id'),
      pool.query('SELECT id,name,email,role,created_at FROM users ORDER BY id')
    ]);
    const quotations = quotationRows.map(q => ({ ...q, items: (() => { try { return JSON.parse(q.items||'[]'); } catch(e) { return []; } })() }));
    res.json({
      exported_at: new Date().toISOString(),
      version: '1.0',
      clients, campaigns, automations, collaborations,
      revenue_entries, quotations, content_tasks,
      transactions, salaries, users
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BACKUP: RESTORE ───────────────────────────────────────────
app.post('/api/backup/restore', async (req, res) => {
  const backup = req.body;
  if (!backup || !backup.version) return res.status(400).json({ error: 'Invalid backup file' });

  const counts = { users:0, clients:0, campaigns:0, automations:0, collaborations:0, revenue_entries:0, quotations:0, content_tasks:0, transactions:0, salaries:0 };

  const upsertUser = async (u) => {
    const r = await pool.query(
      'INSERT INTO users (id,name,email,role,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [u.id, u.name, u.email||null, u.role||'member', u.created_at||new Date()]
    );
    if (r.rowCount > 0) counts.users++;
  };
  const upsertClient = async (c) => {
    const r = await pool.query(
      'INSERT INTO clients (id,name,company,email,status,revenue,spend,profit,expected_revenue,color,avatar_url,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING',
      [c.id, c.name, c.company, c.email||null, c.status||'Active', c.revenue||0, c.spend||0, c.profit||0, c.expected_revenue||0, c.color||'#FF6A00', c.avatar_url||null, c.created_at||new Date()]
    );
    if (r.rowCount > 0) counts.clients++;
  };
  const upsertCampaign = async (c) => {
    const r = await pool.query(
      'INSERT INTO campaigns (id,name,client_id,channel,budget,spend,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
      [c.id, c.name, c.client_id, c.channel, c.budget||0, c.spend||0, c.status||'Draft', c.created_at||new Date()]
    );
    if (r.rowCount > 0) counts.campaigns++;
  };
  const upsertAutomation = async (a) => {
    const r = await pool.query(
      'INSERT INTO automations (id,name,client_id,status,notes,revenue,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
      [a.id, a.name, a.client_id, a.status||'Running', a.notes||'', a.revenue||0, a.created_at||new Date()]
    );
    if (r.rowCount > 0) counts.automations++;
  };
  const upsertCollab = async (c) => {
    const r = await pool.query(
      'INSERT INTO collaborations (id,partner,revenue,status,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [c.id, c.partner, c.revenue||0, c.status||'Active', c.notes||'', c.created_at||new Date()]
    );
    if (r.rowCount > 0) counts.collaborations++;
  };
  const upsertRevEntry = async (e) => {
    const r = await pool.query(
      'INSERT INTO revenue_entries (id,client_id,amount,date,source,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
      [e.id, e.client_id||null, e.amount, e.date, e.source||'manual', e.notes||'', e.created_at||new Date()]
    );
    if (r.rowCount > 0) counts.revenue_entries++;
  };
  const upsertQuotation = async (q) => {
    const itemsStr = typeof q.items === 'string' ? q.items : JSON.stringify(q.items||[]);
    const r = await pool.query(
      'INSERT INTO quotations (id,client_id,quotation_no,items,subtotal,gst_pct,gst_amount,total,notes,valid_until,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING',
      [q.id, q.client_id, q.quotation_no||'', itemsStr, q.subtotal||0, q.gst_pct||18, q.gst_amount||0, q.total||0, q.notes||'', q.valid_until||null, q.created_at||new Date()]
    );
    if (r.rowCount > 0) counts.quotations++;
  };
  const upsertContentTask = async (t) => {
    const r = await pool.query(
      'INSERT INTO content_tasks (id,client_id,date,platform,content_type,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
      [t.id, t.client_id, t.date, t.platform, t.content_type, t.notes||'', t.created_at||new Date()]
    );
    if (r.rowCount > 0) counts.content_tasks++;
  };
  const upsertTransaction = async (t) => {
    const r = await pool.query(
      'INSERT INTO transactions (id,user_id,type,category,amount,date,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
      [t.id, t.user_id, t.type, t.category||'Other', t.amount, t.date, t.notes||'', t.created_at||new Date()]
    );
    if (r.rowCount > 0) counts.transactions++;
  };
  const upsertSalary = async (s) => {
    const r = await pool.query(
      'INSERT INTO salaries (id,user_id,amount,date,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [s.id, s.user_id, s.amount, s.date, s.notes||'', s.created_at||new Date()]
    );
    if (r.rowCount > 0) counts.salaries++;
  };

  try {
    for (const u of backup.users||[])           await upsertUser(u);
    for (const c of backup.clients||[])          await upsertClient(c);
    for (const c of backup.campaigns||[])        await upsertCampaign(c);
    for (const a of backup.automations||[])      await upsertAutomation(a);
    for (const c of backup.collaborations||[])   await upsertCollab(c);
    for (const e of backup.revenue_entries||[])  await upsertRevEntry(e);
    for (const q of backup.quotations||[])       await upsertQuotation(q);
    for (const t of backup.content_tasks||[])    await upsertContentTask(t);
    for (const t of backup.transactions||[])     await upsertTransaction(t);
    for (const s of backup.salaries||[])         await upsertSalary(s);

    // Reset sequences so new inserts don't collide with restored IDs
    const tables = ['users','clients','campaigns','automations','collaborations','revenue_entries','quotations','content_tasks','transactions','salaries'];
    for (const t of tables) {
      await pool.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), COALESCE((SELECT MAX(id) FROM ${t}),0)+1, false)`);
    }

    res.json({ success: true, restored: counts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CATCH ALL → SPA ───────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────
initDb()
  .then(() => app.listen(PORT, () => console.log(`✅ WeClick AI running on http://localhost:${PORT}`)))
  .catch(err => { console.error('❌ Failed to init DB:', err.message); process.exit(1); });
