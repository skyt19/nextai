import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const { Client } = pg;

const sqliteDb = new DatabaseSync('prisma/dev.db');

const pgClient = new Client({
  host: 'aws-0-ap-northeast-1.pooler.supabase.com',
  port: 5432,
  database: 'postgres',
  user: 'postgres.rotkeqiskjwzechfporj',
  password: '0926671327df',
  ssl: { rejectUnauthorized: false }
});

const DATE_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'approved_at',
  'submitted_at',
  'assigned_at',
  'retrieved_at',
  'closed_at',
  'auto_delete_at',
  'deleted_at',
  'delivered_at',
  'allocated_at',
  'topup_date'
]);

const BOOLEAN_COLUMNS = new Set([
  'enabled',
  'is_stale'
]);

function formatValue(key, val) {
  if (val === null || val === undefined) {
    return null;
  }
  if (DATE_COLUMNS.has(key)) {
    if (typeof val === 'number' || (!isNaN(val) && !isNaN(parseFloat(val)))) {
      return new Date(Number(val)).toISOString();
    }
    return new Date(val).toISOString();
  }
  if (BOOLEAN_COLUMNS.has(key)) {
    return val === 1 || val === true || val === '1';
  }
  return val;
}

const TABLES_IN_ORDER = [
  'packages',
  'customers',
  'model_catalog',
  'customer_model_groups',
  'exchange_rate_snapshots',
  'upstream_credentials',
  'admin_users',
  'audit_logs',
  'tickets',
  'payments',
  'payment_slips',
  'bearlab_topup_records',
  'funding_allocations',
  'customer_token_records'
];

async function migrate() {
  console.log('Connecting to Supabase PostgreSQL...');
  await pgClient.connect();
  console.log('Connected!');

  for (const table of TABLES_IN_ORDER) {
    const rows = sqliteDb.prepare(`SELECT * FROM "${table}"`).all();
    console.log(`\nMigrating table "${table}" (${rows.length} rows)...`);

    if (rows.length === 0) continue;

    for (const row of rows) {
      const keys = Object.keys(row);
      const values = keys.map(k => formatValue(k, row[k]));

      const cols = keys.map(k => `"${k}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

      const query = `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING;`;

      try {
        await pgClient.query(query, values);
      } catch (err) {
        console.error(`Error inserting into ${table}:`, err.message);
      }
    }
    const countRes = await pgClient.query(`SELECT count(*) FROM "${table}"`);
    console.log(`Table "${table}" in Supabase now has: ${countRes.rows[0].count} rows.`);
  }

  console.log('\n========================================');
  console.log(' ALL NEXTAI DATA MIGRATED TO SUPABASE! ');
  console.log('========================================');

  await pgClient.end();
  sqliteDb.close();
}

migrate().catch(console.error);
