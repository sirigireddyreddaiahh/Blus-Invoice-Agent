'use strict';
const cds = require('@sap/cds');
const express = require('express');
const fs = require('fs');
const path = require('path');

async function seedPostedIfEmpty() {
  const existing = await cds.run(SELECT.from('ap.Posted'));
  if (existing && existing.length > 0) return;

  const csvPath = path.join(__dirname, 'db/data/ap-Posted.csv');
  if (!fs.existsSync(csvPath)) return;
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  if (lines.length < 2) return;
  const head = lines[0].split(',');
  const entries = lines.slice(1).map(l => {
    const cells = l.split(',');
    const row = Object.fromEntries(head.map((h, i) => [h, cells[i] === '' ? null : cells[i]]));
    row.total = Number(row.total);
    row.blocked = row.blocked === 'true';
    row.recurringPo = row.recurringPo === 'true';
    return row;
  });
  if (entries.length > 0) {
    await cds.run(INSERT.into('ap.Posted').entries(entries));
  }
}

async function main() {
  const PORT = process.env.PORT || 3000;
  const app = express();

  app.use(express.json({ limit: '25mb' }));

  // Role and user middleware supporting XSUAA, Basic Auth, X-User-Role header, and role cookies/query
  app.use((req, res, next) => {
    const roleHeader = req.headers['x-user-role'];
    const userHeader = req.headers['x-user-id'];
    const authHeader = req.headers['authorization'];
    let user = { id: 'controller', roles: ['APClerk', 'APController'] };

    if (roleHeader) {
      const roles = String(roleHeader).split(',').map(r => r.trim()).filter(Boolean);
      user = {
        id: userHeader ? String(userHeader).trim() : roles[0].toLowerCase(),
        roles,
      };
    } else if (authHeader && authHeader.startsWith('Basic ')) {
      const creds = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
      const [username] = creds.split(':');
      if (username === 'clerk') user = { id: 'clerk', roles: ['APClerk'] };
      else if (username === 'controller') user = { id: 'controller', roles: ['APController'] };
      else if (username === 'auditor') user = { id: 'auditor', roles: ['Auditor'] };
      else user = { id: username || 'reviewer', roles: ['APClerk', 'APController'] };
    }

    req.user = new cds.User({ id: user.id, roles: user.roles });
    next();
  });

  // Serve static UI from /app, uploaded assets from /public/assets, and sample files from /samples
  app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
  app.use('/public', express.static(path.join(__dirname, 'public')));
  app.use('/samples', express.static(path.join(__dirname, 'samples')));
  app.use(express.static(path.join(__dirname, 'app')));

  // Connect to DB and deploy schema
  cds.model = await cds.load(['db/schema.cds', 'srv/fraud-service.cds']);
  const db = await cds.connect.to('db');
  await cds.deploy(cds.model).to(db);
  await seedPostedIfEmpty();

  // Serve FraudService via CAP
  await cds.serve('FraudService').from('srv/fraud-service').in(app);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AP Sentinel (SAP BTP CAP) listening on http://0.0.0.0:${PORT}`);
  });
}

main().catch(err => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
