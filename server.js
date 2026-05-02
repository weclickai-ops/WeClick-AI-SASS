require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const axios = require('axios');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── PASSWORD PROTECTION (MUST be before static files) ────────
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

// ── STATIC FILES (AFTER password check) ──────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── MULTER STORAGE ────────────────────────────────────────────
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
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only JPG, PNG or WEBP images are allowed'));
    }
    cb(null, true);
  }
});

// ── CLIENTS ───────────────────────────────────────────────────
app.get('/api/clients', (req, res) => {
  const clients = db.prepare(`
    SELECT c.*,
      CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END as meta_connected,
      m.balance as meta_balance,
      m.currency as meta_currency
    FROM clients c LEFT JOIN client_meta_accounts m ON m.client_id = c.id
    ORDER BY c.revenue DESC
  `).all();
  res.json(clients);
});

app.get('/api/clients/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const campaigns = db.prepare('SELECT * FROM campaigns WHERE client_id=?').all(client.id);
  const files = db.prepare('SELECT * FROM client_files WHERE client_id=? ORDER BY uploaded_at DESC').all(client.id);
  const automations = db.prepare('SELECT * FROM automations WHERE client_id=?').all(client.id);
  const quotations = db.prepare('SELECT * FROM quotations WHERE client_id=? ORDER BY created_at DESC').all(client.id)
    .map(q => ({ ...q, items: JSON.parse(q.items || '[]') }));
  const contentTasks = db.prepare('SELECT * FROM content_tasks WHERE client_id=? ORDER BY date ASC').all(client.id);
  const metaAccountRaw = db.prepare('SELECT id,client_id,ad_account_id,is_active,balance,currency,last_synced,created_at FROM client_meta_accounts WHERE client_id=?').get(client.id) || null;
  const metaAccount = metaAccountRaw ? { ...metaAccountRaw, low_funds: metaAccountRaw.balance !== null && metaAccountRaw.balance < 200 } : null;
  const metaInsights = db.prepare('SELECT * FROM meta_ad_insights WHERE client_id=? ORDER BY date ASC LIMIT 30').all(client.id);
  res.json({ ...client, campaigns, files, automations, quotations, contentTasks, metaAccount, metaInsights });
});

