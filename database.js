const { Pool, types } = require('pg');

types.setTypeParser(20,   val => parseInt(val, 10));
types.setTypeParser(1700, val => parseFloat(val));
types.setTypeParser(700,  val => parseFloat(val));
types.setTypeParser(701,  val => parseFloat(val));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id               SERIAL PRIMARY KEY,
        name             TEXT NOT NULL,
        company          TEXT NOT NULL,
        email            TEXT,
        status           TEXT DEFAULT 'Active',
        revenue          NUMERIC DEFAULT 0,
        spend            NUMERIC DEFAULT 0,
        profit           NUMERIC DEFAULT 0,
        expected_revenue NUMERIC DEFAULT 0,
        color            TEXT DEFAULT '#FF6A00',
        avatar_url       TEXT,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS campaigns (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        client_id  INT REFERENCES clients(id) ON DELETE CASCADE,
        channel    TEXT NOT NULL,
        budget     NUMERIC DEFAULT 0,
        spend      NUMERIC DEFAULT 0,
        status     TEXT DEFAULT 'Draft',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS automations (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        client_id  INT REFERENCES clients(id) ON DELETE CASCADE,
        status     TEXT DEFAULT 'Running',
        notes      TEXT,
        revenue    NUMERIC DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS collaborations (
        id         SERIAL PRIMARY KEY,
        partner    TEXT NOT NULL,
        revenue    NUMERIC DEFAULT 0,
        status     TEXT DEFAULT 'Active',
        notes      TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS revenue_entries (
        id         SERIAL PRIMARY KEY,
        client_id  INT REFERENCES clients(id) ON DELETE SET NULL,
        amount     NUMERIC NOT NULL,
        date       TEXT NOT NULL,
        source     TEXT DEFAULT 'manual',
        notes      TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS users (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        email      TEXT UNIQUE,
        role       TEXT DEFAULT 'member',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id         SERIAL PRIMARY KEY,
        user_id    INT REFERENCES users(id) ON DELETE CASCADE,
        type       TEXT NOT NULL CHECK(type IN ('income','expense')),
        category   TEXT DEFAULT 'Other',
        amount     NUMERIC NOT NULL,
        date       TEXT NOT NULL,
        notes      TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS salaries (
        id         SERIAL PRIMARY KEY,
        user_id    INT REFERENCES users(id) ON DELETE CASCADE,
        amount     NUMERIC NOT NULL,
        date       TEXT NOT NULL,
        notes      TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS client_files (
        id          SERIAL PRIMARY KEY,
        client_id   INT REFERENCES clients(id) ON DELETE CASCADE,
        file_name   TEXT NOT NULL,
        file_url    TEXT NOT NULL,
        file_size   TEXT,
        file_type   TEXT DEFAULT 'report',
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS meta_spend (
        id            SERIAL PRIMARY KEY,
        campaign_name TEXT,
        spend         NUMERIC DEFAULT 0,
        date          TEXT,
        synced_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS quotations (
        id           SERIAL PRIMARY KEY,
        client_id    INT REFERENCES clients(id) ON DELETE CASCADE,
        quotation_no TEXT,
        items        TEXT NOT NULL,
        subtotal     NUMERIC DEFAULT 0,
        gst_pct      NUMERIC DEFAULT 18,
        gst_amount   NUMERIC DEFAULT 0,
        total        NUMERIC DEFAULT 0,
        notes        TEXT,
        valid_until  TEXT,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS content_tasks (
        id           SERIAL PRIMARY KEY,
        client_id    INT REFERENCES clients(id) ON DELETE CASCADE,
        date         TEXT NOT NULL,
        platform     TEXT NOT NULL,
        content_type TEXT NOT NULL,
        notes        TEXT,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS client_meta_accounts (
        id                SERIAL PRIMARY KEY,
        client_id         INT UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
        ad_account_id     TEXT NOT NULL,
        access_token      TEXT NOT NULL,
        daily_budget      NUMERIC DEFAULT 0,
        total_funds       NUMERIC DEFAULT 0,
        alert_threshold   NUMERIC DEFAULT 1000,
        balance           NUMERIC,
        currency          TEXT DEFAULT 'INR',
        balance_synced_at TIMESTAMP,
        is_active         INT DEFAULT 1,
        last_synced       TIMESTAMP,
        created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS client_meta_metrics (
        id          SERIAL PRIMARY KEY,
        client_id   INT REFERENCES clients(id) ON DELETE CASCADE,
        date        TEXT NOT NULL,
        spend       NUMERIC DEFAULT 0,
        impressions INT DEFAULT 0,
        clicks      INT DEFAULT 0,
        ctr         NUMERIC DEFAULT 0,
        cpc         NUMERIC DEFAULT 0,
        reach       INT DEFAULT 0,
        leads       INT DEFAULT 0,
        roas        NUMERIC DEFAULT 0,
        synced_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const migrations = [
      `ALTER TABLE clients ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
      `ALTER TABLE clients ADD COLUMN IF NOT EXISTS email TEXT`,
      `ALTER TABLE client_meta_accounts ADD COLUMN IF NOT EXISTS total_funds NUMERIC DEFAULT 0`,
      `ALTER TABLE client_meta_accounts ADD COLUMN IF NOT EXISTS alert_threshold NUMERIC DEFAULT 1000`,
      `ALTER TABLE client_meta_accounts ADD COLUMN IF NOT EXISTS balance NUMERIC`,
      `ALTER TABLE client_meta_accounts ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR'`,
      `ALTER TABLE client_meta_accounts ADD COLUMN IF NOT EXISTS balance_synced_at TIMESTAMP`,
    ];
    for (const sql of migrations) {
      await client.query(sql).catch(() => {});
    }

    const { rows } = await client.query('SELECT COUNT(*) as count FROM clients');
    if (parseInt(rows[0].count) === 0 && process.env.SEED_DEMO !== 'false') {
      try {
        const u1 = (await client.query('INSERT INTO users (name,email,role) VALUES ($1,$2,$3) RETURNING id', ['Arjun Kapoor','arjun@weclick.ai','owner'])).rows[0].id;
        const u2 = (await client.query('INSERT INTO users (name,email,role) VALUES ($1,$2,$3) RETURNING id', ['Siya Verma','siya@weclick.ai','manager'])).rows[0].id;
        const u3 = (await client.query('INSERT INTO users (name,email,role) VALUES ($1,$2,$3) RETURNING id', ['Karan Singh','karan@weclick.ai','analyst'])).rows[0].id;

        const c1 = (await client.query('INSERT INTO clients (name,company,status,revenue,spend,profit,expected_revenue,color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', ['Priya Sharma','Growfast Retail','Active',316400,89000,227400,380000,'#FF6A00'])).rows[0].id;
        const c2 = (await client.query('INSERT INTO clients (name,company,status,revenue,spend,profit,expected_revenue,color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', ['Ravi Mehta','TechNova Labs','Active',245000,72000,173000,290000,'#3B82F6'])).rows[0].id;
        const c3 = (await client.query('INSERT INTO clients (name,company,status,revenue,spend,profit,expected_revenue,color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', ['Ananya Iyer','StyleHive','Active',198500,58000,140500,210000,'#10B981'])).rows[0].id;
        const c4 = (await client.query('INSERT INTO clients (name,company,status,revenue,spend,profit,expected_revenue,color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', ['Suresh Kumar','FoodBox India','Paused',145000,51000,94000,160000,'#8B5CF6'])).rows[0].id;
        const c5 = (await client.query('INSERT INTO clients (name,company,status,revenue,spend,profit,expected_revenue,color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', ['Neha Gupta','EduSpark','Active',82000,38000,44000,95000,'#F59E0B'])).rows[0].id;

        await client.query('INSERT INTO campaigns (name,client_id,channel,budget,spend,status) VALUES ($1,$2,$3,$4,$5,$6)', ['Diwali Mega Sale',c1,'Meta Ads',120000,89000,'Active']);
        await client.query('INSERT INTO campaigns (name,client_id,channel,budget,spend,status) VALUES ($1,$2,$3,$4,$5,$6)', ['Product Launch Q2',c2,'Google Ads',80000,72000,'Active']);
        await client.query('INSERT INTO campaigns (name,client_id,channel,budget,spend,status) VALUES ($1,$2,$3,$4,$5,$6)', ['Brand Awareness',c3,'Instagram',60000,42000,'Active']);
        await client.query('INSERT INTO campaigns (name,client_id,channel,budget,spend,status) VALUES ($1,$2,$3,$4,$5,$6)', ['Summer Campaign',c4,'Meta Ads',55000,51000,'Paused']);
        await client.query('INSERT INTO campaigns (name,client_id,channel,budget,spend,status) VALUES ($1,$2,$3,$4,$5,$6)', ['Admission Drive',c5,'LinkedIn',40000,28000,'Draft']);

        await client.query('INSERT INTO automations (name,client_id,status,notes,revenue) VALUES ($1,$2,$3,$4,$5)', ['Lead Follow-up Bot',c1,'Running','WhatsApp + Email sequence',28000]);
        await client.query('INSERT INTO automations (name,client_id,status,notes,revenue) VALUES ($1,$2,$3,$4,$5)', ['Retargeting Flow',c2,'Running','7-day cart abandon',22000]);
        await client.query('INSERT INTO automations (name,client_id,status,notes,revenue) VALUES ($1,$2,$3,$4,$5)', ['Review Collector',c3,'Paused','Post-purchase review ask',15000]);
        await client.query('INSERT INTO automations (name,client_id,status,notes,revenue) VALUES ($1,$2,$3,$4,$5)', ['Appointment Bot',c5,'Running','Demo booking automation',18000]);

        await client.query('INSERT INTO collaborations (partner,revenue,status,notes) VALUES ($1,$2,$3,$4)', ['Digital Nest Agency',95000,'Active','White-label campaigns']);
        await client.query('INSERT INTO collaborations (partner,revenue,status,notes) VALUES ($1,$2,$3,$4)', ['Spark Creative Studio',68000,'Active','Content production']);
        await client.query('INSERT INTO collaborations (partner,revenue,status,notes) VALUES ($1,$2,$3,$4)', ['GrowthHackers Co.',42000,'Ended','SEO project Q1']);

        await client.query('INSERT INTO revenue_entries (client_id,amount,date,source,notes) VALUES ($1,$2,$3,$4,$5)', [c1,50000,'2025-04-10','manual','Strategy consulting']);
        await client.query('INSERT INTO revenue_entries (client_id,amount,date,source,notes) VALUES ($1,$2,$3,$4,$5)', [c3,35000,'2025-04-18','manual','Monthly retainer']);

        await client.query('INSERT INTO transactions (user_id,type,category,amount,date) VALUES ($1,$2,$3,$4,$5)', [u1,'income','Salary',85000,'2025-04-01']);
        await client.query('INSERT INTO transactions (user_id,type,category,amount,date) VALUES ($1,$2,$3,$4,$5)', [u1,'expense','Software',12000,'2025-04-05']);
        await client.query('INSERT INTO transactions (user_id,type,category,amount,date) VALUES ($1,$2,$3,$4,$5)', [u2,'income','Bonus',30000,'2025-04-08']);
        await client.query('INSERT INTO transactions (user_id,type,category,amount,date) VALUES ($1,$2,$3,$4,$5)', [u1,'expense','Travel',8500,'2025-04-12']);
        await client.query('INSERT INTO transactions (user_id,type,category,amount,date) VALUES ($1,$2,$3,$4,$5)', [u2,'expense','Equipment',22000,'2025-04-15']);

        await client.query('INSERT INTO salaries (user_id,amount,date,notes) VALUES ($1,$2,$3,$4)', [u1,85000,'2025-04-01','April salary']);
        await client.query('INSERT INTO salaries (user_id,amount,date,notes) VALUES ($1,$2,$3,$4)', [u2,65000,'2025-04-01','April salary']);
        await client.query('INSERT INTO salaries (user_id,amount,date,notes) VALUES ($1,$2,$3,$4)', [u3,55000,'2025-04-01','April salary']);

        console.log('✅ Database seeded');
      } catch (err) {
        console.error('❌ Seed failed:', err.message);
      }
    }

    console.log('✅ PostgreSQL schema ready');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
