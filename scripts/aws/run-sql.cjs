#!/usr/bin/env node
// scripts/aws/run-sql.cjs — run ONE .sql file against DATABASE_URL inside a
// single transaction, using the `pg` driver already in node_modules.
//
// Why not psql: the RDS URL carries `uselibpqcompat=true`, which pg v9 needs and
// libpq rejects as an unknown URI parameter, and psql is not installed on the
// instance anyway. Usage (on the instance, as root):
//
//   set -a; . /etc/digilog/digilog.env; set +a
//   /opt/digilog/node/bin/node scripts/aws/run-sql.cjs scripts/aws/<file>.sql
//
// Exit 0 only when the transaction committed. Any error rolls back.
const fs = require('fs');
const path = require('path');
const { Client } = require(path.join(process.cwd(), 'node_modules', 'pg'));

const file = process.argv[2];
if (!file) { console.error('usage: run-sql.cjs <file.sql>'); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(2); }
const sql = fs.readFileSync(file, 'utf8');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(sql);
    await c.query('COMMIT');
    console.log(`COMMITTED ${path.basename(file)}`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error(`ROLLED BACK ${path.basename(file)}: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
})();