app.post('/api/clients', (req, res) => {
  const { name, company, status='Active', revenue=0, spend=0, expected_revenue=0, color='#FF6A00' } = req.body;
  if (!name || !company) return res.status(400).json({ error: 'name and company required' });
  const profit = revenue - spend;
  const r = db.prepare('INSERT INTO clients (name,company,status,revenue,spend,profit,expected_revenue,color) VALUES (?,?,?,?,?,?,?,?)').run(name, company, status, revenue, spend, profit, expected_revenue, color);
  res.json(db.prepare('SELECT * FROM clients WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/clients/:id', (req, res) => {
  const { name, company, status, revenue, spend, expected_revenue, color } = req.body;
  const profit = (revenue || 0) - (spend || 0);
  db.prepare('UPDATE clients SET name=?,company=?,status=?,revenue=?,spend=?,profit=?,expected_revenue=?,color=? WHERE id=?').run(name, company, status, revenue, spend, profit, expected_revenue, color, req.params.id);
  res.json(db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id));
});

app.delete('/api/clients/:id', (req, res) => {
  db.prepare('DELETE FROM clients WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/clients/:id/avatar', (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 2MB)' : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const client = db.prepare('SELECT id FROM clients WHERE id=?').get(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const avatar_url = `/uploads/clients/${req.params.id}/${req.file.filename}?v=${Date.now()}`;
    db.prepare('UPDATE clients SET avatar_url=? WHERE id=?').run(avatar_url, req.params.id);
    res.json({ success: true, avatar_url });
  });
});

// ── QUOTATIONS ────────────────────────────────────────────────
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

// ── CONTENT CALENDAR ──────────────────────────────────────────
app.get('/api/clients/:id/content-tasks', (req, res) => {
  res.json(db.prepare('SELECT * FROM content_tasks WHERE client_id=? ORDER BY date ASC').all(req.params.id));
});

app.post('/api/clients/:id/content-tasks', (req, res) => {
  const { date, platform, content_type, notes='' } = req.body;
  if (!date || !platform || !content_type) return res.status(400).json({ error: 'date, platform, content_type required' });
  const r = db.prepare('INSERT INTO content_tasks (client_id,date,platform,content_type,notes) VALUES (?,?,?,?,?)')
    .run(req.params.id, date, platform, content_type, notes);
  res.json(db.prepare('SELECT * FROM content_tasks WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/clients/:cid/content-tasks/:id', (req, res) => {
  db.prepare('DELETE FROM content_tasks WHERE id=? AND client_id=?').run(req.params.id, req.params.cid);
  res.json({ success: true });
});

// ── EMAIL / PDF REPORT ────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function generateQuotationPDF(q, clientName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const fmt = n => '₹' + Number(n || 0).toLocaleString('en-IN');
    doc.fontSize(20).fillColor('#FF6A00').text('WeClick AI', { align: 'right' });
    doc.fontSize(10).fillColor('#555').text('Marketing Agency', { align: 'right' });
    doc.moveDown();
    doc.fontSize(16).fillColor('#111').text(`Quotation — ${q.quotation_no}`);
    doc.fontSize(10).fillColor('#555').text(`Client: ${clientName}`);
    if (q.valid_until) doc.text(`Valid until: ${q.valid_until}`);
    doc.text(`Date: ${new Date(q.created_at).toLocaleDateString('en-IN')}`);
    doc.moveDown();
    const items = Array.isArray(q.items) ? q.items : JSON.parse(q.items || '[]');
    items.forEach(item => {
      const amt = (parseFloat(item.qty) || 0) * (parseFloat(item.rate) || 0);
      doc.fontSize(9).fillColor('#222').text(`${item.service || ''} — ${item.description || ''} | Qty: ${item.qty} | Rate: ${fmt(item.rate)} | Amount: ${fmt(amt)}`);
    });
    doc.moveDown();
    doc.fontSize(10).fillColor('#555').text(`Subtotal: ${fmt(q.subtotal)}`, { align: 'right' });
    doc.text(`GST (${q.gst_pct}%): ${fmt(q.gst_amount)}`, { align: 'right' });
    doc.fontSize(12).fillColor('#FF6A00').text(`Total: ${fmt(q.total)}`, { align: 'right' });
    if (q.notes) { doc.moveDown(); doc.fontSize(9).fillColor('#555').text(`Notes: ${q.notes}`); }
    doc.end();
  });
}

app.post('/api/clients/:id/send-report', async (req, res) => {
  const { to, subject, body, quotation_id } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email required' });
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.status(500).json({ error: 'Email not configured on server' });
  }
  try {
    const mailOptions = {
      from: `"WeClick AI" <${process.env.SMTP_USER}>`,
      to, subject: subject || 'Client Report',
      text: body || '',
      html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${body || ''}</pre>`,
      attachments: [],
    };
    if (quotation_id) {
      const client = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id);
      const q = db.prepare('SELECT * FROM quotations WHERE id=? AND client_id=?').get(quotation_id, req.params.id);
      if (q) {
        q.items = JSON.parse(q.items || '[]');
        const pdfBuffer = await generateQuotationPDF(q, client ? client.company : '');
        mailOptions.attachments.push({ filename: `${q.quotation_no}.pdf`, content: pdfBuffer, contentType: 'application/pdf' });
      }
    }
    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: `Report sent to ${to}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// ── CAMPAIGNS ─────────────────────────────────────────────────
app.get('/api/campaigns', (req, res) => {
  const rows = db.prepare(`SELECT c.*,cl.name as client_name,cl.company FROM campaigns c LEFT JOIN clients cl ON c.client_id=cl.id ORDER BY c.created_at DESC`).all();
  res.json(rows);
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

// ── AUTOMATIONS ───────────────────────────────────────────────
app.get('/api/automations', (req, res) => {
  const rows = db.prepare(`SELECT a.*,cl.name as client_name,cl.company FROM automations a LEFT JOIN clients cl ON a.client_id=cl.id ORDER BY a.created_at DESC`).all();
  res.json(rows);
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

// ── COLLABORATIONS ────────────────────────────────────────────
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

// ── REVENUE ───────────────────────────────────────────────────
app.get('/api/revenue', (req, res) => {
  const entries = db.prepare(`SELECT r.*,c.name as client_name,c.color FROM revenue_entries r LEFT JOIN clients cl ON r.client_id=cl.id LEFT JOIN clients c ON r.client_id=c.id ORDER BY r.date DESC`).all();
  const totals = db.prepare(`SELECT SUM(CASE WHEN source='manual' THEN amount ELSE 0 END) as manual_total, SUM(amount) as grand_total FROM revenue_entries`).get();
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

// ── DASHBOARD STATS ───────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  const { period = 'all' } = req.query;
  const now = new Date();
  let fromDate = null;
  if (period === 'today') {
    fromDate = now.toISOString().slice(0, 10);
  } else if (period === '7d') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    fromDate = d.toISOString().slice(0, 10);
  } else if (period === '30d') {
    const d = new Date(now); d.setDate(d.getDate() - 30);
    fromDate = d.toISOString().slice(0, 10);
  } else if (period === 'month') {
    fromDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }
  const clientStats = db.prepare("SELECT SUM(revenue) as revenue, SUM(spend) as spend, SUM(profit) as profit, COUNT(*) as total, SUM(CASE WHEN status='Active' THEN 1 ELSE 0 END) as active FROM clients").get();
  const autoStats = db.prepare("SELECT SUM(revenue) as revenue, COUNT(*) as total, SUM(CASE WHEN status='Running' THEN 1 ELSE 0 END) as running FROM automations").get();
  const colabStats = db.prepare('SELECT SUM(revenue) as revenue FROM collaborations').get();
  let totalRevenue, totalSpend, profit;
  if (fromDate) {
    const revRow = db.prepare('SELECT SUM(amount) as total FROM revenue_entries WHERE date >= ?').get(fromDate);
    const spendRow = db.prepare("SELECT SUM(amount) as total FROM transactions WHERE type='expense' AND date >= ?").get(fromDate);
    totalRevenue = revRow.total || 0;
    totalSpend = spendRow.total || 0;
    profit = totalRevenue - totalSpend;
  } else {
    const manualRev = db.prepare("SELECT SUM(amount) as total FROM revenue_entries WHERE source='manual'").get();
    totalRevenue = (clientStats.revenue || 0) + (manualRev.total || 0);
    totalSpend = clientStats.spend || 0;
    profit = totalRevenue - totalSpend;
  }
  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const thisMonthRow = db.prepare('SELECT SUM(amount) as total FROM revenue_entries WHERE date >= ?').get(thisMonthStart);
  res.json({
    totalRevenue, totalSpend, profit,
    activeClients: clientStats.active,
    totalClients: clientStats.total,
    automationRevenue: autoStats.revenue || 0,
    activeAutomations: autoStats.running,
    collaborationRevenue: colabStats.revenue || 0,
    thisMonth: thisMonthRow.total || 0,
    projected: Math.round((clientStats.revenue || 0) * 1.24),
    period
  });
});

// ── USERS ─────────────────────────────────────────────────────
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

// ── TRANSACTIONS ──────────────────────────────────────────────
app.get('/api/transactions', (req, res) => {
  const rows = db.prepare(`SELECT t.*,u.name as user_name FROM transactions t LEFT JOIN users u ON t.user_id=u.id ORDER BY t.date DESC`).all();
  res.json(rows);
});

app.post('/api/transactions', (req, res) => {
  const { user_id, type, category='Other', amount, date, notes='' } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (!type || !['income','expense'].includes(type)) return res.status(400).json({ error: 'type must be income or expense' });
  if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Valid amount required' });
  if (!date) return res.status(400).json({ error: 'Date required' });
  const userExists = db.prepare('SELECT id FROM users WHERE id=?').get(user_id);
  if (!userExists) return res.status(400).json({ error: 'User not found' });
  const r = db.prepare('INSERT INTO transactions (user_id,type,category,amount,date,notes) VALUES (?,?,?,?,?,?)').run(user_id, type, category, parseFloat(amount), date, notes);
  res.json(db.prepare('SELECT t.*,u.name as user_name FROM transactions t LEFT JOIN users u ON t.user_id=u.id WHERE t.id=?').get(r.lastInsertRowid));
});

app.delete('/api/transactions/:id', (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── SALARIES ──────────────────────────────────────────────────
app.get('/api/salaries', (req, res) => {
  const rows = db.prepare(`SELECT s.*,u.name as user_name FROM salaries s LEFT JOIN users u ON s.user_id=u.id ORDER BY s.date DESC`).all();
  res.json(rows);
});

app.post('/api/salaries', (req, res) => {
  const { user_id, amount, date, notes='' } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Valid amount required' });
  if (!date) return res.status(400).json({ error: 'Date required' });
  const userExists = db.prepare('SELECT id FROM users WHERE id=?').get(user_id);
  if (!userExists) return res.status(400).json({ error: 'User not found' });
  const r = db.prepare('INSERT INTO salaries (user_id,amount,date,notes) VALUES (?,?,?,?)').run(user_id, parseFloat(amount), date, notes);
  res.json(db.prepare('SELECT s.*,u.name as user_name FROM salaries s LEFT JOIN users u ON s.user_id=u.id WHERE s.id=?').get(r.lastInsertRowid));
});

app.delete('/api/salaries/:id', (req, res) => {
  db.prepare('DELETE FROM salaries WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── PERSONAL FINANCE SUMMARY ──────────────────────────────────
app.get('/api/finance/personal', (req, res) => {
  const users = db.prepare('SELECT * FROM users').all();
  const transactions = db.prepare(`SELECT t.*,u.name as user_name FROM transactions t LEFT JOIN users u ON t.user_id=u.id ORDER BY t.date DESC`).all();
  const salaries = db.prepare(`SELECT s.*,u.name as user_name FROM salaries s LEFT JOIN users u ON s.user_id=u.id ORDER BY s.date DESC`).all();
  const summary = users.map(u => {
    const income = transactions.filter(t => t.user_id === u.id && t.type === 'income').reduce((a, t) => a + t.amount, 0);
    const expenses = transactions.filter(t => t.user_id === u.id && t.type === 'expense').reduce((a, t) => a + t.amount, 0);
    return { user_id: u.id, user_name: u.name, income, expenses, net: income - expenses };
  });
  const totalIncome = transactions.filter(t => t.type === 'income').reduce((a, t) => a + t.amount, 0);
  const totalExpenses = transactions.filter(t => t.type === 'expense').reduce((a, t) => a + t.amount, 0);
  const totalSalaries = salaries.reduce((a, s) => a + s.amount, 0);
  res.json({ transactions, salaries, summary, totalIncome, totalExpenses, totalSalaries, netBalance: totalIncome - totalExpenses });
});

// ── CLIENT FILES ──────────────────────────────────────────────
app.get('/api/clients/:clientId/files', (req, res) => {
  const files = db.prepare('SELECT * FROM client_files WHERE client_id=? ORDER BY uploaded_at DESC').all(req.params.clientId);
  res.json(files);
});

app.post('/api/clients/:clientId/files', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { file_type = 'report' } = req.body;
  const file_url = `/uploads/${req.params.clientId}/${req.file.filename}`;
  const file_size = (req.file.size / 1024 / 1024).toFixed(1) + ' MB';
  const r = db.prepare('INSERT INTO client_files (client_id,file_name,file_url,file_size,file_type) VALUES (?,?,?,?,?)').run(req.params.clientId, req.file.originalname, file_url, file_size, file_type);
  res.json(db.prepare('SELECT * FROM client_files WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/clients/:clientId/files/:fileId', (req, res) => {
  const file = db.prepare('SELECT * FROM client_files WHERE id=? AND client_id=?').get(req.params.fileId, req.params.clientId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const filePath = path.join(__dirname, file.file_url);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('DELETE FROM client_files WHERE id=?').run(req.params.fileId);
  res.json({ success: true });
});

// ── META ADS INTEGRATION ──────────────────────────────────────
async function fetchMetaBalance(adAccountId, accessToken) {
  const url = `https://graph.facebook.com/v18.0/${adAccountId}?fields=balance,currency&access_token=${accessToken}`;
  const resp = await axios.get(url, { timeout: 15000 });
  return { balance: parseFloat(resp.data.balance || 0), currency: resp.data.currency || 'USD' };
}

async function fetchMetaInsights(adAccountId, accessToken) {
  const today = new Date();
  const since = new Date(today);
  since.setDate(since.getDate() - 30);
  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = today.toISOString().split('T')[0];
  const url = `https://graph.facebook.com/v18.0/${adAccountId}/insights?fields=spend,impressions,clicks,ctr,cpc,reach&time_range={"since":"${sinceStr}","until":"${untilStr}"}&access_token=${accessToken}`;
  const resp = await axios.get(url, { timeout: 15000 });
  const data = resp.data.data?.[0] || {};
  return {
    spend: parseFloat(data.spend || 0),
    impressions: parseInt(data.impressions || 0),
    clicks: parseInt(data.clicks || 0),
    ctr: parseFloat(data.ctr || 0),
    cpc: parseFloat(data.cpc || 0),
    reach: parseInt(data.reach || 0),
  };
}

async function syncClientMeta(clientId) {
  const acct = db.prepare('SELECT * FROM client_meta_accounts WHERE client_id=? AND is_active=1').get(clientId);
  if (!acct) return { error: 'No active Meta account' };
  try {
    const metrics = await fetchMetaInsights(acct.ad_account_id, acct.access_token);
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT OR IGNORE INTO meta_ad_insights (client_id,date,spend,impressions,clicks,ctr,cpc,reach) VALUES (?,?,?,?,?,?,?,?)`)
      .run(clientId, today, metrics.spend, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cpc, metrics.reach);
    let balanceData = { balance: null, currency: null };
    try { balanceData = await fetchMetaBalance(acct.ad_account_id, acct.access_token); } catch(_) {}
    db.prepare('UPDATE client_meta_accounts SET last_synced=CURRENT_TIMESTAMP, balance=?, currency=? WHERE client_id=?')
      .run(balanceData.balance, balanceData.currency, clientId);
    return { success: true, metrics, balance: balanceData.balance, currency: balanceData.currency };
  } catch (err) {
    return { error: err.response?.data?.error?.message || err.message };
  }
}

app.get('/api/clients/:id/meta-account', (req, res) => {
  const acct = db.prepare('SELECT id,client_id,ad_account_id,is_active,balance,currency,last_synced,created_at FROM client_meta_accounts WHERE client_id=?').get(req.params.id);
  res.json(acct || null);
});

app.post('/api/clients/:id/meta-account', async (req, res) => {
  let { ad_account_id, access_token } = req.body;
  if (!ad_account_id) return res.status(400).json({ error: 'ad_account_id required' });
  if (access_token === '__keep__' || !access_token) {
    const existing = db.prepare('SELECT access_token FROM client_meta_accounts WHERE client_id=?').get(req.params.id);
    if (!existing) return res.status(400).json({ error: 'No existing token found' });
    access_token = existing.access_token;
  }
  db.prepare(`INSERT INTO client_meta_accounts (client_id, ad_account_id, access_token, is_active) VALUES (?, ?, ?, 1) ON CONFLICT(client_id) DO UPDATE SET ad_account_id=excluded.ad_account_id, access_token=excluded.access_token, is_active=1`)
    .run(req.params.id, ad_account_id, access_token);
  const result = await syncClientMeta(req.params.id);
  const acct = db.prepare('SELECT id,client_id,ad_account_id,is_active,last_synced FROM client_meta_accounts WHERE client_id=?').get(req.params.id);
  res.json({ ...acct, syncResult: result });
});

app.post('/api/clients/:id/meta-sync', async (req, res) => {
  const result = await syncClientMeta(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  const insights = db.prepare('SELECT * FROM meta_ad_insights WHERE client_id=? ORDER BY date DESC LIMIT 1').get(req.params.id);
  res.json({ success: true, insights });
});

app.delete('/api/clients/:id/meta-account', (req, res) => {
  db.prepare('DELETE FROM client_meta_accounts WHERE client_id=?').run(req.params.id);
  res.json({ success: true });
});

// ── META SYNC MOCK ────────────────────────────────────────────
app.post('/api/meta/sync', (req, res) => {
  const mockData = [
    { campaign_name: 'Diwali Mega Sale', spend: 89000, date: new Date().toISOString().split('T')[0] },
    { campaign_name: 'Product Launch Q2', spend: 72000, date: new Date().toISOString().split('T')[0] },
  ];
  const insert = db.prepare('INSERT INTO meta_spend (campaign_name,spend,date) VALUES (?,?,?)');
  mockData.forEach(d => insert.run(d.campaign_name, d.spend, d.date));
  res.json({ success: true, synced: mockData.length, data: mockData });
});

// ── CRON: daily 8AM IST ───────────────────────────────────────
cron.schedule('30 2 * * *', async () => {
  console.log('[Cron] Starting daily Meta Ads sync...');
  const accounts = db.prepare('SELECT client_id FROM client_meta_accounts WHERE is_active=1').all();
  for (const { client_id } of accounts) {
    const result = await syncClientMeta(client_id);
    console.log(`[Cron] client ${client_id}:`, result.error || 'synced');
  }
}, { timezone: 'Asia/Kolkata' });

// ── CATCH ALL → SPA ───────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`✅ WeClick AI running on http://localhost:${PORT}`));
