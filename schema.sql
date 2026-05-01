-- WeClick AI Dashboard — Full Schema
-- Run this once after connecting your PostgreSQL database

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(50) DEFAULT 'team',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  company VARCHAR(100) NOT NULL,
  status VARCHAR(20) DEFAULT 'Active' CHECK (status IN ('Active', 'Paused', 'Inactive')),
  revenue NUMERIC(12,2) DEFAULT 0,
  spend NUMERIC(12,2) DEFAULT 0,
  profit NUMERIC(12,2) DEFAULT 0,
  expected_revenue NUMERIC(12,2) DEFAULT 0,
  color VARCHAR(7) DEFAULT '#FF6A00',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  channel VARCHAR(50) NOT NULL,
  budget NUMERIC(12,2) DEFAULT 0,
  spend NUMERIC(12,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'Active' CHECK (status IN ('Active', 'Paused', 'Draft', 'Ended')),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS automations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'Running' CHECK (status IN ('Running', 'Paused', 'Stopped')),
  notes TEXT,
  revenue NUMERIC(12,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collaborations (
  id SERIAL PRIMARY KEY,
  partner VARCHAR(150) NOT NULL,
  revenue NUMERIC(12,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'Active' CHECK (status IN ('Active', 'Ended', 'Pending')),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS revenue (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  date DATE NOT NULL,
  source VARCHAR(20) DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meta_spend (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  spend NUMERIC(12,2) DEFAULT 0,
  date DATE NOT NULL,
  synced_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_files (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  file_url TEXT NOT NULL,
  file_size VARCHAR(20),
  file_type VARCHAR(30) DEFAULT 'report' CHECK (file_type IN ('calendar', 'quotation', 'creative', 'report', 'other')),
  uploaded_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(10) NOT NULL CHECK (type IN ('income', 'expense')),
  category VARCHAR(80) NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS salaries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Seed default admin user
INSERT INTO users (name, role) VALUES ('Admin', 'owner') ON CONFLICT DO NOTHING;

-- Seed sample clients
INSERT INTO clients (name, company, status, revenue, spend, profit, expected_revenue, color) VALUES
  ('Priya Sharma',  'Growfast Retail', 'Active',  316400, 89000, 227400, 380000, '#FF6A00'),
  ('Ravi Mehta',    'TechNova Labs',   'Active',  245000, 72000, 173000, 290000, '#3B82F6'),
  ('Ananya Iyer',   'StyleHive',       'Active',  198500, 58000, 140500, 210000, '#10B981'),
  ('Suresh Kumar',  'FoodBox India',   'Paused',  145000, 51000,  94000, 160000, '#8B5CF6'),
  ('Neha Gupta',    'EduSpark',        'Active',   82000, 38000,  44000,  95000, '#F59E0B')
ON CONFLICT DO NOTHING;

-- Seed sample campaigns
INSERT INTO campaigns (name, client_id, channel, budget, spend, status) VALUES
  ('Diwali Mega Sale',    1, 'Meta Ads',   120000, 89000, 'Active'),
  ('Product Launch Q2',   2, 'Google Ads',  80000, 72000, 'Active'),
  ('Brand Awareness',     3, 'Instagram',   60000, 42000, 'Active'),
  ('Summer Campaign',     4, 'Meta Ads',    55000, 51000, 'Paused'),
  ('Admission Drive',     5, 'LinkedIn',    40000, 28000, 'Draft')
ON CONFLICT DO NOTHING;

-- Seed automations
INSERT INTO automations (name, client_id, status, notes, revenue) VALUES
  ('Lead Follow-up Bot',  1, 'Running', 'WhatsApp + Email sequence', 28000),
  ('Retargeting Flow',    2, 'Running', '7-day cart abandon',        22000),
  ('Review Collector',    3, 'Paused',  'Post-purchase review ask',  15000),
  ('Appointment Bot',     5, 'Running', 'Demo booking automation',   18000)
ON CONFLICT DO NOTHING;

-- Seed collaborations
INSERT INTO collaborations (partner, revenue, status, notes) VALUES
  ('Digital Nest Agency',    95000, 'Active', 'White-label campaigns'),
  ('Spark Creative Studio',  68000, 'Active', 'Content production'),
  ('GrowthHackers Co.',      42000, 'Ended',  'SEO project Q1')
ON CONFLICT DO NOTHING;

-- Seed manual revenue
INSERT INTO revenue (client_id, amount, date, source, notes) VALUES
  (1, 50000, '2025-04-10', 'manual', 'Strategy consulting'),
  (3, 35000, '2025-04-18', 'manual', 'Monthly retainer')
ON CONFLICT DO NOTHING;

-- Seed team users
INSERT INTO users (name, role) VALUES
  ('Arjun Kapoor', 'team'),
  ('Siya Verma',   'team'),
  ('Karan Singh',  'team')
ON CONFLICT DO NOTHING;

-- Seed transactions
INSERT INTO transactions (user_id, type, category, amount, date) VALUES
  (1, 'income',  'Salary',    85000, '2025-04-01'),
  (1, 'expense', 'Software',  12000, '2025-04-05'),
  (2, 'income',  'Bonus',     30000, '2025-04-08'),
  (1, 'expense', 'Travel',     8500, '2025-04-12'),
  (2, 'expense', 'Equipment', 22000, '2025-04-15')
ON CONFLICT DO NOTHING;

-- Seed salaries
INSERT INTO salaries (user_id, amount, date, notes) VALUES
  (1, 85000, '2025-04-01', 'April salary'),
  (2, 65000, '2025-04-01', 'April salary'),
  (3, 55000, '2025-04-01', 'April salary')
ON CONFLICT DO NOTHING;
