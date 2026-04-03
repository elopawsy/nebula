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
      service: 'follow-service',
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

// Follow a user
app.post('/follows', async (c) => {
  try {
    const { follower_id, following_id } = await c.req.json();

    if (follower_id === following_id) {
      return c.json({ error: 'Cannot follow yourself' }, 400);
    }

    const client = await pool.connect();

    // Check if already following
    const existing = await client.query(
      'SELECT id FROM follows WHERE follower_id = $1 AND following_id = $2',
      [follower_id, following_id]
    );

    if (existing.rows.length > 0) {
      client.release();
      return c.json({ error: 'Already following' }, 409);
    }

    const result = await client.query(
      `INSERT INTO follows (follower_id, following_id, created_at)
       VALUES ($1, $2, NOW())
       RETURNING id, follower_id, following_id, created_at`,
      [follower_id, following_id]
    );
    client.release();

    // Cache invalidation
    await redis.del(`followers:${following_id}`);
    await redis.del(`following:${follower_id}`);

    return c.json(result.rows[0], 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Unfollow a user
app.delete('/follows', async (c) => {
  try {
    const { follower_id, following_id } = await c.req.json();

    const client = await pool.connect();
    const result = await client.query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING id',
      [follower_id, following_id]
    );
    client.release();

    if (result.rows.length === 0) {
      return c.json({ error: 'Not following' }, 404);
    }

    // Cache invalidation
    await redis.del(`followers:${following_id}`);
    await redis.del(`following:${follower_id}`);

    return c.json({ message: 'Unfollowed successfully' });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Get followers
app.get('/users/:user_id/followers', async (c) => {
  try {
    const user_id = c.req.param('user_id');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    // Check cache
    const cacheKey = `followers:${user_id}:${limit}:${offset}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const client = await pool.connect();
    const result = await client.query(
      `SELECT u.id, u.username, u.avatar_url, f.created_at
       FROM follows f
       JOIN users u ON f.follower_id = u.id
       WHERE f.following_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [user_id, limit, offset]
    );
    client.release();

    const followers = result.rows;

    // Cache for 5 minutes
    await redis.setEx(cacheKey, 300, JSON.stringify(followers));

    return c.json(followers);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Get following
app.get('/users/:user_id/following', async (c) => {
  try {
    const user_id = c.req.param('user_id');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    // Check cache
    const cacheKey = `following:${user_id}:${limit}:${offset}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const client = await pool.connect();
    const result = await client.query(
      `SELECT u.id, u.username, u.avatar_url, f.created_at
       FROM follows f
       JOIN users u ON f.following_id = u.id
       WHERE f.follower_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [user_id, limit, offset]
    );
    client.release();

    const following = result.rows;

    // Cache for 5 minutes
    await redis.setEx(cacheKey, 300, JSON.stringify(following));

    return c.json(following);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Get follow stats
app.get('/users/:user_id/stats', async (c) => {
  try {
    const user_id = c.req.param('user_id');

    // Check cache
    const cacheKey = `follow_stats:${user_id}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const client = await pool.connect();
    const followers = await client.query(
      'SELECT COUNT(*) FROM follows WHERE following_id = $1',
      [user_id]
    );
    const following = await client.query(
      'SELECT COUNT(*) FROM follows WHERE follower_id = $1',
      [user_id]
    );
    client.release();

    const stats = {
      followers_count: parseInt(followers.rows[0].count),
      following_count: parseInt(following.rows[0].count)
    };

    // Cache for 5 minutes
    await redis.setEx(cacheKey, 300, JSON.stringify(stats));

    return c.json(stats);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Check if user A follows user B
app.get('/follows/check', async (c) => {
  try {
    const follower_id = c.req.query('follower_id');
    const following_id = c.req.query('following_id');

    if (!follower_id || !following_id) {
      return c.json({ error: 'Missing parameters' }, 400);
    }

    const client = await pool.connect();
    const result = await client.query(
      'SELECT id FROM follows WHERE follower_id = $1 AND following_id = $2',
      [follower_id, following_id]
    );
    client.release();

    return c.json({ is_following: result.rows.length > 0 });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

const port = parseInt(process.env.PORT || '3000');

console.log(`🚀 Follow Service running on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
