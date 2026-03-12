'use strict';
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3013;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Claw2026-DeepTx99';
const VAULT_KEY = process.env.VAULT_KEY || crypto.randomBytes(32).toString('hex');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

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

// === VAULT API ===
app.get('/api/vault', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vault_entries ORDER BY name ASC');
    const entries = result.rows.map(r => ({
      ...r,
      password_dec: decrypt(r.password_enc)
    }));
    res.json(entries);
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

// === HTML PAGES ===

const FLEET_APPS = [
  { name: "Keeper / NCL", url: "https://keeper.deeptxai.com", desc: "NCL brain & memory" },
  { name: "Brain", url: "https://brain.deeptxai.com", desc: "Dr. Bauer neuroimaging" },
  { name: "DetexAI", url: "https://detexai.deeptxai.com", desc: "Agency app" },
  { name: "BDE", url: "https://bde.deeptxai.com", desc: "Business Discovery Engine" },
  { name: "Creator Ops", url: "https://creator.deeptxai.com", desc: "Creator Ops Studio" },
  { name: "Barback", url: "https://barback.deeptxai.com", desc: "Bar management" },
  { name: "Wedding", url: "https://wedding.deeptxai.com", desc: "Wedding planner" },
  { name: "Bigfoot", url: "https://bigfoot.deeptxai.com", desc: "Bigfoot app" },
  { name: "MOP", url: "https://mop.deeptxai.com", desc: "MOP automation" },
  { name: "CreeksideAI", url: "https://creeksideai.deeptxai.com", desc: "AI datacenter investor" },
  { name: "Huron County", url: "https://huroncounty.deeptxai.com", desc: "County chatbot" },
  { name: "Lobster", url: "https://app.deeptxai.com", desc: "Lobster Cloud PWA" },
  { name: "NetGrapher", url: "https://netgrapher.deeptxai.com", desc: "Network visualization" },
  { name: "ClawForge", url: "https://clawforgeai.com", desc: "ClawForge SaaS" },
  { name: "Portal", url: "https://portal.clawforgeai.com", desc: "ClawForge portal" },
  { name: "Admin", url: "https://admin.deeptxai.com", desc: "Fleet admin & passwords" },
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
  .card-title { font-size: 13px; font-weight: 600; color: #a78bfa; margin-bottom: 16px; display: flex; align-items: center; gap-8px; }
  
  /* App grid */
  .app-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  .app-tile { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 14px; transition: all 0.2s; cursor: pointer; display: block; }
  .app-tile:hover { background: rgba(99,102,241,0.08); border-color: rgba(99,102,241,0.3); transform: translateY(-1px); }
  .app-tile-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
  .app-tile-name { font-size: 13px; font-weight: 600; color: #f1f5f9; }
  .app-tile:hover .app-tile-name { color: #a78bfa; }
  .app-tile-status { display: flex; align-items: center; gap: 4px; }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.5); }
  .app-tile-desc { font-size: 11px; color: #64748b; line-height: 1.4; }
  .app-tile-url { font-size: 10px; color: rgba(99,102,241,0.5); font-family: monospace; margin-top: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .app-tile:hover .app-tile-url { color: rgba(99,102,241,0.8); }
  
  /* Vault */
  .vault-toolbar { display: flex; gap: 10px; margin-bottom: 16px; align-items: center; }
  .btn { padding: 8px 16px; border-radius: 7px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.15s; }
  .btn-primary { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; }
  .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
  .btn-danger { background: rgba(239,68,68,0.1); color: #f87171; border: 1px solid rgba(239,68,68,0.2); }
  .btn-danger:hover { background: rgba(239,68,68,0.2); }
  .btn-sm { padding: 5px 10px; font-size: 11px; }
  .btn-ghost { background: transparent; color: #94a3b8; border: 1px solid rgba(255,255,255,0.08); }
  .btn-ghost:hover { background: rgba(255,255,255,0.05); color: #e2e8f0; }
  
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 10px 12px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: #64748b; border-bottom: 1px solid rgba(255,255,255,0.06); }
  td { padding: 12px 12px; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; }
  tr:hover td { background: rgba(99,102,241,0.04); }
  .pass-cell { display: flex; align-items: center; gap: 6px; }
  .pass-masked { font-family: monospace; color: #94a3b8; letter-spacing: 2px; }
  .pass-reveal { font-family: monospace; color: #e2e8f0; }
  .url-link { color: #818cf8; font-size: 12px; }
  .url-link:hover { color: #a78bfa; text-decoration: underline; }
  
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
  
  /* Stats */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: rgba(99,102,241,0.06); border: 1px solid rgba(99,102,241,0.15); border-radius: 10px; padding: 16px; }
  .stat-value { font-size: 28px; font-weight: 700; color: #a78bfa; }
  .stat-label { font-size: 11px; color: #64748b; margin-top: 4px; }
  
  /* Hamburger (mobile) */
  .hamburger { display: none; background: none; border: none; color: #94a3b8; cursor: pointer; padding: 4px; }
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

function pageShell(title, active, content) {
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

function dashboardPage() {
  const appCount = FLEET_APPS.length;
  const statsHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${appCount}</div>
        <div class="stat-label">Fleet Apps</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:#34d399">${appCount}</div>
        <div class="stat-label">Online</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">1</div>
        <div class="stat-label">VM (fleet-vm)</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">🔐</div>
        <div class="stat-label">Vault Active</div>
      </div>
    </div>
  `;
  const appGrid = `
    <div class="card" style="margin-bottom:20px">
      <div class="card-title">Fleet Apps</div>
      <div class="app-grid">
        ${FLEET_APPS.map(a => `
          <a class="app-tile" href="${a.url}" target="_blank">
            <div class="app-tile-header">
              <span class="app-tile-name">${a.name}</span>
              <div class="app-tile-status"><div class="status-dot"></div></div>
            </div>
            <div class="app-tile-desc">${a.desc}</div>
            <div class="app-tile-url">${a.url.replace('https://', '')}</div>
          </a>
        `).join('')}
      </div>
    </div>
  `;
  return pageShell('Dashboard', 'dashboard', statsHTML + appGrid);
}

function vaultPage() {
  const content = `
    <div class="card">
      <div class="vault-toolbar">
        <span style="font-size:14px;font-weight:600;color:#a78bfa;flex:1">🔐 Password Vault</span>
        <button class="btn btn-primary" onclick="openModal()">+ Add Entry</button>
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
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="vault-rows">
            <tr><td colspan="6" style="text-align:center;color:#475569;padding:24px">Loading...</td></tr>
          </tbody>
        </table>
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
    
    <script>
    let vaultData = [];
    
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
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#475569;padding:24px">No entries yet. Add your first credential.</td></tr>';
        return;
      }
      tbody.innerHTML = vaultData.map(e => \`
        <tr>
          <td style="font-weight:500">\${esc(e.name)}</td>
          <td style="font-family:monospace;font-size:12px">\${esc(e.username || '—')}</td>
          <td>
            <div class="pass-cell">
              <span id="pass-\${e.id}" class="pass-masked">••••••••</span>
              <button class="btn btn-ghost btn-sm" onclick="togglePass(\${e.id}, \${JSON.stringify(esc(e.password_dec))})">👁</button>
              <button class="btn btn-ghost btn-sm" onclick="copyText(\${JSON.stringify(e.password_dec)})">📋</button>
            </div>
          </td>
          <td>\${e.url ? \`<a class="url-link" href="\${esc(e.url)}" target="_blank">\${esc(e.url.replace('https://',''))}</a>\` : '—'}</td>
          <td style="font-size:12px;color:#64748b;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${esc(e.notes || '—')}</td>
          <td>
            <div style="display:flex;gap:4px">
              <button class="btn btn-ghost btn-sm" onclick="editEntry(\${e.id})">✏️</button>
              <button class="btn btn-danger btn-sm" onclick="deleteEntry(\${e.id})">🗑</button>
            </div>
          </td>
        </tr>
      \`).join('');
    }
    
    function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    
    function togglePass(id, val) {
      const el = document.getElementById('pass-' + id);
      if (el.classList.contains('pass-masked')) {
        el.classList.remove('pass-masked'); el.classList.add('pass-reveal');
        el.textContent = val;
      } else {
        el.classList.remove('pass-reveal'); el.classList.add('pass-masked');
        el.textContent = '••••••••';
      }
    }
    
    function copyText(text) {
      navigator.clipboard.writeText(text).then(() => {
        const t = document.createElement('div');
        t.textContent = 'Copied!';
        t.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#6366f1;color:white;padding:8px 16px;border-radius:8px;z-index:999;font-size:13px';
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2000);
      });
    }
    
    function openModal(id) {
      document.getElementById('vault-modal').classList.add('open');
      if (!id) {
        document.getElementById('modal-title').textContent = 'Add Entry';
        document.getElementById('edit-id').value = '';
        ['f-name','f-user','f-pass','f-url','f-notes'].forEach(i => document.getElementById(i).value = '');
      }
    }
    
    function closeModal() { document.getElementById('vault-modal').classList.remove('open'); }
    
    function editEntry(id) {
      const e = vaultData.find(x => x.id === id);
      if (!e) return;
      document.getElementById('modal-title').textContent = 'Edit Entry';
      document.getElementById('edit-id').value = id;
      document.getElementById('f-name').value = e.name || '';
      document.getElementById('f-user').value = e.username || '';
      document.getElementById('f-pass').value = e.password_dec || '';
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
    
    // Close modal on backdrop click
    document.getElementById('vault-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });
    
    loadVault();
    </script>
  `;
  return pageShell('Password Vault', 'vault', content);
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
            <div class="app-tile-status">
              <div class="status-dot"></div>
              <span style="font-size:9px;color:#34d399">●</span>
            </div>
          </div>
          <div class="app-tile-desc">${a.desc}</div>
          <div class="app-tile-url">${a.url.replace('https://', '')}</div>
        </a>
      `).join('')}
    </div>
  `;
  return pageShell('Fleet Launcher', 'launcher', content);
}

// Start server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Fleet Admin running on port ${PORT}`);
  });
});
