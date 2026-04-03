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

// Simple content moderation filter (can be replaced with AI-based solution)
const BANNED_WORDS = [
  'spam', 'scam', 'offensive_word_1', 'offensive_word_2'
  // Add more banned words
];

const containsBannedContent = (text: string): boolean => {
  const lowerText = text.toLowerCase();
  return BANNED_WORDS.some(word => lowerText.includes(word));
};

// Health check
app.get('/health', async (c) => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();

    await redis.ping();

    return c.json({
      status: 'healthy',
      service: 'moderation-service',
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

// Check content for moderation
app.post('/moderate/content', async (c) => {
  try {
    const { content } = await c.req.json();

    if (!content) {
      return c.json({ error: 'Content is required' }, 400);
    }

    const flagged = containsBannedContent(content);

    return c.json({
      flagged,
      action: flagged ? 'block' : 'allow',
      reason: flagged ? 'Contains banned content' : null
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Report a post
app.post('/reports', async (c) => {
  try {
    const { reporter_id, post_id, reason, description } = await c.req.json();

    const client = await pool.connect();
    const result = await client.query(
      `INSERT INTO reports (reporter_id, post_id, reason, description, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())
       RETURNING *`,
      [reporter_id, post_id, reason, description]
    );
    client.release();

    return c.json(result.rows[0], 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Get pending reports (for moderators)
app.get('/reports/pending', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');

    const client = await pool.connect();
    const result = await client.query(
      `SELECT r.*, p.content as post_content, u.username as reporter_username
       FROM reports r
       LEFT JOIN posts p ON r.post_id = p.id
       LEFT JOIN users u ON r.reporter_id = u.id
       WHERE r.status = 'pending'
       ORDER BY r.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    client.release();

    return c.json(result.rows);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Update report status
app.patch('/reports/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const { status, moderator_notes } = await c.req.json();

    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return c.json({ error: 'Invalid status' }, 400);
    }

    const client = await pool.connect();
    const result = await client.query(
      `UPDATE reports
       SET status = $1, moderator_notes = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [status, moderator_notes, id]
    );
    client.release();

    if (result.rows.length === 0) {
      return c.json({ error: 'Report not found' }, 404);
    }

    // If approved, take action on the post
    if (status === 'approved') {
      const report = result.rows[0];
      // Here you would call the posts-service to delete/hide the post
      // For now, just log it
      console.log(`Post ${report.post_id} flagged for removal`);
    }

    return c.json(result.rows[0]);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Block user
app.post('/blocks', async (c) => {
  try {
    const { blocker_id, blocked_id, reason } = await c.req.json();

    if (blocker_id === blocked_id) {
      return c.json({ error: 'Cannot block yourself' }, 400);
    }

    const client = await pool.connect();

    // Check if already blocked
    const existing = await client.query(
      'SELECT id FROM blocks WHERE blocker_id = $1 AND blocked_id = $2',
      [blocker_id, blocked_id]
    );

    if (existing.rows.length > 0) {
      client.release();
      return c.json({ error: 'Already blocked' }, 409);
    }

    const result = await client.query(
      `INSERT INTO blocks (blocker_id, blocked_id, reason, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING *`,
      [blocker_id, blocked_id, reason]
    );
    client.release();

    // Cache the block for fast lookups
    await redis.sAdd(`blocks:${blocker_id}`, blocked_id.toString());

    return c.json(result.rows[0], 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Unblock user
app.delete('/blocks', async (c) => {
  try {
    const { blocker_id, blocked_id } = await c.req.json();

    const client = await pool.connect();
    const result = await client.query(
      'DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2 RETURNING id',
      [blocker_id, blocked_id]
    );
    client.release();

    if (result.rows.length === 0) {
      return c.json({ error: 'Not blocked' }, 404);
    }

    // Remove from cache
    await redis.sRem(`blocks:${blocker_id}`, blocked_id.toString());

    return c.json({ message: 'Unblocked successfully' });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Check if user is blocked
app.get('/blocks/check', async (c) => {
  try {
    const blocker_id = c.req.query('blocker_id');
    const blocked_id = c.req.query('blocked_id');

    if (!blocker_id || !blocked_id) {
      return c.json({ error: 'Missing parameters' }, 400);
    }

    // Check cache first
    const cached = await redis.sIsMember(`blocks:${blocker_id}`, blocked_id);

    if (cached) {
      return c.json({ is_blocked: true });
    }

    // Check database
    const client = await pool.connect();
    const result = await client.query(
      'SELECT id FROM blocks WHERE blocker_id = $1 AND blocked_id = $2',
      [blocker_id, blocked_id]
    );
    client.release();

    const is_blocked = result.rows.length > 0;

    // Update cache if found
    if (is_blocked) {
      await redis.sAdd(`blocks:${blocker_id}`, blocked_id);
    }

    return c.json({ is_blocked });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Get blocked users
app.get('/users/:user_id/blocks', async (c) => {
  try {
    const user_id = c.req.param('user_id');

    const client = await pool.connect();
    const result = await client.query(
      `SELECT u.id, u.username, u.avatar_url, b.created_at, b.reason
       FROM blocks b
       JOIN users u ON b.blocked_id = u.id
       WHERE b.blocker_id = $1
       ORDER BY b.created_at DESC`,
      [user_id]
    );
    client.release();

    return c.json(result.rows);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

const port = parseInt(process.env.PORT || '3000');

console.log(`🚀 Moderation Service running on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
