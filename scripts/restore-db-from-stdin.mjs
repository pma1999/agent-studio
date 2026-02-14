#!/usr/bin/env node
/**
 * Restore SQLite DB from stdin into DATABASE_PATH (e.g. on Railway volume).
 * Run from your machine with Railway CLI, piping your local DB file:
 *
 *   cat agent-studio.db | railway run node scripts/restore-db-from-stdin.mjs
 *
 * Or: cat agent-studio.db | railway run npm run db:restore
 *
 * Requires: Volume mounted at /data (or same path as DATABASE_PATH) and DATABASE_PATH set in Railway.
 */

import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DATABASE_PATH || '/data/agent-studio.db';

async function main() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  fs.writeFileSync(DB_PATH, buf);
  console.error(`Restored ${buf.length} bytes to ${DB_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
