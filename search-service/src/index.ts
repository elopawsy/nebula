import { Hono } from 'hono';
import { Client } from '@elastic/elasticsearch';
import { createClient } from 'redis';

const app = new Hono();

// Elasticsearch connection
const esClient = new Client({
  node: process.env.ES_URL || 'http://elasticsearch:9200'
});

// Redis connection for caching
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379'
});

redis.on('error', (err) => console.error('Redis error:', err));
await redis.connect();

// Health check
app.get('/health', async (c) => {
  try {
    const esHealth = await esClient.ping();
    await redis.ping();

    return c.json({
      status: 'healthy',
      service: 'search-service',
      elasticsearch: 'connected',
      cache: 'connected'
    });
  } catch (error) {
    return c.json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 503);
  }
});

// Index a post for search
app.post('/index/posts', async (c) => {
  try {
    const { id, user_id, username, content, created_at } = await c.req.json();

    await esClient.index({
      index: 'posts',
      id: id.toString(),
      document: {
        user_id,
        username,
        content,
        created_at
      }
    });

    return c.json({ message: 'Post indexed successfully' }, 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Index a user for search
app.post('/index/users', async (c) => {
  try {
    const { id, username, bio, avatar_url } = await c.req.json();

    await esClient.index({
      index: 'users',
      id: id.toString(),
      document: {
        username,
        bio,
        avatar_url
      }
    });

    return c.json({ message: 'User indexed successfully' }, 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Search posts
app.get('/search/posts', async (c) => {
  try {
    const query = c.req.query('q');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');

    if (!query) {
      return c.json({ error: 'Query parameter required' }, 400);
    }

    // Check cache
    const cacheKey = `search_posts:${query}:${limit}:${offset}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const result = await esClient.search({
      index: 'posts',
      from: offset,
      size: limit,
      query: {
        multi_match: {
          query,
          fields: ['content^2', 'username'],
          fuzziness: 'AUTO'
        }
      },
      sort: [
        { _score: 'desc' },
        { created_at: 'desc' }
      ]
    });

    const posts = result.hits.hits.map((hit: any) => ({
      id: hit._id,
      score: hit._score,
      ...hit._source
    }));

    const response = {
      total: result.hits.total,
      posts
    };

    // Cache for 2 minutes
    await redis.setEx(cacheKey, 120, JSON.stringify(response));

    return c.json(response);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Search users
app.get('/search/users', async (c) => {
  try {
    const query = c.req.query('q');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');

    if (!query) {
      return c.json({ error: 'Query parameter required' }, 400);
    }

    // Check cache
    const cacheKey = `search_users:${query}:${limit}:${offset}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const result = await esClient.search({
      index: 'users',
      from: offset,
      size: limit,
      query: {
        multi_match: {
          query,
          fields: ['username^3', 'bio'],
          fuzziness: 'AUTO'
        }
      },
      sort: [
        { _score: 'desc' }
      ]
    });

    const users = result.hits.hits.map((hit: any) => ({
      id: hit._id,
      score: hit._score,
      ...hit._source
    }));

    const response = {
      total: result.hits.total,
      users
    };

    // Cache for 2 minutes
    await redis.setEx(cacheKey, 120, JSON.stringify(response));

    return c.json(response);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Search both posts and users
app.get('/search', async (c) => {
  try {
    const query = c.req.query('q');
    const limit = parseInt(c.req.query('limit') || '10');

    if (!query) {
      return c.json({ error: 'Query parameter required' }, 400);
    }

    // Check cache
    const cacheKey = `search_all:${query}:${limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    // Search posts and users in parallel
    const [postsResult, usersResult] = await Promise.all([
      esClient.search({
        index: 'posts',
        size: limit,
        query: {
          multi_match: {
            query,
            fields: ['content^2', 'username'],
            fuzziness: 'AUTO'
          }
        }
      }),
      esClient.search({
        index: 'users',
        size: limit,
        query: {
          multi_match: {
            query,
            fields: ['username^3', 'bio'],
            fuzziness: 'AUTO'
          }
        }
      })
    ]);

    const response = {
      posts: postsResult.hits.hits.map((hit: any) => ({
        id: hit._id,
        score: hit._score,
        ...hit._source
      })),
      users: usersResult.hits.hits.map((hit: any) => ({
        id: hit._id,
        score: hit._score,
        ...hit._source
      }))
    };

    // Cache for 2 minutes
    await redis.setEx(cacheKey, 120, JSON.stringify(response));

    return c.json(response);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Delete from index
app.delete('/index/:type/:id', async (c) => {
  try {
    const type = c.req.param('type'); // 'posts' or 'users'
    const id = c.req.param('id');

    if (type !== 'posts' && type !== 'users') {
      return c.json({ error: 'Invalid type' }, 400);
    }

    await esClient.delete({
      index: type,
      id
    });

    // Invalidate related cache
    await redis.del(`search_${type}:*`);

    return c.json({ message: 'Document deleted from index' });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

const port = parseInt(process.env.PORT || '3000');

console.log(`🚀 Search Service running on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
