const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'agent-studio.db');
const db = new Database(dbPath);

const localRow = db.prepare("SELECT id FROM users WHERE email = 'local@localhost'").get();
const adminEmail = (process.argv[2] || process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
if (!adminEmail) {
  console.error('Usage: node scripts/reassign-to-local.cjs <admin-email>  (or set INITIAL_ADMIN_EMAIL)');
  process.exit(1);
}
const adminRow = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);

if (!localRow || !adminRow) {
  console.error('Users not found');
  process.exit(1);
}

const localId = localRow.id;
const adminId = adminRow.id;

db.prepare('UPDATE agents SET user_id = ? WHERE user_id = ?').run(localId, adminId);
db.prepare('UPDATE conversations SET user_id = ? WHERE user_id = ?').run(localId, adminId);
db.prepare('UPDATE settings SET user_id = ? WHERE user_id = ?').run(localId, adminId);
db.prepare('UPDATE tools SET user_id = ? WHERE user_id = ?').run(localId, adminId);
db.prepare('UPDATE mcp_servers SET user_id = ? WHERE user_id = ?').run(localId, adminId);

const agentsCount = db.prepare('SELECT COUNT(*) as c FROM agents WHERE user_id = ?').get(localId).c;
console.log('Done. Reassigned all data from admin to local@localhost.');
console.log('Agents now for local user:', agentsCount);

db.close();
