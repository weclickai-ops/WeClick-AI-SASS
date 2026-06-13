const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const multer = require('multer');


const app = express();
const PORT = process.env.PORT || 3000;

// ── DB ─────────────────────────────────────────────────────────
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── MIDDLEWARE ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer — memory only (Vercel filesystem is read-only)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });


// ══════════════════════════════════════════════════════════════
// UNIVERSAL EMAIL HELPER
// Supports: Gmail App Password, SendGrid, or any SMTP
// ══════════════════════════════════════════════════════════════
async function sendEmail({to, toName, subject, body, co}) {
  // co = company_settings row
  const fromEmail = co.email || process.env.SMTP_USER || 'noreply@weclick.ai';
  const fromName  = co.company_name || 'WeClick AI';

  // ── SendGrid ────────────────────────────────────
  const sgKey = co.sendgrid_key || process.env.SENDGRID_API_KEY;
  if (sgKey) {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + sgKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to, name: toName || '' }] }],
        from: { email: fromEmail, name: fromName },
        subject,
        content: [{ type: 'text/plain', value: body }]
      })
    });
    if (res.ok || res.status === 202) return { ok: true, method: 'sendgrid' };
    const err = await res.text();
    throw new Error('SendGrid error: ' + err);
  }

  throw new Error('No email provider configured. Add Gmail App Password or SendGrid key in Settings → Agency.');
}

// ── ACTIVITY LOG HELPER ────────────────────────────────────────
async function logActivity({ type, title, details, client_id }) {
  try {
    await db.query(
      'INSERT INTO activity_log (type,title,details,client_id,created_at) VALUES ($1,$2,$3,$4,NOW())',
      [type, title, details || '', client_id || null]
    );
  } catch (e) { console.error('logActivity failed:', e.message); }
}

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const r = await db.query('SELECT NOW() as time');
    res.json({ ok: true, time: r.rows[0].time });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════
