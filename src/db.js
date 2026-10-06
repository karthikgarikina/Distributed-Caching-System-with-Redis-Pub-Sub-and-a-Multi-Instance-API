const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://user:password@db:5432/products_db'
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle postgres client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
