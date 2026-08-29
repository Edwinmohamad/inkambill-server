const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'inkamnet',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inkamnet',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+07:00',
  decimalNumbers: true
});

module.exports = pool;