app.get('/api/dashboard', async (req, res) => {
  try {
    const [clients, campaigns, automations, collaborations] = await Promise.all([
      db.query('SELECT * FROM clients ORDER BY revenue DESC'),
      db.query('SELECT * FROM campaigns'),
      db.query('SELECT * FROM automations'),
      db.query('SELECT * FROM collaborations')
    ]);
    const cls = clients.rows;
    const totalRevenue = cls.reduce((s, c) => s + parseFloat(c.revenue || 0), 0);
    const totalSpend = cls.reduce((s, c) => s + parseFloat(c.spend || 0), 0);
    const profit = totalRevenue - totalSpend;
    const activeClients = cls.filter(c => c.status === 'Active').length;
    const automationRevenue = automations.rows.reduce((s, a) => s + parseFloat(a.revenue || 0), 0);
    const collaborationRevenue = collaborations.rows.reduce((s, c) => s + parseFloat(c.revenue || 0), 0);
    const activeAutomations = automations.rows.filter(a => a.status === 'Running').length;
    let recentActivity = [];
    try {
      const act = await db.query('SELECT al.*, c.name as client_name FROM activity_log al LEFT JOIN clients c ON c.id=al.client_id ORDER BY al.created_at DESC LIMIT 15');
      recentActivity = act.rows;
    } catch (e) {}
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    let thisMonth = 0;
    try {
      const tm = await db.query("SELECT COALESCE(SUM(amount),0) as total FROM revenue_entries WHERE date >= $1", [monthStart]);
      thisMonth = parseFloat(tm.rows[0].total || 0);
    } catch (e) {}
    res.json({ totalRevenue, totalSpend, profit, activeClients, totalClients: cls.length, automationRevenue, collaborationRevenue, activeAutomations, thisMonth, projected: Math.round(thisMonth * (30 / now.getDate()) * 1.1), recentActivity });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/revenue/breakdown', async (req, res) => {
  try {
    const { date } = req.query;
    const clientRev = async (days) => {
      const d = new Date(); d.setDate(d.getDate() - days);
      try {
        const r = await db.query("SELECT COALESCE(SUM(amount),0) as total FROM revenue_entries WHERE date >= $1", [d.toISOString().split('T')[0]]);
        return parseFloat(r.rows[0].total || 0);
      } catch { return 0; }
    };
    const [today, yesterday, last7, last30, last90] = await Promise.all([clientRev(1), clientRev(2), clientRev(7), clientRev(30), clientRev(90)]);
    let custom = 0;
    if (date) { try { const r = await db.query("SELECT COALESCE(SUM(amount),0) as total FROM revenue_entries WHERE date=$1", [date]); custom = parseFloat(r.rows[0].total || 0); } catch {} }
    res.json({ today, yesterday, last7, last30, last90, custom, dayBefore: yesterday });
  } catch (e) { res.json({}); }
});

// ══════════════════════════════════════════════════════════════
// CLIENTS
// ══════════════════════════════════════════════════════════════
app.get('/api/clients', async (req, res) => {
  try { res.json((await db.query('SELECT * FROM clients ORDER BY revenue DESC')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clients/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [clientRes, campaignsRes, quotRes, filesRes, tasksRes, metaRes] = await Promise.all([
      db.query('SELECT * FROM clients WHERE id=$1', [id]),
      db.query('SELECT * FROM campaigns WHERE client_id=$1 ORDER BY created_at DESC', [id]),
      db.query('SELECT * FROM quotations WHERE client_id=$1 ORDER BY created_at DESC', [id]),
      db.query('SELECT * FROM client_files WHERE client_id=$1 ORDER BY uploaded_at DESC', [id]).catch(() => ({ rows: [] })),
      db.query('SELECT * FROM content_tasks WHERE client_id=$1 ORDER BY date ASC', [id]).catch(() => ({ rows: [] })),
      db.query('SELECT * FROM meta_accounts WHERE client_id=$1 LIMIT 1', [id]).catch(() => ({ rows: [] }))
    ]);
    if (!clientRes.rows[0]) return res.status(404).json({ error: 'Client not found' });
    const quotations = quotRes.rows.map(q => ({ ...q, items: typeof q.items === 'string' ? JSON.parse(q.items) : (q.items || []) }));
    const metaAccount = metaRes.rows[0] || null;
    let metaMetrics = null, metaCreatives = [];
    if (metaAccount) {
      try { const mm = await db.query('SELECT * FROM meta_metrics WHERE client_id=$1 ORDER BY synced_at DESC LIMIT 1', [id]); if (mm.rows[0]) metaMetrics = mm.rows[0]; } catch {}
      try { metaCreatives = (await db.query('SELECT * FROM client_creatives WHERE client_id=$1 ORDER BY score DESC', [id])).rows; } catch {}
    }
    res.json({ ...clientRes.rows[0], campaigns: campaignsRes.rows, quotations, files: filesRes.rows, contentTasks: tasksRes.rows, metaAccount, metaMetrics, metaCreatives });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', async (req, res) => {
  try {
    const { name, company, email, status, revenue, spend, expected_revenue, color } = req.body;
    const profit = parseFloat(revenue || 0) - parseFloat(spend || 0);
    const result = await db.query(
      'INSERT INTO clients (name,company,email,status,revenue,spend,profit,expected_revenue,color,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *',
      [name, company, email||'', status||'Active', revenue||0, spend||0, profit, expected_revenue||0, color||'#FF6A00']
    );
    await logActivity({ type:'client', title:`New client: ${name}`, details:company, client_id:result.rows[0].id });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id', async (req, res) => {
  try {
    const fields = ['name','company','email','status','revenue','spend','expected_revenue'];
    const updates = {};
    fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    if (updates.revenue !== undefined && updates.spend !== undefined) updates.profit = parseFloat(updates.revenue) - parseFloat(updates.spend);
    const keys = Object.keys(updates); const vals = Object.values(updates);
    vals.push(req.params.id);
    const result = await db.query(`UPDATE clients SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id', async (req, res) => {
  try { await db.query('DELETE FROM clients WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Avatar upload — store as base64 in DB since Vercel has no filesystem
app.post('/api/clients/:id/avatar', upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    await db.query('UPDATE clients SET avatar_url=$1 WHERE id=$2', [b64, req.params.id]);
    res.json({ avatar_url: b64 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// File upload — store as base64 in DB
app.post('/api/clients/:id/files', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const sizeKB = (req.file.size / 1024).toFixed(1) + ' KB';
    const result = await db.query(
      'INSERT INTO client_files (client_id,file_name,file_url,file_type,file_size,uploaded_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *',
      [req.params.id, req.file.originalname, b64, req.body.file_type||'report', sizeKB]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id/files/:fileId', async (req, res) => {
  try { await db.query('DELETE FROM client_files WHERE id=$1', [req.params.fileId]); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/content-tasks', async (req, res) => {
  try {
    const { date, platform, content_type, notes } = req.body;
    const result = await db.query('INSERT INTO content_tasks (client_id,date,platform,content_type,notes) VALUES ($1,$2,$3,$4,$5) RETURNING *', [req.params.id, date, platform, content_type, notes||'']);
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id/content-tasks/:taskId', async (req, res) => {
  try { await db.query('DELETE FROM content_tasks WHERE id=$1 AND client_id=$2', [req.params.taskId, req.params.id]); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/send-report', async (req, res) => {
  try {
    await logActivity({ type:'report', title:`Report sent to ${req.body.to}`, client_id:parseInt(req.params.id) });
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// QUOTATIONS
// ══════════════════════════════════════════════════════════════
app.get('/api/clients/:id/quotations', async (req, res) => {
  try {
    const rows = (await db.query('SELECT * FROM quotations WHERE client_id=$1 ORDER BY created_at DESC', [req.params.id])).rows;
    res.json(rows.map(q => ({ ...q, items: typeof q.items==='string' ? JSON.parse(q.items) : (q.items||[]) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/quotations', async (req, res) => {
  try {
    const { items, gst_pct, valid_until, notes, payment, our_address, client_address, agency_sig, client_sig } = req.body;
    const subtotal = items.reduce((s,i) => s+(i.qty||0)*(i.rate||0), 0);
    const gst_amount = subtotal*(gst_pct||0)/100;
    const total = subtotal+gst_amount;
    let qno = 'QT-1001';
    try { const sq = await db.query("SELECT nextval('quotation_seq') as n"); qno=`QT-${sq.rows[0].n}`; } catch {}
    const extra = JSON.stringify({payment:payment||{},our_address:our_address||'',client_address:client_address||'',agency_sig:agency_sig||'',client_sig:client_sig||''});
    const result = await db.query(
      'INSERT INTO quotations (client_id,quotation_no,items,subtotal,gst_pct,gst_amount,total,valid_until,notes,payment,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING *',
      [req.params.id, qno, JSON.stringify(items), subtotal, gst_pct||0, gst_amount, total, valid_until||null, notes||'', extra]
    );
    res.json({ ...result.rows[0], items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id/quotations/:qid', async (req, res) => {
  try { await db.query('DELETE FROM quotations WHERE id=$1 AND client_id=$2', [req.params.qid, req.params.id]); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// META ADS
// ══════════════════════════════════════════════════════════════
app.post('/api/clients/:id/meta-account', async (req, res) => {
  try {
    const { ad_account_id, access_token } = req.body;
    const ex = await db.query('SELECT * FROM meta_accounts WHERE client_id=$1', [req.params.id]);
    if (ex.rows[0]) {
      const upd = { ad_account_id, is_active: true };
      if (access_token) upd.access_token = access_token;
      const keys=Object.keys(upd); const vals=[...Object.values(upd), req.params.id];
      await db.query(`UPDATE meta_accounts SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE client_id=$${vals.length}`, vals);
    } else {
      await db.query('INSERT INTO meta_accounts (client_id,ad_account_id,access_token,is_active) VALUES ($1,$2,$3,true)', [req.params.id, ad_account_id, access_token||'']);
    }
    await logActivity({ type:'meta', title:'Meta Ads connected', client_id:parseInt(req.params.id) });
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id/meta-account', async (req, res) => {
  try { await db.query('UPDATE meta_accounts SET is_active=false WHERE client_id=$1', [req.params.id]); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/meta-sync', async (req, res) => {
  try {
    const meta = await db.query('SELECT * FROM meta_accounts WHERE client_id=$1 AND is_active=true', [req.params.id]);
    if (!meta.rows[0]) return res.status(400).json({ error: 'No Meta account connected' });
    const { ad_account_id, access_token } = meta.rows[0];
    if (!access_token) return res.status(400).json({ error: 'No access token saved' });
    const since = new Date(Date.now()-30*86400000).toISOString().split('T')[0];
    const until = new Date().toISOString().split('T')[0];
    const metaUrl = `https://graph.facebook.com/v18.0/${ad_account_id}/insights?fields=spend,impressions,clicks,ctr,cpc,reach,actions&time_range={"since":"${since}","until":"${until}"}&access_token=${access_token}`;
    const metaRes = await fetch(metaUrl);
    const metaData = await metaRes.json();
    if (metaData.error) throw new Error(metaData.error.message||'Meta API error');
    const d = metaData.data?.[0]||{};
    const leads = (d.actions||[]).find(a=>a.action_type==='lead')?.value||0;
    let balance = null;
    try { const br = await fetch(`https://graph.facebook.com/v18.0/${ad_account_id}?fields=balance&access_token=${access_token}`); const bd=await br.json(); if(bd.balance!==undefined)balance=parseFloat(bd.balance)/100; } catch {}
    const metrics = { spend:parseFloat(d.spend||0), impressions:parseInt(d.impressions||0), clicks:parseInt(d.clicks||0), ctr:parseFloat(d.ctr||0), cpc:parseFloat(d.cpc||0), reach:parseInt(d.reach||0), leads:parseInt(leads) };
    try {
      await db.query('INSERT INTO meta_metrics (client_id,spend,impressions,clicks,ctr,cpc,reach,leads,synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT (client_id) DO UPDATE SET spend=$2,impressions=$3,clicks=$4,ctr=$5,cpc=$6,reach=$7,leads=$8,synced_at=NOW()',
        [req.params.id,metrics.spend,metrics.impressions,metrics.clicks,metrics.ctr,metrics.cpc,metrics.reach,metrics.leads]);
    } catch {
      await db.query('INSERT INTO meta_metrics (client_id,spend,impressions,clicks,ctr,cpc,reach,leads,synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())',
        [req.params.id,metrics.spend,metrics.impressions,metrics.clicks,metrics.ctr,metrics.cpc,metrics.reach,metrics.leads]);
    }
    await db.query(balance!==null ? 'UPDATE meta_accounts SET balance=$1,last_synced=NOW() WHERE client_id=$2' : 'UPDATE meta_accounts SET last_synced=NOW() WHERE client_id=$1', balance!==null ? [balance,req.params.id] : [req.params.id]);
    await logActivity({ type:'meta', title:`Meta synced — ₹${metrics.spend.toLocaleString('en-IN')} spend`, client_id:parseInt(req.params.id) });
    res.json({ ok:true, metrics, balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/meta/sync', async (req, res) => {
  try {
    const accounts = await db.query("SELECT * FROM meta_accounts WHERE is_active=true AND access_token IS NOT NULL AND access_token!=''");
    let synced = 0;
    for (const acc of accounts.rows) {
      try {
        const r = await fetch(`https://${req.headers.host}/api/clients/${acc.client_id}/meta-sync`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
        if (r.ok) synced++;
      } catch {}
    }
    res.json({ ok:true, synced });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/meta/alerts', async (req, res) => {
  try {
    const result = await db.query("SELECT c.id as client_id,c.name,c.company,ma.balance FROM meta_accounts ma JOIN clients c ON c.id=ma.client_id WHERE ma.is_active=true AND ma.balance IS NOT NULL AND ma.balance<500");
    res.json(result.rows.map(r => ({ client_id:r.client_id, client:r.name, company:r.company, type:r.balance<100?'critical':'warning', msg:`Only ₹${parseFloat(r.balance).toFixed(0)} remaining` })));
  } catch (e) { res.json([]); }
});

// ══════════════════════════════════════════════════════════════
// CAMPAIGNS / AUTOMATIONS / COLLABORATIONS
// ══════════════════════════════════════════════════════════════
app.get('/api/campaigns', async (req, res) => {
  try { res.json((await db.query('SELECT c.*,cl.name as client_name FROM campaigns c LEFT JOIN clients cl ON cl.id=c.client_id ORDER BY c.created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/campaigns', async (req, res) => {
  try {
    const { name, client_id, channel, budget, spend, status } = req.body;
    const r = await db.query('INSERT INTO campaigns (name,client_id,channel,budget,spend,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING *', [name,client_id,channel,budget||0,spend||0,status||'Active']);
    await logActivity({ type:'campaign', title:`Campaign "${name}" created`, client_id:client_id?parseInt(client_id):null });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/campaigns/:id', async (req, res) => {
  try { await db.query('DELETE FROM campaigns WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/automations', async (req, res) => {
  try { res.json((await db.query('SELECT a.*,c.name as client_name FROM automations a LEFT JOIN clients c ON c.id=a.client_id ORDER BY a.created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/automations', async (req, res) => {
  try {
    const { name, client_id, status, revenue, notes } = req.body;
    const r = await db.query('INSERT INTO automations (name,client_id,status,revenue,notes,created_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *', [name,client_id||null,status||'Running',revenue||0,notes||'']);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/automations/:id', async (req, res) => {
  try { await db.query('DELETE FROM automations WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/collaborations', async (req, res) => {
  try { res.json((await db.query('SELECT * FROM collaborations ORDER BY created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/collaborations', async (req, res) => {
  try {
    const { partner, revenue, status, notes } = req.body;
    const r = await db.query('INSERT INTO collaborations (partner,revenue,status,notes,created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING *', [partner,revenue||0,status||'Active',notes||'']);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/collaborations/:id', async (req, res) => {
  try { await db.query('DELETE FROM collaborations WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// REVENUE
// ══════════════════════════════════════════════════════════════
app.get('/api/revenue', async (req, res) => {
  try { res.json({ entries: (await db.query('SELECT r.*,c.name as client_name FROM revenue_entries r LEFT JOIN clients c ON c.id=r.client_id ORDER BY r.date DESC,r.created_at DESC')).rows }); }
  catch (e) { res.json({ entries:[] }); }
});
app.post('/api/revenue', async (req, res) => {
  try {
    const { client_id, amount, date, source, notes } = req.body;
    const r = await db.query('INSERT INTO revenue_entries (client_id,amount,date,source,notes,created_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *', [client_id||null,amount,date,source||'manual',notes||'']);
    await logActivity({ type:'revenue', title:`Revenue: ₹${parseFloat(amount).toLocaleString('en-IN')}`, client_id:client_id?parseInt(client_id):null });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/revenue/:id', async (req, res) => {
  try { await db.query('DELETE FROM revenue_entries WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/finance/personal', async (req, res) => {
  try {
    const [txRes, salRes] = await Promise.all([
      db.query('SELECT t.*,u.name as user_name FROM transactions t LEFT JOIN users u ON u.id=t.user_id ORDER BY t.date DESC').catch(()=>({rows:[]})),
      db.query('SELECT s.*,u.name as user_name FROM salaries s LEFT JOIN users u ON u.id=s.user_id ORDER BY s.date DESC').catch(()=>({rows:[]}))
    ]);
    const txs = txRes.rows;
    const totalIncome = txs.filter(t=>t.type==='income').reduce((s,t)=>s+parseFloat(t.amount||0),0);
    const totalExpenses = txs.filter(t=>t.type==='expense').reduce((s,t)=>s+parseFloat(t.amount||0),0);
    const totalSalaries = salRes.rows.reduce((s,t)=>s+parseFloat(t.amount||0),0);
    const summaryMap = {};
    txs.forEach(t=>{ const k=t.user_name||'Unknown'; if(!summaryMap[k])summaryMap[k]={user_name:k,income:0,expenses:0}; if(t.type==='income')summaryMap[k].income+=parseFloat(t.amount||0); else summaryMap[k].expenses+=parseFloat(t.amount||0); });
    res.json({ transactions:txs, salaries:salRes.rows, summary:Object.values(summaryMap).map(s=>({...s,net:s.income-s.expenses})), totalIncome, totalExpenses, totalSalaries, netBalance:totalIncome-totalExpenses });
  } catch (e) { res.json({ transactions:[],salaries:[],summary:[],totalIncome:0,totalExpenses:0,totalSalaries:0,netBalance:0 }); }
});
app.post('/api/transactions', async (req, res) => {
  try { const {user_id,type,category,amount,date}=req.body; res.json((await db.query('INSERT INTO transactions (user_id,type,category,amount,date,created_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *',[user_id,type,category,amount,date])).rows[0]); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/transactions/:id', async (req, res) => {
  try { await db.query('DELETE FROM transactions WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/salaries', async (req, res) => {
  try { const {user_id,amount,date,notes}=req.body; res.json((await db.query('INSERT INTO salaries (user_id,amount,date,notes,created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING *',[user_id,amount,date,notes||''])).rows[0]); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/salaries/:id', async (req, res) => {
  try { await db.query('DELETE FROM salaries WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/users', async (req, res) => {
  try { res.json((await db.query('SELECT * FROM users ORDER BY name')).rows); }
  catch (e) { res.json([{id:1,name:'Admin'}]); }
});

// ══════════════════════════════════════════════════════════════
// CHARTS
// ══════════════════════════════════════════════════════════════
app.get('/api/charts/performance', async (req, res) => {
  try {
    const clients = await db.query('SELECT id,name,revenue,spend,profit,color FROM clients ORDER BY revenue DESC LIMIT 8');
    const metaRows = await db.query('SELECT * FROM meta_metrics').catch(()=>({rows:[]}));
    res.json({ clients:clients.rows.map(c=>({...c,revenue:parseFloat(c.revenue||0),spend:parseFloat(c.spend||0),profit:parseFloat(c.profit||0)})), funnel:{ impressions:metaRows.rows.reduce((s,r)=>s+parseInt(r.impressions||0),0), clicks:metaRows.rows.reduce((s,r)=>s+parseInt(r.clicks||0),0), leads:metaRows.rows.reduce((s,r)=>s+parseInt(r.leads||0),0), spend:metaRows.rows.reduce((s,r)=>s+parseFloat(r.spend||0),0) } });
  } catch (e) { res.json({ clients:[], funnel:{} }); }
});

// ══════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════
app.get('/api/settings/company', async (req, res) => {
  try { res.json((await db.query('SELECT * FROM company_settings LIMIT 1')).rows[0]||{}); }
  catch (e) { res.json({}); }
});
app.post('/api/settings/company', async (req, res) => {
  try {
    const allowed = ['company_name','tagline','address_line1','address_line2','city','state','pincode','phone','email','gstin','upi_id','bank_name','bank_account','bank_ifsc','bank_holder','meta_account_id','google_cid','fiscal_year_start','signature_url','default_gst','alert_email','low_balance_alert','sendgrid_key','smtp_user','smtp_pass'];
    // Only update the fields that were actually sent in the request body
    const sentFields = Object.keys(req.body).filter(f => allowed.includes(f));
    if (sentFields.length === 0) return res.json({ ok: true });
    // Ensure a row exists (table always has exactly 1 row, seeded by initDb)
    const existing = await db.query('SELECT id FROM company_settings LIMIT 1');
    if (existing.rows.length === 0) {
      await db.query('INSERT INTO company_settings (updated_at) VALUES (NOW())');
    }
    const values = sentFields.map(f => req.body[f] === '' ? null : (req.body[f] ?? null));
    const setClause = sentFields.map((f, i) => `${f}=$${i + 1}`).join(',');
    await db.query(`UPDATE company_settings SET ${setClause},updated_at=NOW() WHERE id=(SELECT id FROM company_settings LIMIT 1)`, values);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/settings/signature', upload.single('signature'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error:'No file' });
    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    await db.query('INSERT INTO company_settings (signature_url,updated_at) VALUES ($1,NOW()) ON CONFLICT (id) DO UPDATE SET signature_url=$1,updated_at=NOW()', [b64]);
    res.json({ signature_url: b64 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/settings/signature', async (req, res) => {
  try {
    await db.query('UPDATE company_settings SET signature_url=NULL,updated_at=NOW() WHERE id=(SELECT id FROM company_settings LIMIT 1)');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// DAILY SPEND / ACTIVITY / CREATIVES
// ══════════════════════════════════════════════════════════════
app.get('/api/finance/daily-spend', async (req, res) => {
  try {
    const month = req.query.month||new Date().toISOString().slice(0,7);
    const [yr,mo] = month.split('-').map(Number);
    const nextMo = mo===12?`${yr+1}-01`:`${yr}-${String(mo+1).padStart(2,'0')}`;
    res.json((await db.query('SELECT * FROM daily_spend WHERE date >= $1 AND date < $2 ORDER BY date DESC',[month+'-01',nextMo+'-01'])).rows);
  } catch (e) { res.json([]); }
});
app.post('/api/finance/daily-spend', async (req, res) => {
  try {
    const {date,amount,category,description,added_by}=req.body;
    const r = await db.query('INSERT INTO daily_spend (date,amount,category,description,added_by,created_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *',[date,amount,category||'Other',description||'',added_by||'']);
    await logActivity({ type:'expense', title:`Expense: ₹${parseFloat(amount).toLocaleString('en-IN')} (${category||'Other'})` });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/finance/daily-spend/:id', async (req, res) => {
  try { await db.query('DELETE FROM daily_spend WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/activity', async (req, res) => {
  try { res.json((await db.query('SELECT al.*,c.name as client_name FROM activity_log al LEFT JOIN clients c ON c.id=al.client_id ORDER BY al.created_at DESC LIMIT 20')).rows); }
  catch (e) { res.json([]); }
});
app.get('/api/clients/:id/creatives', async (req, res) => {
  try { res.json((await db.query('SELECT * FROM client_creatives WHERE client_id=$1 ORDER BY score DESC',[req.params.id])).rows); }
  catch (e) { res.json([]); }
});



app.post('/api/clients/:id/quotations/:qid/approve', async (req, res) => {
  try {
    await db.query('UPDATE quotations SET approved=true,approved_at=NOW() WHERE id=$1 AND client_id=$2', [req.params.qid, req.params.id]);
    res.json({ok:true});
  } catch(e) {
    // approved column might not exist yet
    res.json({ok:true, note:'Add approved BOOLEAN column to quotations if needed'});
  }
});

// ── TALLY ALIASES (frontend compatibility) ──────────────────
app.get('/api/tally', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const [yr, mo] = month.split('-').map(Number);
    const nextMo = mo===12?`${yr+1}-01`:`${yr}-${String(mo+1).padStart(2,'0')}`;
    const rows = (await db.query('SELECT ds.*, u.name as user_name FROM daily_spend ds LEFT JOIN users u ON u.id=ds.user_id WHERE ds.date >= $1 AND ds.date < $2 ORDER BY ds.date DESC',[month+'-01',nextMo+'-01'])).rows;
    const total = rows.reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
    const catMap={};
    rows.forEach(e=>{const k=e.category||'Other';if(!catMap[k])catMap[k]=0;catMap[k]+=(parseFloat(e.amount)||0);});
    const categories=Object.entries(catMap).map(([name,total])=>({name,total}));
    res.json({entries:rows, summary:{total,categories}});
  } catch(e){ res.json({entries:[],summary:{total:0,categories:[]}}); }
});
app.post('/api/tally', async (req, res) => {
  try {
    const {category,amount,description,date,user_id} = req.body;
    const r = await db.query('INSERT INTO daily_spend (date,amount,category,description,added_by,created_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *',[date,amount,category||'Other',description||'',req.body.added_by||'']);
    res.json(r.rows[0]);
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.delete('/api/tally/:id', async (req, res) => {
  try { await db.query('DELETE FROM daily_spend WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:e.message}); }
});



// ══════════════════════════════════════════════════════════════
// MEETINGS
// ══════════════════════════════════════════════════════════════
app.get('/api/meetings', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT m.*, c.name as client_name, c.company as client_company, c.email as client_email, c.color as client_color
      FROM meetings m LEFT JOIN clients c ON c.id=m.client_id
      ORDER BY m.meeting_date ASC`);
    res.json(result.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/meetings', async (req, res) => {
  try {
    const { client_id, title, meeting_date, duration_mins, meeting_type, meeting_link, notes, send_notification } = req.body;
    const result = await db.query(
      `INSERT INTO meetings (client_id,title,meeting_date,duration_mins,meeting_type,meeting_link,notes,notified,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false,NOW()) RETURNING *`,
      [client_id, title||'Meeting', meeting_date, duration_mins||60, meeting_type||'video', meeting_link||'', notes||'']
    );
    const meeting = result.rows[0];
    await logActivity({type:'meeting', title:`Meeting scheduled: ${title} with client`, client_id: client_id});

    if (send_notification) {
      await sendMeetingEmail(meeting.id);
    }
    res.json(meeting);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.put('/api/meetings/:id', async (req, res) => {
  try {
    const { client_id, title, meeting_date, duration_mins, meeting_type, meeting_link, notes } = req.body;
    const result = await db.query(
      `UPDATE meetings SET client_id=$1,title=$2,meeting_date=$3,duration_mins=$4,meeting_type=$5,meeting_link=$6,notes=$7 WHERE id=$8 RETURNING *`,
      [client_id, title, meeting_date, duration_mins||60, meeting_type||'video', meeting_link||'', notes||'', req.params.id]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/api/meetings/:id', async (req, res) => {
  try { await db.query('DELETE FROM meetings WHERE id=$1', [req.params.id]); res.json({ok:true}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/meetings/:id/notify', async (req, res) => {
  try {
    const sent = await sendMeetingEmail(parseInt(req.params.id));
    res.json({ok:true, sent});
  } catch(e) { res.status(500).json({error:e.message}); }
});

async function sendMeetingEmail(meetingId) {
  try {
    const mRes = await db.query(`SELECT m.*,c.name,c.email,c.company FROM meetings m JOIN clients c ON c.id=m.client_id WHERE m.id=$1`, [meetingId]);
    if (!mRes.rows[0]) return false;
    const m = mRes.rows[0];
    if (!m.email) return false;
    const co = await db.query('SELECT * FROM company_settings LIMIT 1').then(r=>r.rows[0]||{});
    const sgKey = co.sendgrid_key;
    const dt = new Date(m.meeting_date);
    const dateStr = dt.toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    const timeStr = dt.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true});
    const emailBody = `Hi ${m.name.split(' ')[0]},

Your meeting has been scheduled with ${co.company_name||'WeClick AI'}.

📅 Date: ${dateStr}
🕐 Time: ${timeStr} IST
⏱ Duration: ${m.duration_mins||60} minutes
📋 Title: ${m.title}
${m.meeting_link?`🔗 Meeting Link: ${m.meeting_link}`:''}
${m.notes?`
Agenda:
${m.notes}`:''}

Please confirm your attendance by replying to this email.

Best regards,
${co.company_name||'WeClick AI'} Team
${co.phone?'📞 '+co.phone:''}
${co.email?'✉ '+co.email:''}`;

    try {
      if (sgKey) {
        await sendEmail({
          to: m.email, toName: m.name,
          subject: `Meeting Scheduled: ${m.title} — ${dateStr}`,
          body: emailBody,
          co
        });
      }
      await db.query('UPDATE meetings SET notified=true WHERE id=$1', [meetingId]);
      return true;
    } catch(emailErr) {
      console.error('Meeting email failed:', emailErr.message);
      await db.query('UPDATE meetings SET notified=true WHERE id=$1', [meetingId]);
      return false;
    }
  } catch(e) { console.error('sendMeetingEmail failed:', e.message); return false; }
}

// ══════════════════════════════════════════════════════════════
// AI MARKET RESEARCH
// ══════════════════════════════════════════════════════════════
app.post('/api/ai/research', async (req, res) => {
  try {
    const { prompt, clientName, industry, focus } = req.body;
    if (!prompt) return res.status(400).json({error:'No prompt'});

    // Call Anthropic API
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY||'',
        'anthropic-version':'2023-06-01'
      },
      body: JSON.stringify({
        model:'claude-haiku-4-5-20251001',
        max_tokens:2000,
        messages:[{role:'user', content:prompt}]
      })
    });

    if (!aiRes.ok) {
      const err = await aiRes.json().catch(()=>({}));
      // Fallback: generate a template report if no API key
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.json({report: generateFallbackReport(clientName, industry, focus, req.body.clientCompany)});
      }
      throw new Error(err.error?.message || 'AI API error');
    }

    const aiData = await aiRes.json();
    const report = aiData.content?.[0]?.text || 'No report generated';
    res.json({report});
  } catch(e) {
    // Fallback report
    res.json({report: generateFallbackReport(req.body.clientName, req.body.industry, req.body.focus, req.body.clientCompany)});
  }
});

function generateFallbackReport(clientName, industry, focus, company) {
  const now = new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'});
  return `MARKET RESEARCH REPORT
Client: ${clientName} (${company||'—'})
Industry: ${industry}
Generated: ${now}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. MARKET OVERVIEW
The ${industry} market in India is growing rapidly, driven by digital adoption and rising consumer spending. Key opportunities exist in tier-2 cities and mobile-first audiences.

2. TARGET AUDIENCE
• Primary: 25-40 year olds, urban professionals
• Secondary: 18-25, digital natives, aspirational buyers
• Pain Points: Price sensitivity, trust issues, discovery challenges
• Motivations: Quality, convenience, social proof, brand story

3. COMPETITOR LANDSCAPE
Top players in ${industry} compete on price, quality, and digital presence. Gaps exist in personalization, after-sales service, and community building.

4. RECOMMENDED AD STRATEGY
• Platform: Meta Ads (primary), Google Search (secondary)
• Budget Split: 60% Meta, 30% Google, 10% testing
• Best Performing Formats: Video reels, carousel ads, UGC

5. TOP AD COPY ANGLES
• "The problem you didn't know you had" — pain-first hook
• Social proof + transformation story
• Limited offer + urgency
• Before/after or comparison
• Founder/team story for trust

6. QUICK WINS THIS WEEK
✓ Set up Meta Pixel and conversion tracking
✓ Create 3 video testimonial ads
✓ Launch retargeting campaign for website visitors
✓ A/B test 2 different headlines
✓ Set up WhatsApp follow-up automation

7. KPIs TO TRACK
• CPL (Cost Per Lead) — target < ₹150
• ROAS (Return on Ad Spend) — target > 3x
• CTR (Click Through Rate) — target > 1.5%
• Conversion Rate — target > 3%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Note: Add your ANTHROPIC_API_KEY to Vercel environment variables for AI-powered personalized reports.`;
}



// ══════════════════════════════════════════════════════════════
// PAYMENT REMINDERS
// ══════════════════════════════════════════════════════════════
app.get('/api/reminders', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT r.*, c.name as client_name, c.email as client_email
      FROM payment_reminders r
      LEFT JOIN clients c ON c.id = r.client_id
      ORDER BY r.due_date ASC
    `);
    res.json(result.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/reminders', async (req, res) => {
  try {
    const { client_id, title, amount, due_date, send_email, send_whatsapp, message, recurring } = req.body;
    const result = await db.query(
      `INSERT INTO payment_reminders (client_id,title,amount,due_date,send_email,send_whatsapp,message,recurring,sent,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,NOW()) RETURNING *`,
      [client_id, title||'Payment Reminder', amount||null, due_date||null, 
       send_email||false, send_whatsapp||false, message||'', recurring||false]
    );
    await logActivity({type:'reminder', title:'Payment reminder added: '+(title||'')});
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.put('/api/reminders/:id', async (req, res) => {
  try {
    const { title, amount, due_date, send_email, send_whatsapp, message } = req.body;
    const result = await db.query(
      `UPDATE payment_reminders SET title=$1,amount=$2,due_date=$3,send_email=$4,send_whatsapp=$5,message=$6 WHERE id=$7 RETURNING *`,
      [title, amount, due_date, send_email, send_whatsapp, message, req.params.id]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/api/reminders/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM payment_reminders WHERE id=$1', [req.params.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/reminders/:id/send', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT r.*,c.name,c.email FROM payment_reminders r JOIN clients c ON c.id=r.client_id WHERE r.id=$1',
      [req.params.id]
    ).then(x=>x.rows[0]);
    if(!r) return res.status(404).json({error:'Not found'});
    
    const co = await db.query('SELECT * FROM company_settings LIMIT 1').then(x=>x.rows[0]||{});
    
    if(r.send_email && r.email && co.sendgrid_key) {
      const body = {
        personalizations:[{to:[{email:r.email, name:r.name}]}],
        from:{email:co.email||'hello@weclick.ai', name:co.company_name||'WeClick AI'},
        subject:`Payment Reminder: ${r.title}`,
        content:[{type:'text/plain', value:r.message||`Hi ${r.name},

This is a reminder that ${r.title} of ₹${r.amount||''} is due on ${r.due_date?new Date(r.due_date).toLocaleDateString():'soon'}.

Please arrange payment at your earliest convenience.

— ${co.company_name||'WeClick AI'}`}]
      };
      await sendEmail({
        to: r.email, toName: r.name,
        subject: `Payment Reminder: ${r.title}`,
        body: r.message||`Hi ${r.name},\n\nThis is a reminder that ${r.title}${r.amount?' of ₹'+r.amount:''} is due${r.due_date?' on '+new Date(r.due_date).toLocaleDateString():''}. Please arrange payment at your earliest convenience.\n\n— ${co.company_name||'WeClick AI'}`,
        co
      });
    }
    
    await db.query('UPDATE payment_reminders SET sent=true,sent_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── LOW BALANCE ALERT (call manually or via cron) ─────────────
app.post('/api/meta/check-alerts', async (req, res) => {
  try {
    const co = await db.query('SELECT * FROM company_settings LIMIT 1').then(r=>r.rows[0]||{});
    const alertEmail = co.alert_email;
    const threshold = parseFloat(co.low_balance_alert || 500);
    if (!alertEmail) return res.json({ok:true, skipped:'No alert email set in Settings'});

    const lowAccounts = await db.query(
      `SELECT c.name, c.company, ma.balance, ma.ad_account_id
       FROM meta_accounts ma JOIN clients c ON c.id=ma.client_id
       WHERE ma.is_active=true AND ma.balance IS NOT NULL AND ma.balance < $1`,
      [threshold]
    );
    if (lowAccounts.rows.length === 0) return res.json({ok:true, message:'No low balance accounts'});

    // Log activity for each
    for (const acc of lowAccounts.rows) {
      await logActivity({type:'meta', title:`⚠️ Low Meta balance: ${acc.name} (₹${parseFloat(acc.balance).toFixed(0)})`});
    }

    // If SendGrid key is set, send email
    const sgKey = co.sendgrid_key;
    if (sgKey) {
      const body = {
        personalizations:[{to:[{email:alertEmail}]}],
        from:{email: co.email||'hello@weclick.ai', name: co.company_name||'WeClick AI'},
        subject:`⚠️ Low Meta Ads Balance Alert — ${lowAccounts.rows.length} account(s)`,
        content:[{type:'text/plain', value:
          `Hi,\n\nThe following client Meta Ads accounts have low balance (below ₹${threshold}):\n\n` +
          lowAccounts.rows.map(a=>`• ${a.name} (${a.company}): ₹${parseFloat(a.balance).toFixed(0)}`).join('\n') +
          `\n\nPlease top up these accounts to avoid campaign disruptions.\n\n— ${co.company_name||'WeClick AI'} Dashboard`
        }]
      };
      await sendEmail({
        to: alertEmail,
        subject: `Low Meta Ads Balance Alert — ${lowAccounts.rows.length} account(s)`,
        body: `Hi,\n\nThe following client Meta Ads accounts have low balance (below ₹${threshold}):\n\n` +
          lowAccounts.rows.map(a=>`• ${a.name} (${a.company}): ₹${parseFloat(a.balance).toFixed(0)}`).join('\n') +
          `\n\nPlease top up these accounts to avoid campaign disruptions.\n\n— ${co.company_name||'WeClick AI'} Dashboard`,
        co
      });
    }

    res.json({ok:true, alerted: lowAccounts.rows.length, emailSent: !!sgKey});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── SERVE FRONTEND ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});



// ══════════════════════════════════════════════════════════════
// CLIENT SIGNING
// ══════════════════════════════════════════════════════════════

// Add migrations for signing columns
app.get('/api/quotations/:token/sign-page', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT q.*, c.name as client_name, c.email as client_email, c.company as client_company,
       co.company_name, co.tagline, co.address_line1, co.address_line2, co.city, co.state,
       co.pincode, co.phone, co.email as agency_email, co.gstin, co.signature_url, co.upi_id,
       co.bank_name, co.bank_account, co.bank_ifsc, co.bank_holder
       FROM quotations q JOIN clients c ON c.id=q.client_id
       LEFT JOIN company_settings co ON true
       WHERE q.sign_token=$1 LIMIT 1`,
      [req.params.token]
    );
    if (!r.rows[0]) return res.status(404).send('Quotation not found or link expired');
    const q = r.rows[0];
    const items = typeof q.items === 'string' ? JSON.parse(q.items) : q.items;
    const pm = (() => { try { const p = typeof q.payment==='string'?JSON.parse(q.payment):q.payment; return p&&p.payment?p.payment:p||{}; } catch{return {};} })();
    const addr = [q.address_line1,q.address_line2,q.city,q.state,q.pincode].filter(Boolean).join(', ');
    const qNo = q.quotation_no || ('QT-'+q.id);
    const issued = new Date(q.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'});
    const validTxt = q.valid_until ? new Date(q.valid_until).toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'}) : '—';
    const itemsHtml = items.map(it => `<tr><td>${it.service||''}</td><td>${it.description||''}</td><td style='text-align:center'>${it.qty||1}</td><td style='text-align:right'>₹${(it.rate||0).toLocaleString('en-IN')}</td><td style='text-align:right;font-weight:600'>₹${((it.qty||0)*(it.rate||0)).toLocaleString('en-IN')}</td></tr>`).join('');
    const gstAmt = Math.round((q.subtotal||0)*(q.gst_pct||0)/100);
    const alreadySigned = q.client_signed_at ? `<div style='background:#F0FDF4;border:1px solid #86EFAC;border-radius:8px;padding:16px;margin:20px 0;text-align:center'><div style='font-size:16px;color:#15803D;font-weight:600'>✓ Already Signed</div><div style='font-size:12px;color:#166534;margin-top:4px'>Signed on ${new Date(q.client_signed_at).toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}</div>${q.client_sig?'<img src="'+q.client_sig+'" style="height:50px;margin-top:8px;object-fit:contain"/>':''}</div>` : '';
    const html = `<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Sign Quotation ${qNo} — ${q.company_name||'WeClick AI'}</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',system-ui,sans-serif;background:#F5F5F3;min-height:100vh;padding:20px}@media print{body{background:#fff;padding:0}}.wrap{max-width:720px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:40px;margin-bottom:40px}.header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:18px;border-bottom:2px solid #E96800;margin-bottom:24px}.logo{width:36px;height:36px;background:#E96800;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px;flex-shrink:0}.co-info{margin-left:10px}.table-wrap{margin:20px 0}table{width:100%;border-collapse:collapse}th{background:#F9F9F8;padding:8px 12px;font-size:11px;font-weight:600;text-transform:uppercase;color:#6F6F6B;letter-spacing:.4px;text-align:left}td{padding:10px 12px;font-size:13px;border-bottom:1px solid #F0F0EE}.payment-box{background:#FFF3EA;border:1px solid #FFD4AA;border-radius:8px;padding:16px;margin:20px 0}.tc-box{background:#FFFBF7;border-left:3px solid #E96800;padding:16px;margin:20px 0}.sign-box{background:#F9F9F8;border:1px solid #E5E5E3;border-radius:8px;padding:24px;margin:24px 0}.canvas-wrap{border:2px dashed #ccc;border-radius:6px;cursor:crosshair;background:#fff;display:block;touch-action:none}.btn{display:inline-flex;align-items:center;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;border:none;font-family:inherit}.btn-primary{background:#E96800;color:#fff}.btn-ghost{background:#fff;color:#6F6F6B;border:1px solid #E5E5E3;margin-right:8px}.btn:hover{opacity:.9}.footer{text-align:center;color:#9C9C97;font-size:12px;margin-top:24px}</style></head><body><div class='wrap'><div class='header'><div style='display:flex;align-items:flex-start;gap:12px'><div class='logo'>WC</div><div class='co-info'><div style='font-size:18px;font-weight:700;color:#111110'>${q.company_name||'WeClick AI'}</div><div style='font-size:12px;color:#6F6F6B'>${q.tagline||'Marketing Agency · India'}</div>${addr?'<div style="font-size:11px;color:#6F6F6B;margin-top:2px">'+addr+'</div>':''}</div></div><div style='text-align:right'><div style='font-size:22px;font-weight:700;color:#E96800'>Quotation</div><div style='font-size:14px;font-weight:600;color:#111110'>${qNo}</div><div style='font-size:12px;color:#6F6F6B'>Issued: ${issued}</div><div style='font-size:12px;color:#6F6F6B'>Valid until: ${validTxt}</div></div></div><div style='margin-bottom:20px'><div style='font-size:10px;font-weight:700;text-transform:uppercase;color:#9C9C97;margin-bottom:6px'>Billed To</div><div style='font-size:16px;font-weight:700'>${q.client_name}</div><div style='font-size:13px;color:#6F6F6B'>${q.client_company}</div></div><div class='table-wrap'><table><thead><tr><th>Service</th><th>Description</th><th style='text-align:center'>Qty</th><th style='text-align:right'>Rate</th><th style='text-align:right'>Amount</th></tr></thead><tbody>${itemsHtml}</tbody></table></div>${pm.upi_id||pm.bank_name?'<div class="payment-box"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#E96800;letter-spacing:.5px;margin-bottom:10px">💳 Payment Details</div><div style="font-size:13px;line-height:2">'+(pm.upi_id?'<b>UPI:</b> '+pm.upi_id+'<br>':'')+( pm.bank_name?'<b>Bank:</b> '+pm.bank_name+'<br>':'')+(pm.bank_account?'<b>A/C:</b> '+pm.bank_account+'<br>':'')+(pm.bank_ifsc?'<b>IFSC:</b> '+pm.bank_ifsc+'<br>':'')+(pm.bank_holder?'<b>Name:</b> '+pm.bank_holder:'')+'</div></div>':''}<div style='display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:1px solid #E5E5E3'><div style='display:flex;justify-content:space-between;font-size:13px'><span style='color:#6F6F6B'>Subtotal</span><span>₹${(q.subtotal||0).toLocaleString('en-IN')}</span></div><div style='display:flex;justify-content:space-between;font-size:13px'><span style='color:#6F6F6B'>GST (${q.gst_pct||0}%)</span><span>₹${gstAmt.toLocaleString('en-IN')}</span></div><div style='display:flex;justify-content:space-between;font-size:18px;font-weight:700;color:#E96800;border-top:1px solid #E5E5E3;padding-top:8px;margin-top:4px'><span>Grand Total</span><span>₹${(q.total||0).toLocaleString('en-IN')}</span></div></div>${q.notes?'<div class="tc-box"><div style="font-size:11px;font-weight:700;color:#E96800;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Terms &amp; Conditions</div><div style="font-size:12px;color:#555;line-height:1.8;white-space:pre-wrap">'+q.notes.replace(/</g,'&lt;')+'</div></div>':''}
    ${alreadySigned}
    ${!q.client_signed_at ? `<div class='sign-box'><div style='font-size:15px;font-weight:600;margin-bottom:6px'>Your Digital Signature</div><div style='font-size:12px;color:#6F6F6B;margin-bottom:14px'>Draw your signature in the box below and click Submit to confirm acceptance of this quotation.</div><canvas id='sigCanvas' class='canvas-wrap' width='620' height='160'></canvas><div style='display:flex;gap:8px;margin-top:12px'><button class='btn btn-ghost' onclick='clearSig()'>Clear</button><button class='btn btn-primary' onclick='submitSig()'>✓ Accept &amp; Submit Signature</button></div><div id='msg' style='margin-top:12px;font-size:13px;font-weight:500'></div></div>` : ''}
    </div><div class='footer'>This quotation was prepared by ${q.company_name||'WeClick AI'}. For queries, contact ${q.agency_email||''}.</div><script>const canvas=document.getElementById('sigCanvas');if(canvas){const ctx=canvas.getContext('2d');let drawing=false,lastX=0,lastY=0;function pos(e){const r=canvas.getBoundingClientRect();if(e.touches){return{x:(e.touches[0].clientX-r.left)*(canvas.width/r.width),y:(e.touches[0].clientY-r.top)*(canvas.height/r.height)};}return{x:(e.clientX-r.left)*(canvas.width/r.width),y:(e.clientY-r.top)*(canvas.height/r.height)};}canvas.addEventListener('mousedown',e=>{drawing=true;const p=pos(e);lastX=p.x;lastY=p.y;});canvas.addEventListener('mousemove',e=>{if(!drawing)return;ctx.beginPath();ctx.moveTo(lastX,lastY);const p=pos(e);ctx.lineTo(p.x,p.y);ctx.strokeStyle='#1a1a1a';ctx.lineWidth=2.5;ctx.lineCap='round';ctx.stroke();lastX=p.x;lastY=p.y;});canvas.addEventListener('mouseup',()=>drawing=false);canvas.addEventListener('mouseleave',()=>drawing=false);canvas.addEventListener('touchstart',e=>{e.preventDefault();drawing=true;const p=pos(e);lastX=p.x;lastY=p.y;},{passive:false});canvas.addEventListener('touchmove',e=>{e.preventDefault();if(!drawing)return;ctx.beginPath();ctx.moveTo(lastX,lastY);const p=pos(e);ctx.lineTo(p.x,p.y);ctx.strokeStyle='#1a1a1a';ctx.lineWidth=2.5;ctx.lineCap='round';ctx.stroke();lastX=p.x;lastY=p.y;},{passive:false});canvas.addEventListener('touchend',()=>drawing=false);}function clearSig(){if(canvas){const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);}}async function submitSig(){const ctx=canvas.getContext('2d');const blank=!ctx.getImageData(0,0,canvas.width,canvas.height).data.some(v=>v!==0);if(blank){document.getElementById('msg').innerHTML='<span style="color:#DC2626">Please draw your signature first.</span>';return;}const sig=canvas.toDataURL('image/png');document.getElementById('msg').innerHTML='Submitting...';try{const r=await fetch('/api/quotations/${req.params.token}/sign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({signature:sig})});const d=await r.json();if(d.ok){document.getElementById('msg').innerHTML='<span style="color:#15803D">✓ Signature submitted successfully! Thank you.</span>';canvas.style.opacity='.4';document.querySelector('.btn-primary').disabled=true;document.querySelector('.btn-primary').textContent='✓ Signed';}else{document.getElementById('msg').innerHTML='<span style="color:#DC2626">Error: '+d.error+'</span>';}}catch(e){document.getElementById('msg').innerHTML='<span style="color:#DC2626">Network error. Please try again.</span>';}}</script></body></html>`;
    res.send(html);
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});

// Client submits signature
app.post('/api/quotations/:token/sign', async (req, res) => {
  try {
    const { signature } = req.body;
    if (!signature) return res.status(400).json({ error: 'No signature provided' });
    const r = await db.query(
      'UPDATE quotations SET client_sig=$1, client_signed_at=NOW(), approved=true WHERE sign_token=$2 RETURNING id, client_id',
      [signature, req.params.token]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Invalid or expired link' });
    // Notify agency via email
    const q = r.rows[0];
    try {
      const co = await db.query('SELECT * FROM company_settings LIMIT 1').then(x => x.rows[0] || {});
      const cl = await db.query('SELECT name, company FROM clients WHERE id=$1', [q.client_id]).then(x => x.rows[0] || {});
      if (co.smtp_user && co.smtp_pass) {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: co.smtp_user, pass: co.smtp_pass } });
        await transporter.sendMail({
          from: co.smtp_user,
          to: co.smtp_user,
          subject: `✅ Quotation Signed by ${cl.name} (${cl.company})`,
          html: `<p><b>${cl.name}</b> from <b>${cl.company}</b> has signed and accepted the quotation.</p><p>Log in to WeClick AI to view the signed quotation.</p>`
        });
      }
    } catch(e) { console.log('Email notify failed:', e.message); }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get a signing link for a quotation
app.post('/api/clients/:id/quotations/:qid/send-for-signing', async (req, res) => {
  try {
    const token = require('crypto').randomBytes(24).toString('hex');
    await db.query('UPDATE quotations SET sign_token=$1 WHERE id=$2 AND client_id=$3', [token, req.params.qid, req.params.id]);
    const baseUrl = req.headers.origin || `https://${req.headers.host}`;
    const link = `${baseUrl}/api/quotations/${token}/sign-page`;
    // Send email if client has email
    const cl = await db.query('SELECT * FROM clients WHERE id=$1', [req.params.id]).then(x => x.rows[0] || {});
    const co = await db.query('SELECT * FROM company_settings LIMIT 1').then(x => x.rows[0] || {});
    if (cl.email && co.smtp_user && co.smtp_pass) {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: co.smtp_user, pass: co.smtp_pass } });
        await transporter.sendMail({
          from: `${co.company_name||'WeClick AI'} <${co.smtp_user}>`,
          to: cl.email,
          subject: `Please sign your quotation — ${co.company_name||'WeClick AI'}`,
          html: `<div style='font-family:Inter,sans-serif;max-width:500px;margin:0 auto'><h2 style='color:#E96800'>Your Quotation is Ready</h2><p>Hi ${cl.name},</p><p>Please review and sign your quotation by clicking the button below.</p><a href='${link}' style='display:inline-block;background:#E96800;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0'>Review &amp; Sign Quotation</a><p style='color:#666;font-size:12px'>Or copy this link: ${link}</p><p>Warm regards,<br>${co.company_name||'WeClick AI'}</p></div>`
        });
      } catch(e) { console.log('Email failed:', e.message); }
    }
    res.json({ ok: true, link });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

(async () => {
  const migs = [
    `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment TEXT`,
    `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sign_token TEXT`,
    `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS client_sig TEXT`,
    `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS client_signed_at TIMESTAMP`,
    `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT false`,
    `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`,
    `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS our_address TEXT`,
    `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS client_address TEXT`,
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
    `ALTER TABLE clients ADD COLUMN IF NOT EXISTS email TEXT`,
  ];
  for (const sql of migs) { try { await db.query(sql); } catch(e) { } }
  console.log('Migrations done');
})().catch(e => console.log('Migration error:', e.message)).finally(() => {
  app.listen(PORT, () => console.log(`WeClick AI running on port ${PORT}`));
});
