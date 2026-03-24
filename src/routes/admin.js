const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const { getUserUsageSummary } = require('../services/billing');

router.use(authenticate);

router.get('/stats', async (req, res) => {
  try {
    const [totalUsers, totalKeys, totalUsage, providerStats] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM users'),
      db.query('SELECT COUNT(*) as count FROM api_keys WHERE revoked = false'),
      db.query(`
        SELECT 
          SUM(tokens_in) as total_tokens_in,
          SUM(tokens_out) as total_tokens_out,
          SUM(cost) as total_cost,
          COUNT(*) as total_requests
        FROM usage_records
        WHERE created_at > NOW() - INTERVAL '30 days'
      `),
      db.query(`
        SELECT 
          provider,
          COUNT(*) as request_count,
          SUM(cost) as total_cost,
          AVG(latency_ms) as avg_latency
        FROM usage_records
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY provider
        ORDER BY request_count DESC
      `)
    ]);

    res.json({
      total_users: parseInt(totalUsers.rows[0]?.count || 0),
      total_keys: parseInt(totalKeys.rows[0]?.count || 0),
      total_tokens_in: parseInt(totalUsage.rows[0]?.total_tokens_in || 0),
      total_tokens_out: parseInt(totalUsage.rows[0]?.total_tokens_out || 0),
      total_cost: parseFloat(totalUsage.rows[0]?.total_cost || 0),
      total_requests: parseInt(totalUsage.rows[0]?.total_requests || 0),
      provider_stats: providerStats.rows
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

router.get('/users', async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  try {
    const [users, total] = await Promise.all([
      db.query(`
        SELECT 
          u.id, u.email, u.name, u.created_at,
          ub.balance, ub.total_spent,
          (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id) as key_count
        FROM users u
        LEFT JOIN user_balances ub ON u.id = ub.user_id
        ORDER BY u.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      db.query('SELECT COUNT(*) as count FROM users')
    ]);

    res.json({
      users: users.rows,
      total: parseInt(total.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

router.get('/users/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const user = await db.query(`
      SELECT 
        u.id, u.email, u.name, u.created_at,
        ub.balance, ub.total_spent
      FROM users u
      LEFT JOIN user_balances ub ON u.id = ub.user_id
      WHERE u.id = $1
    `, [id]);

    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const keys = await db.query(`
      SELECT id, name, scopes, rate_limit, revoked, created_at, last_used_at
      FROM api_keys WHERE user_id = $1
    `, [id]);

    const usage = await getUserUsageSummary(id, null, null);

    res.json({
      user: user.rows[0],
      keys: keys.rows,
      usage: usage.slice(0, 10)
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

router.post('/users/:id/balance', async (req, res) => {
  const { id } = req.params;
  const { amount, action } = req.body;

  if (!amount || !action) {
    return res.status(400).json({ error: 'Amount and action required' });
  }

  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    if (action === 'add') {
      await client.query(`
        UPDATE user_balances 
        SET balance = balance + $1, updated_at = NOW()
        WHERE user_id = $2
      `, [amount, id]);
    } else if (action === 'deduct') {
      await client.query(`
        UPDATE user_balances 
        SET balance = balance - $1, updated_at = NOW()
        WHERE user_id = $2 AND balance >= $1
      `, [amount, id]);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Update balance error:', error);
    res.status(500).json({ error: 'Failed to update balance' });
  } finally {
    client.release();
  }
});

router.get('/models', async (req, res) => {
  try {
    const models = await db.query(`
      SELECT 
        m.id, m.model_name, m.display_name, m.description,
        m.input_price_per_1k_tokens, m.output_price_per_1k_tokens,
        m.context_length, m.modality, m.enabled,
        p.display_name as provider
      FROM models m
      JOIN providers p ON m.provider_id = p.id
      ORDER BY p.priority DESC, m.model_name ASC
    `);

    res.json({ models: models.rows });
  } catch (error) {
    console.error('Get models error:', error);
    res.status(500).json({ error: 'Failed to get models' });
  }
});

router.patch('/models/:id', async (req, res) => {
  const { id } = req.params;
  const { enabled, input_price, output_price } = req.body;

  try {
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (enabled !== undefined) {
      updates.push(`enabled = $${paramCount++}`);
      values.push(enabled);
    }
    if (input_price !== undefined) {
      updates.push(`input_price_per_1k_tokens = $${paramCount++}`);
      values.push(input_price);
    }
    if (output_price !== undefined) {
      updates.push(`output_price_per_1k_tokens = $${paramCount++}`);
      values.push(output_price);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    await db.query(`
      UPDATE models SET ${updates.join(', ')} WHERE id = $${paramCount}
    `, values);

    res.json({ success: true });
  } catch (error) {
    console.error('Update model error:', error);
    res.status(500).json({ error: 'Failed to update model' });
  }
});

router.get('/providers', async (req, res) => {
  try {
    const providers = await db.query(`
      SELECT 
        p.id, p.name, p.display_name, p.base_url, p.enabled, p.priority,
        ph.success_rate, ph.avg_latency_ms, ph.error_count, ph.request_count
      FROM providers p
      LEFT JOIN provider_health ph ON p.id = ph.provider_id
      ORDER BY p.priority DESC
    `);

    res.json({ providers: providers.rows });
  } catch (error) {
    console.error('Get providers error:', error);
    res.status(500).json({ error: 'Failed to get providers' });
  }
});

router.patch('/providers/:id', async (req, res) => {
  const { id } = req.params;
  const { enabled, priority, api_key } = req.body;

  try {
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (enabled !== undefined) {
      updates.push(`enabled = $${paramCount++}`);
      values.push(enabled);
    }
    if (priority !== undefined) {
      updates.push(`priority = $${paramCount++}`);
      values.push(priority);
    }
    if (api_key !== undefined) {
      updates.push(`api_key = $${paramCount++}`);
      values.push(api_key);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    await db.query(`
      UPDATE providers SET ${updates.join(', ')} WHERE id = $${paramCount}
    `, values);

    res.json({ success: true });
  } catch (error) {
    console.error('Update provider error:', error);
    res.status(500).json({ error: 'Failed to update provider' });
  }
});

router.get('/usage', async (req, res) => {
  const { start_date, end_date, user_id, provider, limit = 100 } = req.query;

  try {
    let query = `
      SELECT 
        ur.id, ur.model, ur.provider, ur.tokens_in, ur.tokens_out,
        ur.tokens_total, ur.cost, ur.latency_ms, ur.status_code,
        ur.created_at, u.email
      FROM usage_records ur
      JOIN users u ON ur.user_id = u.id
      WHERE 1=1
    `;
    const values = [];
    let paramCount = 1;

    if (start_date) {
      query += ` AND ur.created_at >= $${paramCount++}`;
      values.push(start_date);
    }
    if (end_date) {
      query += ` AND ur.created_at <= $${paramCount++}`;
      values.push(end_date);
    }
    if (user_id) {
      query += ` AND ur.user_id = $${paramCount++}`;
      values.push(user_id);
    }
    if (provider) {
      query += ` AND ur.provider = $${paramCount++}`;
      values.push(provider);
    }

    query += ` ORDER BY ur.created_at DESC LIMIT $${paramCount++}`;
    values.push(parseInt(limit));

    const result = await db.query(query, values);
    res.json({ usage: result.rows });
  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({ error: 'Failed to get usage' });
  }
});

module.exports = router;
