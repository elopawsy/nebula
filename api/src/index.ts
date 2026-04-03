import { Hono } from 'hono';
import pkg from 'pg';
const { Pool } = pkg;

const app = new Hono();

// Configuration de la connexion PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres-primary',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'nebula',
  user: process.env.DB_USER || 'nebula',
  password: process.env.DB_PASSWORD || 'nebula_pass',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Route de santé
app.get('/health', async (c) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();

    return c.json({
      status: 'healthy',
      database: 'connected',
      timestamp: result.rows[0].now
    });
  } catch (error) {
    console.error('Database connection error:', error);
    return c.json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 503);
  }
});

// Route de test simple
app.get('/', (c) => {
  return c.json({ message: 'Nebula API - Hono + PostgreSQL' });
});

// Exemple de route avec requête DB
app.get('/test-query', async (c) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT version()');
    client.release();

    return c.json({
      postgres_version: result.rows[0].version
    });
  } catch (error) {
    console.error('Query error:', error);
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

const port = parseInt(process.env.PORT || '3000');

console.log(`🚀 Server is running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
