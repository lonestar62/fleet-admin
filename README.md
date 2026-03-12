# Fleet Admin Dashboard

Admin dashboard for DeepTx fleet at admin.deeptxai.com

## Features
- Login wall (password auth via express-session)
- Hamburger sidebar nav with all fleet app links
- Password Vault (CRUD, AES-256 encrypted, Cloud SQL backend)
- Fleet Launcher tiles grid
- Dark professional UI with indigo/purple accents

## Stack
- Node.js / Express
- express-session for auth
- pg (PostgreSQL) for vault storage
- AES-256-CBC encryption for passwords

## Port
3013

## Service
systemd: admin.service
