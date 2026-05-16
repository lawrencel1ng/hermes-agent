import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const res = await pool.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema='public' 
    AND (table_name LIKE '%call%' OR table_name LIKE '%voice%' OR table_name LIKE '%interaction%' OR table_name LIKE '%agent%' OR table_name LIKE '%case%')
    ORDER BY table_name
  `);
  console.log('Relevant tables:');
  console.log(res.rows.map(r => r.table_name).join('\n'));
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
