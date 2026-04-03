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

// Redis connection
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
      service: 'timeline-service',
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

// Get user timeline (posts from followed users)
app.get('/timeline/:user_id', async (c) => {
  try {
    const user_id = c.req.param('user_id');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');

    // Check cache
    const cacheKey = `timeline:${user_id}:${limit}:${offset}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const client = await pool.connect();
    const result = await client.query(
      `SELECT p.*, u.username, u.avatar_url
       FROM posts p
       JOIN follows f ON p.user_id = f.following_id
       LEFT JOIN users u ON p.user_id = u.id
       WHERE f.follower_id = $1
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [user_id, limit, offset]
    );
    client.release();

    const timeline = result.rows;

    // Cache for 1 minute
    await redis.setEx(cacheKey, 60, JSON.stringify(timeline));

    return c.json(timeline);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Get home feed (timeline + own posts)
app.get('/feed/:user_id', async (c) => {
  try {
    const user_id = c.req.param('user_id');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');

    // Check cache
    const cacheKey = `feed:${user_id}:${limit}:${offset}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const client = await pool.connect();
    const result = await client.query(
      `SELECT p.*, u.username, u.avatar_url
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.user_id = $1
          OR p.user_id IN (
            SELECT following_id FROM follows WHERE follower_id = $1
          )
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [user_id, limit, offset]
    );
    client.release();

    const feed = result.rows;

    // Cache for 1 minute
    await redis.setEx(cacheKey, 60, JSON.stringify(feed));

    return c.json(feed);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Invalidate timeline cache (called when new post is created)
app.post('/invalidate/:user_id', async (c) => {
  try {
    const user_id = c.req.param('user_id');

    // Get all followers
    const client = await pool.connect();
    const result = await client.query(
      'SELECT follower_id FROM follows WHERE following_id = $1',
      [user_id]
    );
    client.release();

    // Invalidate cache for all followers
    const promises = result.rows.map(row =>
      redis.del(`timeline:${row.follower_id}:*`)
    );
    await Promise.all(promises);

    // Also invalidate user's own feed
    await redis.del(`feed:${user_id}:*`);

    return c.json({ message: 'Cache invalidated' });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

const port = parseInt(process.env.PORT || '3000');

console.log(`🚀 Timeline Service running on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
