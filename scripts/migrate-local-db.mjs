#!/usr/bin/env node
/**
 * Run migrations on the local database so it's ready to push to Railway.
 * Ensures admin user exists and all agents/conversations/settings are assigned to them.
 *
 * Usage:
 *   npm run build:server   # first time: build so dist/server exists
 *   node scripts/migrate-local-db.mjs
 *
 * Optional: DATABASE_PATH=./path/to/agent-studio.db node scripts/migrate-local-db.mjs
 */

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

if (!process.env.DATABASE_PATH) {
  const defaultPath = path.join(root, 'agent-studio.db');
  process.env.DATABASE_PATH = defaultPath;
  console.log('[migrate-local-db] Using DB:', defaultPath);
} else {
  console.log('[migrate-local-db] Using DB:', process.env.DATABASE_PATH);
}

const distDb = path.join(root, 'dist', 'server', 'db.js');
const { migrate } = await import(pathToFileURL(distDb).href);
migrate();
console.log('[migrate-local-db] Done. You can now push this DB to Railway with:');
console.log('  cmd /c "type agent-studio.db | npx @railway/cli run npm run db:restore"');
process.exit(0);
