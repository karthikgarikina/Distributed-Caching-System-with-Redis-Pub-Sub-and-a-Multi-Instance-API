require('dotenv').config();
const express = require('express');
const db = require('./db');
const cache = require('./cache');

const app = express();
const port = process.env.APP_PORT || 8081;
const instanceId = process.env.INSTANCE_ID || 'instance-1';

app.use(express.json());

// Helper to format product
function formatProduct(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: Number(row.price).toFixed(2),
    stock: row.stock
  };
}

// Health check endpoint for Docker Compose
app.get('/health', async (req, res) => {
  try {
    // Verify DB connectivity
    await db.query('SELECT 1');
    res.status(200).json({ status: 'ok', instanceId });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Instance ID endpoint
app.get('/api/instance/id', (req, res) => {
  res.status(200).send(instanceId);
});

// Cache Stats endpoint
app.get('/api/cache/stats', (req, res) => {
  res.status(200).json(cache.getStats());
});

// Manual Cache Invalidation endpoint
app.post('/api/cache/invalidate', async (req, res) => {
  try {
    const { key, pattern } = req.body;
    if (key) {
      await cache.invalidateKey(key);
      return res.status(200).json({ status: 'ok', invalidated: key });
    }
    if (pattern) {
      await cache.invalidatePattern(pattern);
      return res.status(200).json({ status: 'ok', invalidated: pattern });
    }
    return res.status(400).json({ error: 'Provide key or pattern to invalidate' });
  } catch (err) {
    console.error('Error during manual cache invalidation:', err);
    res.status(500).json({ error: 'Failed to invalidate cache' });
  }
});

// Clear all caches endpoint
app.delete('/api/cache/clear', async (req, res) => {
  try {
    await cache.clearAll();
    res.status(200).json({ status: 'ok', message: 'All caches cleared' });
  } catch (err) {
    console.error('Error during cache clear:', err);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// GET /api/products/:id - Two-level cache-aside read
app.get('/api/products/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }

  const cacheKey = `product:${id}`;

  try {
    const result = await cache.getOrSet(cacheKey, async () => {
      const dbRes = await db.query('SELECT * FROM products WHERE id = $1', [id]);
      if (dbRes.rows.length === 0) {
        return null;
      }
      return formatProduct(dbRes.rows[0]);
    });

    if (!result || !result.data) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.set('X-Cache', result.cacheStatus);
    return res.status(200).json(result.data);
  } catch (err) {
    console.error(`Error fetching product ${id}:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products - Paginated list read with caching
app.get('/api/products', async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const offset = (page - 1) * limit;

  const cacheKey = `products:page:${page}`;

  try {
    const result = await cache.getOrSet(cacheKey, async () => {
      const dbRes = await db.query(
        'SELECT * FROM products ORDER BY id ASC LIMIT $1 OFFSET $2',
        [limit, offset]
      );
      return dbRes.rows.map(formatProduct);
    });

    res.set('X-Cache', result.cacheStatus);
    return res.status(200).json(result.data);
  } catch (err) {
    console.error('Error fetching products list:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/products - Create product and invalidate paginated list cache
app.post('/api/products', async (req, res) => {
  const { name, description, price, stock } = req.body;

  if (!name || price === undefined || stock === undefined) {
    return res.status(400).json({ error: 'name, price, and stock are required' });
  }

  try {
    const dbRes = await db.query(
      'INSERT INTO products (name, description, price, stock) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, description || null, parseFloat(price), parseInt(stock, 10)]
    );

    const newProduct = formatProduct(dbRes.rows[0]);

    // Invalidate paginated list cache
    await cache.invalidatePattern('products:page:*');

    return res.status(201).json(newProduct);
  } catch (err) {
    console.error('Error creating product:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/products/:id - Update product and invalidate cache
app.put('/api/products/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }

  const { name, description, price, stock } = req.body;

  try {
    const dbRes = await db.query(
      `UPDATE products
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           price = COALESCE($3, price),
           stock = COALESCE($4, stock)
       WHERE id = $5
       RETURNING *`,
      [
        name !== undefined ? name : null,
        description !== undefined ? description : null,
        price !== undefined ? parseFloat(price) : null,
        stock !== undefined ? parseInt(stock, 10) : null,
        id
      ]
    );

    if (dbRes.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const updatedProduct = formatProduct(dbRes.rows[0]);

    // Invalidate key across all instances
    await cache.invalidateKey(`product:${id}`);

    return res.status(200).json(updatedProduct);
  } catch (err) {
    console.error(`Error updating product ${id}:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/products/:id - Delete product and invalidate cache
app.delete('/api/products/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }

  try {
    const dbRes = await db.query('DELETE FROM products WHERE id = $1 RETURNING *', [id]);
    if (dbRes.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    await cache.invalidateKey(`product:${id}`);
    await cache.invalidatePattern('products:page:*');

    return res.status(200).json({ status: 'ok', message: 'Product deleted' });
  } catch (err) {
    console.error(`Error deleting product ${id}:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`[${instanceId}] Server listening on port ${port}`);
});
