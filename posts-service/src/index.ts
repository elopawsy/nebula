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
      service: 'posts-service',
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

// Create post
app.post('/posts', async (c) => {
  try {
    const { user_id, content, media_urls } = await c.req.json();

    const client = await pool.connect();
    const result = await client.query(
      `INSERT INTO posts (user_id, content, media_urls, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, user_id, content, media_urls, created_at`,
      [user_id, content, media_urls || []]
    );
    client.release();

    const post = result.rows[0];

    // Cache invalidation
    await redis.del(`user_posts:${user_id}`);

    return c.json(post, 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Get post by ID
app.get('/posts/:id', async (c) => {
  try {
    const id = c.req.param('id');

    // Check cache
    const cached = await redis.get(`post:${id}`);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const client = await pool.connect();
    const result = await client.query(
      'SELECT * FROM posts WHERE id = $1',
      [id]
    );
    client.release();

    if (result.rows.length === 0) {
      return c.json({ error: 'Post not found' }, 404);
    }

    const post = result.rows[0];

    // Cache for 5 minutes
    await redis.setEx(`post:${id}`, 300, JSON.stringify(post));

    return c.json(post);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Get user posts
app.get('/users/:user_id/posts', async (c) => {
  try {
    const user_id = c.req.param('user_id');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');

    // Check cache
    const cacheKey = `user_posts:${user_id}:${limit}:${offset}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const client = await pool.connect();
    const result = await client.query(
      `SELECT * FROM posts
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [user_id, limit, offset]
    );
    client.release();

    const posts = result.rows;

    // Cache for 2 minutes
    await redis.setEx(cacheKey, 120, JSON.stringify(posts));

    return c.json(posts);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Delete post
app.delete('/posts/:id', async (c) => {
  try {
    const id = c.req.param('id');

    const client = await pool.connect();
    const result = await client.query(
      'DELETE FROM posts WHERE id = $1 RETURNING user_id',
      [id]
    );
    client.release();

    if (result.rows.length === 0) {
      return c.json({ error: 'Post not found' }, 404);
    }

    // Cache invalidation
    await redis.del(`post:${id}`);
    await redis.del(`user_posts:${result.rows[0].user_id}`);

    return c.json({ message: 'Post deleted' });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

const port = parseInt(process.env.PORT || '3000');

console.log(`🚀 Posts Service running on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
