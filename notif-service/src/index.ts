import { Hono } from 'hono';
import pkg from 'pg';
import { createClient } from 'redis';
const { Pool } = pkg;

const app = new Hono();

// PostgreSQL connection
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

// Redis connection for pub/sub
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379'
});

redis.on('error', (err) => console.error('Redis error:', err));
await redis.connect();

// Health check
app.get('/health', async (c) => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();

    await redis.ping();

    return c.json({
      status: 'healthy',
      service: 'notif-service',
      database: 'connected',
      cache: 'connected'
    });
  } catch (error) {
    return c.json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 503);
  }
});

// Create notification
app.post('/notifications', async (c) => {
  try {
    const { user_id, type, content, related_id } = await c.req.json();

    const client = await pool.connect();
    const result = await client.query(
      `INSERT INTO notifications (user_id, type, content, related_id, created_at, read)
       VALUES ($1, $2, $3, $4, NOW(), false)
       RETURNING *`,
      [user_id, type, content, related_id]
    );
    client.release();

    const notification = result.rows[0];

    // Publish to Redis pub/sub for real-time notifications
    await redis.publish(`notifications:${user_id}`, JSON.stringify(notification));

    // Increment unread count in cache
    await redis.incr(`unread_notifs:${user_id}`);

    return c.json(notification, 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Get user notifications
app.get('/notifications/:user_id', async (c) => {
  try {
    const user_id = c.req.param('user_id');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');
    const unread_only = c.req.query('unread_only') === 'true';

    const client = await pool.connect();

    let query = `SELECT * FROM notifications WHERE user_id = $1`;
    const params: any[] = [user_id];

    if (unread_only) {
      query += ` AND read = false`;
    }

    query += ` ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
    params.push(limit, offset);

    const result = await client.query(query, params);
    client.release();

    return c.json(result.rows);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Mark notification as read
app.patch('/notifications/:id/read', async (c) => {
  try {
    const id = c.req.param('id');

    const client = await pool.connect();
    const result = await client.query(
      `UPDATE notifications
       SET read = true
       WHERE id = $1
       RETURNING user_id`,
      [id]
    );
    client.release();

    if (result.rows.length === 0) {
      return c.json({ error: 'Notification not found' }, 404);
    }

    // Decrement unread count
    const user_id = result.rows[0].user_id;
    await redis.decr(`unread_notifs:${user_id}`);

    return c.json({ message: 'Marked as read' });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Mark all notifications as read
app.post('/notifications/:user_id/read-all', async (c) => {
  try {
    const user_id = c.req.param('user_id');

    const client = await pool.connect();
    await client.query(
      `UPDATE notifications
       SET read = true
       WHERE user_id = $1 AND read = false`,
      [user_id]
    );
    client.release();

    // Reset unread count
    await redis.set(`unread_notifs:${user_id}`, 0);

    return c.json({ message: 'All notifications marked as read' });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Get unread count
app.get('/notifications/:user_id/unread-count', async (c) => {
  try {
    const user_id = c.req.param('user_id');

    // Try cache first
    let count = await redis.get(`unread_notifs:${user_id}`);

    if (count === null) {
      // Cache miss - query database
      const client = await pool.connect();
      const result = await client.query(
        'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = false',
        [user_id]
      );
      client.release();

      count = result.rows[0].count;
      await redis.set(`unread_notifs:${user_id}`, count);
    }

    return c.json({ count: parseInt(count as string) });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Delete notification
app.delete('/notifications/:id', async (c) => {
  try {
    const id = c.req.param('id');

    const client = await pool.connect();
    const result = await client.query(
      'DELETE FROM notifications WHERE id = $1 RETURNING user_id, read',
      [id]
    );
    client.release();

    if (result.rows.length === 0) {
      return c.json({ error: 'Notification not found' }, 404);
    }

    // Update unread count if notification was unread
    if (!result.rows[0].read) {
      await redis.decr(`unread_notifs:${result.rows[0].user_id}`);
    }

    return c.json({ message: 'Notification deleted' });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

const port = parseInt(process.env.PORT || '3000');

console.log(`🚀 Notification Service running on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
