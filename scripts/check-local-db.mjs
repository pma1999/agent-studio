#!/usr/bin/env node
/**
 * Quick check of local agent-studio.db: users, agents per user, conversations, settings.
 * Usage: node scripts/check-local-db.mjs
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dbPath = process.env.DATABASE_PATH || path.join(root, 'agent-studio.db');

console.log('DB path:', dbPath);

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (e) {
  console.error('Cannot open DB:', e.message);
  process.exit(1);
}

// Users
const users = db.prepare('SELECT id, email, created_at FROM users ORDER BY email').all();
console.log('\n--- Users ---');
console.log(users.length, 'user(s)');
users.forEach((u) => console.log('  ', u.email, '| id:', u.id));

// Agents per user
const agentCounts = db.prepare(`
  SELECT u.email, COUNT(a.id) as count
  FROM users u
  LEFT JOIN agents a ON a.user_id = u.id
  GROUP BY u.id
  ORDER BY u.email
`).all();
console.log('\n--- Agents per user ---');
agentCounts.forEach((r) => console.log('  ', r.email, ':', r.count, 'agent(s)'));

// Agent names (first 20)
const agentList = db.prepare(`
  SELECT a.id, a.name, a.emoji, u.email as user_email
  FROM agents a
  LEFT JOIN users u ON u.id = a.user_id
  ORDER BY a.created_at DESC
  LIMIT 20
`).all();
console.log('\n--- Agents (up to 20) ---');
agentList.forEach((a) => console.log('  ', a.emoji || '🤖', a.name, '|', a.user_email || '(no user)'));

// Conversations per user
const convCounts = db.prepare(`
  SELECT u.email, COUNT(c.id) as count
  FROM users u
  LEFT JOIN conversations c ON c.user_id = u.id
  GROUP BY u.id
`).all();
console.log('\n--- Conversations per user ---');
convCounts.forEach((r) => console.log('  ', r.email, ':', r.count));

// Settings keys per user
const settingsCounts = db.prepare(`
  SELECT u.email, COUNT(s.key) as count
  FROM users u
  LEFT JOIN settings s ON s.user_id = u.id
  GROUP BY u.id
`).all();
console.log('\n--- Settings entries per user ---');
settingsCounts.forEach((r) => console.log('  ', r.email, ':', r.count));

db.close();
console.log('\nDone.');
