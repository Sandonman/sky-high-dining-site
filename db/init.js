import 'dotenv/config';
import fs from 'fs';
import { Pool } from 'pg';

const sql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

try {
  await pool.query(sql);
  console.log('DB schema initialized successfully.');
} catch (err) {
  console.error('DB init failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
