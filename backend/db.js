const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured');
}

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  close,
};