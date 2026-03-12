'use strict';
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const crypto = require('crypto');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3013;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Claw2026-DeepTx99';
const ADMIN_VAULT_PASSWORD = 'DeepTx-Admin99';
const VAULT_KEY = process.env.VAULT_KEY || crypto.randomBytes(32).toString('hex');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const GCP_PROJECT = 'boxwood-yen-465815-h0';
const GCP_SA_KEY = '/opt/admin/gcp-sa.json';
const CLAWFORGE_IP = '34.10.77.209';
const SSH_KEY = '/home/rod/.ssh/google_compute_engine';

// DB pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Init DB tables
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vault_entries (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        username TEXT,
        password_enc TEXT,
        url TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('DB initialized');
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}

// AES-256 encrypt/decrypt
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(VAULT_KEY.slice(0, 64), 'hex');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return iv.toString('hex') + ':' + enc;
}

function decrypt(enc) {
  if (!enc) return '';
  try {
    const [ivHex, data] = enc.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = Buffer.from(VAULT_KEY.slice(0, 64), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let dec = decipher.update(data, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch { return '[decrypt error]'; }
}

// Run shell command, return promise
function runCmd(cmd, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'fleet-admin' }));

// Login page
app.get('/login', (req, res) => {
  const error = req.query.error ? '<div class="error">Invalid password</div>' : '';
  res.send(loginPage(error));
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Root redirect to dashboard
app.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));

// Dashboard
app.get('/dashboard', requireAuth, (req, res) => res.send(dashboardPage()));

// Vault page
app.get('/vault', requireAuth, (req, res) => res.send(vaultPage()));

// Launcher page
app.get('/launcher', requireAuth, (req, res) => res.send(launcherPage()));

// Infrastructure page
app.get('/infrastructure', requireAuth, (req, res) => res.send(infrastructurePage()));

// === STATUS API ===
// Check service statuses on fleet-vm (local) and clawforge-vm (SSH)
app.get('/api/status', requireAuth, async (req, res) => {
  const fleetServices = [
    'keeper', 'brain', 'detexai', 'bde', 'creator', 'barback',
    'wedding', 'bigfoot', 'bigfoot-backend', 'mop', 'creeksideai',
    'huron', 'lobster', 'netgrapher', 'admin', 'deploy-webhook'
  ];
  const clawforgeServices = [
    'clawforgeai', 'portal', 'clawforge-admin'
  ];

  const checkLocal = async (services) => {
    const results = {};
    await Promise.all(services.map(async svc => {
      try {
        const out = await runCmd(`systemctl is-active ${svc}.service`);
        results[svc] = out === 'active';
      } catch {
        results[svc] = false;
      }
    }));
    return results;
  };

  const checkRemote = async (services) => {
    const results = {};
    const checks = services.map(s => `systemctl is-active ${s}.service`).join('; ');
    try {
      const out = await runCmd(
        `ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=8 rod@${CLAWFORGE_IP} "${checks} ; true"`,
        20000
      );
      const lines = out.split('\n');
      services.forEach((svc, i) => {
        results[svc] = (lines[i] || '').trim() === 'active';
      });
    } catch {
      services.forEach(svc => { results[svc] = null; }); // null = SSH failed
    }
    return results;
  };

  try {
    const [fleetStatus, clawforgeStatus] = await Promise.all([
      checkLocal(fleetServices),
      checkRemote(clawforgeServices)
    ]);
    res.json({ fleet: fleetStatus, clawforge: clawforgeStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === VAULT API ===
app.get('/api/vault', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vault_entries ORDER BY name ASC');
    const isAdmin = req.headers['x-admin-mode'] === '1';
    const entries = result.rows.map(r => ({
      id: r.id,
      name: r.name,
      username: r.username,
      url: r.url,
      notes: r.notes,
      created_at: r.created_at,
      updated_at: r.updated_at,
      // Only return decrypted password if admin mode header present
      password_dec: isAdmin ? decrypt(r.password_enc) : null
    }));
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reveal single password (requires admin mode)
app.get('/api/vault/:id/reveal', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT password_enc FROM vault_entries WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ password: decrypt(result.rows[0].password_enc) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vault', requireAuth, async (req, res) => {
  const { name, username, password, url, notes } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO vault_entries (name, username, password_enc, url, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, username, encrypt(password), url, notes]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/vault/:id', requireAuth, async (req, res) => {
  const { name, username, password, url, notes } = req.body;
  try {
    const result = await pool.query(
      'UPDATE vault_entries SET name=$1, username=$2, password_enc=$3, url=$4, notes=$5, updated_at=NOW() WHERE id=$6 RETURNING *',
      [name, username, encrypt(password), url, notes, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/vault/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM vault_entries WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === GCP SECRET MANAGER API ===
app.get('/api/gcp-secrets', requireAuth, async (req, res) => {
  try {
    const out = await runCmd(
      `GOOGLE_APPLICATION_CREDENTIALS=${GCP_SA_KEY} gcloud secrets list --project=${GCP_PROJECT} --format=json`,
      15000
    );
    let secrets = [];
    try { secrets = JSON.parse(out); } catch { secrets = []; }
    // Map to cleaner structure, extract useful fields
    const mapped = secrets.map(s => ({
      name: s.name ? s.name.split('/').pop() : '',
      fullName: s.name || '',
      createTime: s.createTime || null,
      replication: s.replication || null,
      labels: s.labels || {},
    }));
    res.json({ secrets: mapped, project: GCP_PROJECT });
  } catch (err) {
    res.status(500).json({ error: err.message, hint: 'Check gcloud auth / SA key at ' + GCP_SA_KEY });
  }
});

// Get latest version of a secret (admin mode only — enforced by header check)
app.get('/api/gcp-secrets/:name', requireAuth, async (req, res) => {
  if (req.headers['x-admin-mode'] !== '1') {
    return res.status(403).json({ error: 'Admin mode required' });
  }
  const secretName = req.params.name.replace(/[^a-zA-Z0-9_\-]/g, '');
  if (!secretName) return res.status(400).json({ error: 'Invalid secret name' });
  try {
    const value = await runCmd(
      `GOOGLE_APPLICATION_CREDENTIALS=${GCP_SA_KEY} gcloud secrets versions access latest --secret=${secretName} --project=${GCP_PROJECT}`,
      10000
    );
    res.json({ value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === HTML PAGES ===

const FLEET_VM_APPS = [
  { name: 'Keeper / NCL', svc: 'keeper', port: 3006, url: 'https://keeper.deeptxai.com', desc: 'NCL brain & memory' },
  { name: 'Brain', svc: 'brain', port: 3001, url: 'https://brain.deeptxai.com', desc: 'Dr. Bauer neuroimaging' },
  { name: 'DetexAI', svc: 'detexai', port: 3003, url: 'https://detexai.deeptxai.com', desc: 'Agency app' },
  { name: 'BDE', svc: 'bde', port: 3004, url: 'https://bde.deeptxai.com', desc: 'Business Discovery Engine' },
  { name: 'Creator Ops', svc: 'creator', port: 3005, url: 'https://creator.deeptxai.com', desc: 'Creator Ops Studio' },
  { name: 'Barback', svc: 'barback', port: 3007, url: 'https://barback.deeptxai.com', desc: 'Bar management' },
  { name: 'Wedding', svc: 'wedding', port: 3002, url: 'https://wedding.deeptxai.com', desc: 'Wedding planner' },
  { name: 'Bigfoot', svc: 'bigfoot', port: 3000, url: 'https://bigfoot.deeptxai.com', desc: 'Bigfoot app (FE:3000 API:8000)' },
  { name: 'MOP', svc: 'mop', port: 3008, url: 'https://mop.deeptxai.com', desc: 'MOP automation' },
  { name: 'CreeksideAI', svc: 'creeksideai', port: 3009, url: 'https://creeksideai.deeptxai.com', desc: 'AI datacenter investor' },
  { name: 'Huron County', svc: 'huron', port: 5000, url: 'https://huroncounty.deeptxai.com', desc: 'County chatbot' },
  { name: 'Lobster', svc: 'lobster', port: 4000, url: 'https://app.deeptxai.com', desc: 'Lobster Cloud PWA' },
  { name: 'NetGrapher', svc: 'netgrapher', port: 3012, url: 'https://netgrapher.deeptxai.com', desc: 'Network visualization' },
  { name: 'Admin', svc: 'admin', port: 3013, url: 'https://admin.deeptxai.com', desc: 'Fleet admin & vault' },
  { name: 'Deploy Webhook', svc: 'deploy-webhook', port: 9101, url: null, desc: 'GitHub deploy webhook' },
];

const CLAWFORGE_VM_APPS = [
  { name: 'ClawForge AI', svc: 'clawforgeai', port: 3010, url: 'https://clawforgeai.com', desc: 'ClawForge SaaS (Next.js)' },
  { name: 'Portal', svc: 'portal', port: 3011, url: 'https://portal.clawforgeai.com', desc: 'ClawForge portal' },
  { name: 'ClawForge Admin', svc: 'clawforge-admin', port: 3014, url: null, desc: 'ClawForge admin dashboard' },
];

// Legacy flat list for launcher
const FLEET_APPS = [
  ...FLEET_VM_APPS.filter(a => a.url).map(a => ({ name: a.name, url: a.url, desc: a.desc })),
  ...CLAWFORGE_VM_APPS.filter(a => a.url).map(a => ({ name: a.name, url: a.url, desc: a.desc })),
];

const BASE_STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, sans-serif; background: #0a0a0f; color: #e2e8f0; min-height: 100vh; }
  a { color: inherit; text-decoration: none; }
  .layout { display: flex; min-height: 100vh; }
  
  /* Sidebar */
  .sidebar { width: 220px; background: #0f0f1a; border-right: 1px solid rgba(99,102,241,0.15); padding: 0; flex-shrink: 0; display: flex; flex-direction: column; }
  .sidebar-header { padding: 20px 16px; border-bottom: 1px solid rgba(99,102,241,0.15); }
  .sidebar-header h1 { font-size: 16px; font-weight: 700; color: #a78bfa; letter-spacing: 0.5px; }
  .sidebar-header p { font-size: 11px; color: #64748b; margin-top: 2px; }
  .sidebar-nav { padding: 12px 0; flex: 1; overflow-y: auto; }
  .nav-section { padding: 8px 16px 4px; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #475569; font-weight: 600; }
  .nav-item { display: flex; align-items: center; gap: 10px; padding: 9px 16px; font-size: 13px; color: #94a3b8; transition: all 0.15s; cursor: pointer; border-left: 3px solid transparent; }
  .nav-item:hover { background: rgba(99,102,241,0.08); color: #e2e8f0; }
  .nav-item.active { background: rgba(99,102,241,0.12); color: #a78bfa; border-left-color: #a78bfa; }
  .nav-item svg { width: 16px; height: 16px; flex-shrink: 0; }
  .sidebar-footer { padding: 12px 16px; border-top: 1px solid rgba(99,102,241,0.1); }
  .logout-btn { display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 12px; color: #64748b; background: transparent; border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; cursor: pointer; width: 100%; transition: all 0.15s; }
  .logout-btn:hover { color: #f87171; border-color: rgba(248,113,113,0.3); }
  
  /* Main content */
  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .topbar { background: #0f0f1a; border-bottom: 1px solid rgba(99,102,241,0.15); padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; }
  .topbar h2 { font-size: 15px; font-weight: 600; color: #f1f5f9; }
  .topbar-sub { font-size: 12px; color: #64748b; }
  .content { flex: 1; padding: 24px; overflow-y: auto; }
  
  /* Cards */
  .card { background: #0f0f1a; border: 1px solid rgba(99,102,241,0.12); border-radius: 12px; padding: 20px; }
  .card-title { font-size: 13px; font-weight: 600; color: #a78bfa; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  
  /* App grid */
  .app-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
  .app-tile { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 12px; transition: all 0.2s; cursor: pointer; display: block; }
  .app-tile:hover { background: rgba(99,102,241,0.08); border-color: rgba(99,102,241,0.3); transform: translateY(-1px); }
  .app-tile-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; }
  .app-tile-name { font-size: 12px; font-weight: 600; color: #f1f5f9; }
  .app-tile:hover .app-tile-name { color: #a78bfa; }
  .app-tile-port { font-size: 10px; color: #475569; font-family: monospace; }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; flex-shrink: 0; }
  .status-dot.green { background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.5); }
  .status-dot.red { background: #f87171; box-shadow: 0 0 6px rgba(248,113,113,0.4); }
  .status-dot.loading { background: #f59e0b; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .app-tile-desc { font-size: 10px; color: #64748b; line-height: 1.4; margin-bottom: 6px; }
  .app-tile-url { font-size: 9px; color: rgba(99,102,241,0.5); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .app-tile:hover .app-tile-url { color: rgba(99,102,241,0.8); }
  
  /* VM cards */
  .vm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
  .vm-card { background: #0f0f1a; border: 1px solid rgba(99,102,241,0.15); border-radius: 14px; padding: 20px; }
  .vm-card-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; padding-bottom: 14px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .vm-icon { width: 36px; height: 36px; background: linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.2)); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
  .vm-name { font-size: 14px; font-weight: 700; color: #f1f5f9; }
  .vm-meta { font-size: 11px; color: #64748b; margin-top: 2px; }
  .vm-badge { font-size: 10px; background: rgba(99,102,241,0.15); color: #a78bfa; padding: 2px 8px; border-radius: 4px; font-weight: 500; }
  
  /* Summary bar */
  .summary-bar { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .summary-item { background: rgba(99,102,241,0.06); border: 1px solid rgba(99,102,241,0.15); border-radius: 10px; padding: 14px; }
  .summary-value { font-size: 24px; font-weight: 700; color: #a78bfa; }
  .summary-label { font-size: 10px; color: #64748b; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.5px; }
  .summary-sub { font-size: 11px; color: #94a3b8; margin-top: 2px; font-family: monospace; }
  
  /* Relationship diagram */
  .rel-diagram { background: rgba(0,0,0,0.3); border: 1px solid rgba(99,102,241,0.12); border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  .rel-diagram-title { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 20px; }
  .rel-row { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .rel-node { background: rgba(99,102,241,0.1); border: 1px solid rgba(99,102,241,0.3); border-radius: 8px; padding: 8px 14px; font-size: 12px; font-weight: 600; color: #a78bfa; white-space: nowrap; }
  .rel-node.db { background: rgba(34,211,153,0.08); border-color: rgba(34,211,153,0.3); color: #34d399; }
  .rel-node.sub { background: rgba(99,102,241,0.05); border-color: rgba(99,102,241,0.15); color: #818cf8; font-weight: 400; font-size: 11px; }
  .rel-arrow { color: #475569; font-size: 14px; }
  .rel-down { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .rel-vert-arrow { color: #475569; font-size: 14px; line-height: 1; }
  
  /* Vault */
  .vault-toolbar { display: flex; gap: 10px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
  .btn { padding: 8px 16px; border-radius: 7px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.15s; }
  .btn-primary { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; }
  .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
  .btn-danger { background: rgba(239,68,68,0.1); color: #f87171; border: 1px solid rgba(239,68,68,0.2); }
  .btn-danger:hover { background: rgba(239,68,68,0.2); }
  .btn-sm { padding: 5px 10px; font-size: 11px; }
  .btn-ghost { background: transparent; color: #94a3b8; border: 1px solid rgba(255,255,255,0.08); }
  .btn-ghost:hover { background: rgba(255,255,255,0.05); color: #e2e8f0; }
  .btn-orange { background: rgba(249,115,22,0.15); color: #fb923c; border: 1px solid rgba(249,115,22,0.3); }
  .btn-orange:hover { background: rgba(249,115,22,0.25); }
  .btn-green { background: rgba(34,197,94,0.1); color: #4ade80; border: 1px solid rgba(34,197,94,0.2); }
  .btn-green:hover { background: rgba(34,197,94,0.2); }
  
  /* Admin mode banner */
  .admin-banner { background: linear-gradient(135deg, rgba(249,115,22,0.15), rgba(234,88,12,0.1)); border: 1px solid rgba(249,115,22,0.4); border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; }
  .admin-banner-text { font-size: 13px; font-weight: 600; color: #fb923c; }
  .admin-banner-timer { font-size: 11px; color: #f97316; font-family: monospace; }
  
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 10px 12px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: #64748b; border-bottom: 1px solid rgba(255,255,255,0.06); }
  td { padding: 12px 12px; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; }
  tr:hover td { background: rgba(99,102,241,0.04); }
  .pass-cell { display: flex; align-items: center; gap: 6px; }
  .pass-masked { font-family: monospace; color: #94a3b8; letter-spacing: 2px; }
  .pass-reveal { font-family: monospace; color: #e2e8f0; }
  .url-link { color: #818cf8; font-size: 12px; }
  .url-link:hover { color: #a78bfa; text-decoration: underline; }
  
  /* GCP Secrets table */
  .secrets-panel { background: rgba(0,0,0,0.2); border: 1px solid rgba(99,102,241,0.1); border-radius: 12px; padding: 20px; margin-top: 24px; }
  .secrets-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .secrets-title { font-size: 14px; font-weight: 600; color: #a78bfa; flex: 1; }
  .secret-value-modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 200; align-items: center; justify-content: center; }
  .secret-value-modal.open { display: flex; }
  .secret-modal-box { background: #0f0f1a; border: 1px solid rgba(99,102,241,0.3); border-radius: 14px; padding: 24px; width: 100%; max-width: 500px; }
  .secret-value-display { background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 12px 14px; font-family: monospace; font-size: 12px; color: #94a3b8; word-break: break-all; margin: 12px 0; cursor: pointer; transition: all 0.15s; min-height: 40px; }
  .secret-value-display.revealed { color: #e2e8f0; background: rgba(99,102,241,0.05); }
  
  /* Modal */
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: #0f0f1a; border: 1px solid rgba(99,102,241,0.2); border-radius: 14px; padding: 24px; width: 100%; max-width: 480px; }
  .modal h3 { font-size: 16px; font-weight: 600; color: #f1f5f9; margin-bottom: 20px; }
  .form-group { margin-bottom: 14px; }
  label { display: block; font-size: 11px; color: #94a3b8; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px; }
  input, textarea { width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 7px; padding: 9px 12px; color: #e2e8f0; font-size: 13px; outline: none; transition: border-color 0.15s; font-family: inherit; }
  input:focus, textarea:focus { border-color: rgba(99,102,241,0.5); }
  textarea { resize: vertical; min-height: 60px; }
  .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
  
  /* Hamburger (mobile) */
  .hamburger { display: none; background: none; border: none; color: #94a3b8; cursor: pointer; padding: 4px; }
  @media (max-width: 900px) {
    .vm-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 768px) {
    .hamburger { display: block; }
    .sidebar { position: fixed; left: -220px; top: 0; bottom: 0; z-index: 50; transition: left 0.2s; }
    .sidebar.open { left: 0; box-shadow: 4px 0 20px rgba(0,0,0,0.5); }
  }
`;

function sidebarHTML(active) {
  const items = [
    { id: 'dashboard', label: 'Dashboard', icon: '⬡', href: '/dashboard' },
    { id: 'vault', label: 'Password Vault', icon: '🔐', href: '/vault' },
    { id: 'launcher', label: 'Fleet Launcher', icon: '🚀', href: '/launcher' },
    { id: 'infrastructure', label: 'Infrastructure', icon: '🏗', href: '/infrastructure' },
  ];
  return `
    <div class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <h1>⚡ Fleet Admin</h1>
        <p>DeepTx Command Center</p>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-section">Navigation</div>
        ${items.map(i => `
          <a href="${i.href}" class="nav-item ${active === i.id ? 'active' : ''}">
            <span>${i.icon}</span>
            <span>${i.label}</span>
          </a>
        `).join('')}
        <div class="nav-section" style="margin-top:12px">Fleet Apps</div>
        ${FLEET_APPS.map(a => `
          <a href="${a.url}" target="_blank" class="nav-item" style="font-size:11px;padding:6px 16px;">
            <span>↗</span>
            <span>${a.name}</span>
          </a>
        `).join('')}
      </nav>
      <div class="sidebar-footer">
        <a href="/logout" class="logout-btn">
          <span>⏻</span> Logout
        </a>
      </div>
    </div>
  `;
}

function pageShell(title, active, content, extraScript) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Fleet Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="layout">
    ${sidebarHTML(active)}
    <div class="main">
      <div class="topbar">
        <button class="hamburger" onclick="document.getElementById('sidebar').classList.toggle('open')">☰</button>
        <h2>${title}</h2>
        <span class="topbar-sub">DeepTx Fleet</span>
      </div>
      <div class="content">
        ${content}
      </div>
    </div>
  </div>
  ${extraScript || ''}
</body>
</html>`;
}

function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — Fleet Admin</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: #0a0a0f; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-box { background: #0f0f1a; border: 1px solid rgba(99,102,241,0.2); border-radius: 16px; padding: 40px; width: 100%; max-width: 380px; text-align: center; }
    .login-logo { font-size: 40px; margin-bottom: 12px; }
    h1 { font-size: 22px; font-weight: 700; color: #a78bfa; margin-bottom: 4px; }
    .sub { font-size: 13px; color: #64748b; margin-bottom: 28px; }
    .error { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2); color: #f87171; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
    .form-group { margin-bottom: 16px; text-align: left; }
    label { display: block; font-size: 11px; color: #94a3b8; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px; }
    input { width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px 14px; color: #e2e8f0; font-size: 14px; outline: none; transition: border-color 0.15s; }
    input:focus { border-color: rgba(99,102,241,0.5); }
    button { width: 100%; padding: 12px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 8px; transition: opacity 0.15s; }
    button:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="login-box">
    <div class="login-logo">⚡</div>
    <h1>Fleet Admin</h1>
    <p class="sub">DeepTx Command Center</p>
    ${error}
    <form method="POST" action="/login">
      <div class="form-group">
        <label>Admin Password</label>
        <input type="password" name="password" placeholder="Enter password" autofocus required>
      </div>
      <button type="submit">Sign In →</button>
    </form>
  </div>
</body>
</html>`;
}

function relationshipDiagramHTML() {
  return `
    <div class="rel-diagram">
      <div class="rel-diagram-title">Fleet Topology</div>
      <div style="display:flex;justify-content:center;gap:0;align-items:flex-start;flex-wrap:wrap">
        <!-- Left: fleet-vm column -->
        <div class="rel-down" style="min-width:160px;align-items:center">
          <div class="rel-node">🖥 fleet-vm</div>
          <div class="rel-vert-arrow">↓</div>
          <div class="rel-node sub">keeper / NCL</div>
          <div class="rel-vert-arrow">↓</div>
          <div class="rel-node sub">GCP Secret Manager</div>
        </div>
        <!-- Center: DB -->
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding-top:0;min-width:200px">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="rel-arrow">←→</div>
            <div class="rel-down">
              <div class="rel-node db">🗄 Cloud SQL fleet-db</div>
              <div style="font-size:10px;color:#64748b;text-align:center;margin-top:4px">34.58.162.212</div>
            </div>
            <div class="rel-arrow">←→</div>
          </div>
        </div>
        <!-- Right: clawforge-vm column -->
        <div class="rel-down" style="min-width:160px;align-items:center">
          <div class="rel-node">🖥 clawforge-vm</div>
          <div class="rel-vert-arrow">↓</div>
          <div class="rel-node sub">ClawForge SaaS</div>
        </div>
      </div>
      <div style="text-align:center;margin-top:16px;font-size:10px;color:#475569">
        GCP Project: boxwood-yen-465815-h0 · Zone: us-central1-a
      </div>
    </div>
  `;
}

function dashboardPage() {
  const totalApps = FLEET_VM_APPS.length + CLAWFORGE_VM_APPS.length;
  const summaryBar = `
    <div class="summary-bar">
      <div class="summary-item">
        <div class="summary-value">${totalApps}</div>
        <div class="summary-label">Total Apps</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">2</div>
        <div class="summary-label">VMs</div>
      </div>
      <div class="summary-item">
        <div class="summary-value" style="font-size:13px;color:#34d399;padding-top:4px">34.58.162.212</div>
        <div class="summary-label">Cloud SQL Host</div>
      </div>
      <div class="summary-item">
        <div class="summary-value" style="font-size:12px;padding-top:4px">boxwood-yen-465815-h0</div>
        <div class="summary-label">GCP Project</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">🔐</div>
        <div class="summary-label">Vault Active</div>
      </div>
    </div>
  `;

  const fleetVmCard = `
    <div class="vm-card">
      <div class="vm-card-header">
        <div class="vm-icon">🖥</div>
        <div>
          <div class="vm-name">fleet-vm</div>
          <div class="vm-meta">34.122.171.173 · us-central1-a</div>
          <div class="vm-meta" style="margin-top:3px"><span class="vm-badge">e2-standard-4 · 4vCPU · 16GB</span></div>
        </div>
        <div style="margin-left:auto;font-size:11px;color:#64748b" id="fleet-refresh-time"></div>
      </div>
      <div class="app-grid" id="fleet-app-grid">
        ${FLEET_VM_APPS.map(a => `
          ${a.url ? `<a class="app-tile" href="${a.url}" target="_blank" id="tile-fleet-${a.svc}">` : `<div class="app-tile" id="tile-fleet-${a.svc}">`}
            <div class="app-tile-header">
              <span class="app-tile-name">${a.name}</span>
              <div class="status-dot loading" id="dot-fleet-${a.svc}"></div>
            </div>
            <div class="app-tile-desc">${a.desc}</div>
            <div class="app-tile-port">:${a.port}</div>
            ${a.url ? `<div class="app-tile-url">${a.url.replace('https://', '')}</div>` : ''}
          ${a.url ? '</a>' : '</div>'}
        `).join('')}
      </div>
    </div>
  `;

  const clawforgeVmCard = `
    <div class="vm-card">
      <div class="vm-card-header">
        <div class="vm-icon">🏗</div>
        <div>
          <div class="vm-name">clawforge-vm</div>
          <div class="vm-meta">34.10.77.209 · us-central1-a</div>
          <div class="vm-meta" style="margin-top:3px"><span class="vm-badge">e2-small · 2vCPU · 2GB</span></div>
        </div>
      </div>
      <div class="app-grid" id="clawforge-app-grid">
        ${CLAWFORGE_VM_APPS.map(a => `
          ${a.url ? `<a class="app-tile" href="${a.url}" target="_blank" id="tile-cf-${a.svc}">` : `<div class="app-tile" id="tile-cf-${a.svc}">`}
            <div class="app-tile-header">
              <span class="app-tile-name">${a.name}</span>
              <div class="status-dot loading" id="dot-cf-${a.svc}"></div>
            </div>
            <div class="app-tile-desc">${a.desc}</div>
            <div class="app-tile-port">:${a.port}</div>
            ${a.url ? `<div class="app-tile-url">${a.url.replace('https://', '')}</div>` : ''}
          ${a.url ? '</a>' : '</div>'}
        `).join('')}
      </div>
    </div>
  `;

  const content = summaryBar + `
    <div class="vm-grid">${fleetVmCard}${clawforgeVmCard}</div>
    ${relationshipDiagramHTML()}
  `;

  const script = `<script>
    async function loadStatus() {
      try {
        const r = await fetch('/api/status');
        const data = await r.json();
        // fleet-vm dots
        const fleet = data.fleet || {};
        ${FLEET_VM_APPS.map(a => `
          {
            const dot = document.getElementById('dot-fleet-${a.svc}');
            if (dot) {
              const active = fleet['${a.svc}'];
              dot.className = 'status-dot ' + (active === true ? 'green' : active === false ? 'red' : 'loading');
            }
          }
        `).join('')}
        // clawforge-vm dots
        const cf = data.clawforge || {};
        ${CLAWFORGE_VM_APPS.map(a => `
          {
            const dot = document.getElementById('dot-cf-${a.svc}');
            if (dot) {
              const active = cf['${a.svc}'];
              dot.className = 'status-dot ' + (active === true ? 'green' : active === false ? 'red' : 'loading');
            }
          }
        `).join('')}
        document.getElementById('fleet-refresh-time').textContent = 'Updated ' + new Date().toLocaleTimeString();
      } catch(e) {
        console.error('Status fetch failed:', e);
      }
    }
    loadStatus();
    // Refresh every 60s
    setInterval(loadStatus, 60000);
  </script>`;

  return pageShell('Dashboard', 'dashboard', content, script);
}

function vaultPage() {
  const content = `
    <!-- Admin mode banner (hidden by default) -->
    <div class="admin-banner" id="admin-banner" style="display:none">
      <div>
        <div class="admin-banner-text">🔓 Admin Mode Active</div>
        <div style="font-size:11px;color:#f97316;margin-top:2px">Edit and delete operations enabled</div>
      </div>
      <div style="text-align:right">
        <div class="admin-banner-timer" id="admin-timer">10:00</div>
        <button class="btn btn-sm" style="margin-top:4px;background:rgba(249,115,22,0.2);color:#fb923c;border:1px solid rgba(249,115,22,0.3)" onclick="deactivateAdmin()">Exit Admin</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:24px">
      <div class="vault-toolbar">
        <span style="font-size:14px;font-weight:600;color:#a78bfa;flex:1">🔐 Password Vault</span>
        <button class="btn btn-orange btn-sm" id="admin-mode-btn" onclick="toggleAdminMode()">🔑 Admin Mode</button>
        <button class="btn btn-primary" id="add-entry-btn" style="display:none" onclick="openModal()">+ Add Entry</button>
      </div>
      <div id="vault-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Username</th>
              <th>Password</th>
              <th>URL</th>
              <th>Notes</th>
              <th id="actions-col" style="display:none">Actions</th>
            </tr>
          </thead>
          <tbody id="vault-rows">
            <tr><td colspan="6" style="text-align:center;color:#475569;padding:24px">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- GCP Secret Manager panel -->
    <div class="secrets-panel">
      <div class="secrets-header">
        <div class="secrets-title">🔒 GCP Secret Manager</div>
        <a href="https://console.cloud.google.com/security/secret-manager?project=boxwood-yen-465815-h0" target="_blank" class="btn btn-ghost btn-sm">↗ Open in GCP Console</a>
        <button class="btn btn-ghost btn-sm" onclick="loadSecrets()">↺ Refresh</button>
      </div>
      <div id="secrets-content">
        <div style="text-align:center;color:#475569;padding:24px">Loading secrets...</div>
      </div>
    </div>

    <!-- Add/Edit Modal -->
    <div class="modal-overlay" id="vault-modal">
      <div class="modal">
        <h3 id="modal-title">Add Entry</h3>
        <input type="hidden" id="edit-id">
        <div class="form-group"><label>Name *</label><input id="f-name" placeholder="e.g. Fleet DB postgres"></div>
        <div class="form-group"><label>Username</label><input id="f-user" placeholder="username"></div>
        <div class="form-group"><label>Password</label><input id="f-pass" type="password" placeholder="••••••••"></div>
        <div class="form-group"><label>URL</label><input id="f-url" placeholder="https://..."></div>
        <div class="form-group"><label>Notes</label><textarea id="f-notes" placeholder="Any notes..."></textarea></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="saveEntry()">Save</button>
        </div>
      </div>
    </div>

    <!-- Admin mode unlock modal -->
    <div class="modal-overlay" id="admin-modal">
      <div class="modal" style="max-width:360px">
        <h3>🔑 Enter Admin Password</h3>
        <div class="form-group"><label>Admin Vault Password</label><input id="admin-pass-input" type="password" placeholder="Admin password" onkeydown="if(event.key==='Enter')submitAdmin()"></div>
        <div id="admin-error" style="color:#f87171;font-size:12px;margin-top:-8px;margin-bottom:8px;display:none">Incorrect password</div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="closeAdminModal()">Cancel</button>
          <button class="btn btn-orange" onclick="submitAdmin()">Unlock Admin Mode</button>
        </div>
      </div>
    </div>

    <!-- Secret value modal -->
    <div class="secret-value-modal" id="secret-modal">
      <div class="secret-modal-box">
        <h3 style="font-size:15px;font-weight:600;color:#f1f5f9;margin-bottom:4px">Secret Value</h3>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px" id="secret-modal-name"></div>
        <div class="secret-value-display" id="secret-val-display" onclick="toggleSecretReveal()">Click to reveal</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px">Click value to reveal · <span id="secret-copy-btn" style="color:#818cf8;cursor:pointer" onclick="copySecretVal()">Copy to clipboard</span></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="closeSecretModal()">Close</button>
        </div>
      </div>
    </div>
  `;

  const script = `<script>
    let vaultData = [];
    let adminMode = false;
    let adminTimer = null;
    let adminSeconds = 600;
    let secretVal = '';
    let secretRevealed = false;

    // ---- Admin mode ----
    function toggleAdminMode() {
      if (adminMode) { deactivateAdmin(); return; }
      document.getElementById('admin-modal').classList.add('open');
      setTimeout(() => document.getElementById('admin-pass-input').focus(), 50);
    }
    function closeAdminModal() {
      document.getElementById('admin-modal').classList.remove('open');
      document.getElementById('admin-pass-input').value = '';
      document.getElementById('admin-error').style.display = 'none';
    }
    function submitAdmin() {
      const pw = document.getElementById('admin-pass-input').value;
      if (pw === 'DeepTx-Admin99') {
        closeAdminModal();
        activateAdmin();
      } else {
        document.getElementById('admin-error').style.display = 'block';
      }
    }
    function activateAdmin() {
      adminMode = true;
      adminSeconds = 600;
      document.getElementById('admin-banner').style.display = 'flex';
      document.getElementById('add-entry-btn').style.display = 'inline-block';
      document.getElementById('actions-col').style.display = '';
      document.getElementById('admin-mode-btn').textContent = '🔒 Exit Admin';
      document.getElementById('admin-mode-btn').className = 'btn btn-sm btn-danger';
      renderTable();
      startAdminTimer();
    }
    function deactivateAdmin() {
      adminMode = false;
      clearInterval(adminTimer);
      document.getElementById('admin-banner').style.display = 'none';
      document.getElementById('add-entry-btn').style.display = 'none';
      document.getElementById('actions-col').style.display = 'none';
      document.getElementById('admin-mode-btn').textContent = '🔑 Admin Mode';
      document.getElementById('admin-mode-btn').className = 'btn btn-orange btn-sm';
      renderTable();
    }
    function startAdminTimer() {
      clearInterval(adminTimer);
      adminTimer = setInterval(() => {
        adminSeconds--;
        const m = Math.floor(adminSeconds / 60).toString().padStart(2,'0');
        const s = (adminSeconds % 60).toString().padStart(2,'0');
        document.getElementById('admin-timer').textContent = m + ':' + s;
        if (adminSeconds <= 0) deactivateAdmin();
      }, 1000);
    }
    function resetAdminTimer() {
      if (adminMode) { adminSeconds = 600; }
    }
    document.addEventListener('click', resetAdminTimer);
    document.addEventListener('keydown', resetAdminTimer);

    // ---- Vault ----
    async function loadVault() {
      try {
        const r = await fetch('/api/vault');
        vaultData = await r.json();
        renderTable();
      } catch(e) {
        document.getElementById('vault-rows').innerHTML = '<tr><td colspan="6" style="color:#f87171;text-align:center">Error loading vault</td></tr>';
      }
    }

    function renderTable() {
      const tbody = document.getElementById('vault-rows');
      if (!vaultData.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#475569;padding:24px">No entries yet.</td></tr>';
        return;
      }
      tbody.innerHTML = vaultData.map(e => {
        const actionsCol = adminMode
          ? '<td><div style="display:flex;gap:4px"><button class="btn btn-ghost btn-sm" onclick="editEntry(' + e.id + ')">✏️</button><button class="btn btn-danger btn-sm" onclick="deleteEntry(' + e.id + ')">🗑</button></div></td>'
          : '<td></td>';
        return '<tr>' +
          '<td style="font-weight:500">' + esc(e.name) + '</td>' +
          '<td style="font-family:monospace;font-size:12px">' + esc(e.username || '—') + '</td>' +
          '<td><div class="pass-cell">' +
            '<span id="pass-' + e.id + '" class="pass-masked">••••••••</span>' +
            '<button class="btn btn-ghost btn-sm" id="reveal-btn-' + e.id + '" onclick="revealPass(' + e.id + ')">👁</button>' +
            '<button class="btn btn-ghost btn-sm" onclick="copyPassById(' + e.id + ')">📋</button>' +
          '</div></td>' +
          '<td>' + (e.url ? '<a class="url-link" href="' + esc(e.url) + '" target="_blank">' + esc(e.url.replace('https://','')) + '</a>' : '—') + '</td>' +
          '<td style="font-size:12px;color:#64748b;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(e.notes || '—') + '</td>' +
          actionsCol +
        '</tr>';
      }).join('');
    }

    function esc(s) {
      return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    let revealTimers = {};
    async function revealPass(id) {
      const el = document.getElementById('pass-' + id);
      if (!el) return;
      if (el.classList.contains('pass-reveal')) {
        el.classList.remove('pass-reveal'); el.classList.add('pass-masked');
        el.textContent = '••••••••';
        clearTimeout(revealTimers[id]);
        return;
      }
      // Fetch from server
      try {
        const r = await fetch('/api/vault/' + id + '/reveal');
        const data = await r.json();
        el.classList.remove('pass-masked'); el.classList.add('pass-reveal');
        el.textContent = data.password || '';
        // Re-mask after 30s
        clearTimeout(revealTimers[id]);
        revealTimers[id] = setTimeout(() => {
          el.classList.remove('pass-reveal'); el.classList.add('pass-masked');
          el.textContent = '••••••••';
        }, 30000);
      } catch(err) {
        el.textContent = '[error]';
      }
    }

    async function copyPassById(id) {
      const el = document.getElementById('pass-' + id);
      let pw = '';
      if (el && el.classList.contains('pass-reveal')) {
        pw = el.textContent;
      } else {
        try {
          const r = await fetch('/api/vault/' + id + '/reveal');
          const data = await r.json();
          pw = data.password || '';
        } catch { return; }
      }
      navigator.clipboard.writeText(pw).then(() => toast('Copied!'));
    }

    function toast(msg) {
      const t = document.createElement('div');
      t.textContent = msg;
      t.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#6366f1;color:white;padding:8px 16px;border-radius:8px;z-index:999;font-size:13px';
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 2000);
    }

    function openModal() {
      document.getElementById('vault-modal').classList.add('open');
      document.getElementById('modal-title').textContent = 'Add Entry';
      document.getElementById('edit-id').value = '';
      ['f-name','f-user','f-pass','f-url','f-notes'].forEach(i => document.getElementById(i).value = '');
    }
    function closeModal() { document.getElementById('vault-modal').classList.remove('open'); }

    function editEntry(id) {
      const e = vaultData.find(x => x.id === id);
      if (!e) return;
      document.getElementById('modal-title').textContent = 'Edit Entry';
      document.getElementById('edit-id').value = id;
      document.getElementById('f-name').value = e.name || '';
      document.getElementById('f-user').value = e.username || '';
      document.getElementById('f-pass').value = '';
      document.getElementById('f-url').value = e.url || '';
      document.getElementById('f-notes').value = e.notes || '';
      document.getElementById('vault-modal').classList.add('open');
    }

    async function saveEntry() {
      const id = document.getElementById('edit-id').value;
      const body = {
        name: document.getElementById('f-name').value,
        username: document.getElementById('f-user').value,
        password: document.getElementById('f-pass').value,
        url: document.getElementById('f-url').value,
        notes: document.getElementById('f-notes').value,
      };
      if (!body.name) { alert('Name is required'); return; }
      const method = id ? 'PUT' : 'POST';
      const url = id ? '/api/vault/' + id : '/api/vault';
      await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      closeModal();
      loadVault();
    }

    async function deleteEntry(id) {
      if (!confirm('Delete this entry?')) return;
      await fetch('/api/vault/' + id, { method: 'DELETE' });
      loadVault();
    }

    document.getElementById('vault-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });
    document.getElementById('admin-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeAdminModal();
    });

    // ---- GCP Secrets ----
    async function loadSecrets() {
      const cont = document.getElementById('secrets-content');
      cont.innerHTML = '<div style="text-align:center;color:#475569;padding:20px">Loading...</div>';
      try {
        const r = await fetch('/api/gcp-secrets');
        if (!r.ok) {
          const err = await r.json();
          cont.innerHTML = '<div style="color:#f87171;padding:16px;font-size:13px">⚠ ' + esc(err.error || 'Error fetching secrets') + (err.hint ? '<br><span style="color:#64748b;font-size:11px">' + esc(err.hint) + '</span>' : '') + '</div>';
          return;
        }
        const data = await r.json();
        const secrets = data.secrets || [];
        if (!secrets.length) {
          cont.innerHTML = '<div style="text-align:center;color:#475569;padding:20px">No secrets found.</div>';
          return;
        }
        cont.innerHTML = '<table>' +
          '<thead><tr><th>Secret Name</th><th>Created</th><th style="' + (adminMode ? '' : 'display:none') + '" id="secret-actions-th">Actions</th></tr></thead>' +
          '<tbody>' +
          secrets.map(s => {
            const created = s.createTime ? new Date(s.createTime).toLocaleDateString() : '—';
            const actionBtn = adminMode
              ? '<button class="btn btn-ghost btn-sm" onclick="viewSecret(\'' + esc(s.name) + '\')">👁 View Value</button>'
              : '<span style="color:#475569;font-size:11px">Admin mode required</span>';
            return '<tr>' +
              '<td style="font-family:monospace;font-size:12px;color:#a78bfa">' + esc(s.name) + '</td>' +
              '<td style="font-size:12px;color:#64748b">' + created + '</td>' +
              '<td>' + actionBtn + '</td>' +
            '</tr>';
          }).join('') +
          '</tbody></table>';
      } catch(e) {
        cont.innerHTML = '<div style="color:#f87171;padding:16px;font-size:13px">⚠ ' + esc(e.message) + '</div>';
      }
    }

    async function viewSecret(name) {
      if (!adminMode) { alert('Admin mode required to view secret values'); return; }
      const modal = document.getElementById('secret-modal');
      const display = document.getElementById('secret-val-display');
      document.getElementById('secret-modal-name').textContent = name;
      display.textContent = 'Loading...';
      display.className = 'secret-value-display';
      secretVal = '';
      secretRevealed = false;
      modal.classList.add('open');
      try {
        const r = await fetch('/api/gcp-secrets/' + encodeURIComponent(name), {
          headers: { 'x-admin-mode': '1' }
        });
        if (!r.ok) {
          const err = await r.json();
          display.textContent = 'Error: ' + (err.error || 'Unknown error');
          return;
        }
        const data = await r.json();
        secretVal = data.value || '';
        display.textContent = '●'.repeat(Math.min(secretVal.length, 20)) + ' (click to reveal)';
      } catch(e) {
        display.textContent = 'Error: ' + e.message;
      }
    }

    function toggleSecretReveal() {
      const display = document.getElementById('secret-val-display');
      if (!secretVal) return;
      secretRevealed = !secretRevealed;
      if (secretRevealed) {
        display.textContent = secretVal;
        display.className = 'secret-value-display revealed';
      } else {
        display.textContent = '●'.repeat(Math.min(secretVal.length, 20)) + ' (click to reveal)';
        display.className = 'secret-value-display';
      }
    }

    function copySecretVal() {
      if (!secretVal) return;
      navigator.clipboard.writeText(secretVal).then(() => toast('Secret copied!'));
    }

    function closeSecretModal() {
      document.getElementById('secret-modal').classList.remove('open');
      secretVal = '';
      secretRevealed = false;
    }
    document.getElementById('secret-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeSecretModal();
    });

    loadVault();
    loadSecrets();
  </script>`;

  return pageShell('Password Vault', 'vault', content, script);
}

function launcherPage() {
  const content = `
    <div style="margin-bottom:20px">
      <h3 style="font-size:18px;font-weight:600;color:#f1f5f9;margin-bottom:4px">🚀 Fleet Launcher</h3>
      <p style="font-size:13px;color:#64748b">Click any tile to open the app in a new tab</p>
    </div>
    <div class="app-grid" style="grid-template-columns:repeat(auto-fill, minmax(200px, 1fr))">
      ${FLEET_APPS.map(a => `
        <a class="app-tile" href="${a.url}" target="_blank">
          <div class="app-tile-header">
            <span class="app-tile-name">${a.name}</span>
            <div class="status-dot green"></div>
          </div>
          <div class="app-tile-desc">${a.desc}</div>
          <div class="app-tile-url">${a.url.replace('https://', '')}</div>
        </a>
      `).join('')}
    </div>
  `;
  return pageShell('Fleet Launcher', 'launcher', content);
}

function infrastructurePage() {
  const content = `
    <div style="margin-bottom:24px">
      <h3 style="font-size:18px;font-weight:600;color:#f1f5f9;margin-bottom:4px">🏗 Infrastructure</h3>
      <p style="font-size:13px;color:#64748b">GCP fleet topology and relationships</p>
    </div>
    ${relationshipDiagramHTML()}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px">
      <div class="card">
        <div class="card-title">🖥 fleet-vm</div>
        <div style="font-size:13px;color:#94a3b8;line-height:1.8">
          <div><span style="color:#64748b">IP:</span> 34.122.171.173</div>
          <div><span style="color:#64748b">Type:</span> e2-standard-4</div>
          <div><span style="color:#64748b">vCPU:</span> 4 · <span style="color:#64748b">RAM:</span> 16GB</div>
          <div><span style="color:#64748b">Zone:</span> us-central1-a</div>
          <div><span style="color:#64748b">Apps:</span> ${FLEET_VM_APPS.length}</div>
          <div style="margin-top:12px;font-size:11px;color:#475569">${FLEET_VM_APPS.map(a => a.name).join(' · ')}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">🏗 clawforge-vm</div>
        <div style="font-size:13px;color:#94a3b8;line-height:1.8">
          <div><span style="color:#64748b">IP:</span> 34.10.77.209</div>
          <div><span style="color:#64748b">Type:</span> e2-small</div>
          <div><span style="color:#64748b">vCPU:</span> 2 · <span style="color:#64748b">RAM:</span> 2GB</div>
          <div><span style="color:#64748b">Zone:</span> us-central1-a</div>
          <div><span style="color:#64748b">Apps:</span> ${CLAWFORGE_VM_APPS.length}</div>
          <div style="margin-top:12px;font-size:11px;color:#475569">${CLAWFORGE_VM_APPS.map(a => a.name).join(' · ')}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">🗄 Cloud SQL fleet-db</div>
        <div style="font-size:13px;color:#94a3b8;line-height:1.8">
          <div><span style="color:#64748b">Host:</span> 34.58.162.212</div>
          <div><span style="color:#64748b">Engine:</span> PostgreSQL</div>
          <div><span style="color:#64748b">DB:</span> admindb (+ fleet app DBs)</div>
          <div><span style="color:#64748b">Users:</span> adminuser, others per-app</div>
          <div style="margin-top:8px;font-size:11px;color:#475569">Shared by all fleet apps on both VMs</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">🔒 GCP Secret Manager</div>
        <div style="font-size:13px;color:#94a3b8;line-height:1.8">
          <div><span style="color:#64748b">Project:</span> boxwood-yen-465815-h0</div>
          <div><span style="color:#64748b">SA:</span> openclaw-agent@...</div>
          <div style="margin-top:8px">
            <a href="https://console.cloud.google.com/security/secret-manager?project=boxwood-yen-465815-h0" target="_blank" class="btn btn-ghost btn-sm">↗ Open Console</a>
          </div>
        </div>
      </div>
    </div>
  `;
  return pageShell('Infrastructure', 'infrastructure', content);
}

// Start server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log('Fleet Admin running on port ' + PORT);
  });
});
